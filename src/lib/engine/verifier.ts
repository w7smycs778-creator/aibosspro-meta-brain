// Deterministic fact check run before any model reply or tool call is
// accepted. Pure functions, no model. It matches strings and numbers in the
// reply against the approved brain's structured fields, the latest
// availability result, and the conversation's bookings.
import type { ToolCallRequest } from "../gateway/types";
import type { Booking, BusinessBrain, Turn, Weekday } from "../storage/types";
import { discountedCents, ruleHoldsOn, rulesFor } from "./discounts";
import type { AvailabilityResult } from "./tools";

export type Rule =
  | "price"
  | "service_price"
  | "discount"
  | "discount_condition"
  | "duration"
  | "time"
  | "booking_claim"
  | "booking_slot"
  | "protocol_leak"
  | "offer"
  | "length";

/**
 * A customer reply must not promise a lookup instead of doing it, or talk
 * about the tool protocol. Seen live 2026-10-29: "I'll check our Thursday
 * availability for you." and a reply quoting the step schema.
 */
const LEAK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:I'?ll|I will|let me|I'?m going to|I am going to)\s+(?:check|look up|look into|find out|verify|get back)\b/i, "promises a lookup instead of calling the tool"],
  [/\btool[ _]?calls?\b|\bschema\b|\bjson\b|\bformat requires\b|\bdeveloper\b/i, "talks about the tool protocol"],
  [/"type"\s*:|\{\s*"/, "contains a JSON fragment"],
];

/**
 * One check. An inconclusive check (a known price with no unambiguous service)
 * does not block; it is recorded for owner review when nothing else fails.
 */
export type Check = { rule: Rule; claim: string; pass: boolean; detail?: string; inconclusive?: boolean };
export type Verdict = { pass: boolean; checks: Check[] };

export type Facts = {
  brain: BusinessBrain;
  /** Latest successful check_availability result in this conversation. */
  availability: AvailabilityResult | null;
  /** Bookings for this conversation. */
  bookings: Booking[];
};

/** The latest check_availability output recorded in turns, or null. */
export function latestAvailability(turns: Turn[]): AvailabilityResult | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const cp = turns[i].checkpoint;
    if (cp?.kind !== "tool_result") continue;
    const call = cp.toolCall as ToolCallRequest | undefined;
    const result = cp.result as { ok: boolean; output?: unknown } | undefined;
    if (call?.name === "check_availability" && result?.ok) return result.output as AvailabilityResult;
  }
  return null;
}

/** "$35", "₪120", "35 USD", "120 ₪", "120 NIS", "120 shekels". */
const PRICE_RE = /([$₪€£])\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(?:USD|dollars?|ILS|NIS|shekels?|₪|€|£)(?![\p{L}\d])/giu;

/** Max gap between a service name and the price bound to it. */
const BIND_WINDOW = 60;
/** Context searched around a booking claim for negation or condition words. */
const CLAIM_WINDOW = 40;
const NEGATION_BEFORE = /\b(not|no|nothing|never|until|once|when|after|before|pending|awaiting|yet)\b|n't\b/i;
const CONDITION_AFTER = /^\W*\b(until|once|after|when|by the owner|pending|yet)\b/i;

function escape(re: string): string {
  return re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toCents(raw: string): number {
  return Math.round(Number(raw.replace(",", ".")) * 100);
}

/** Every price a customer may be quoted for each service: list price and discounted prices. */
function pricesByService(brain: BusinessBrain): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const s of brain.services) out.set(s.id, new Set([s.priceCents]));
  for (const d of brain.discounts) {
    const targets = d.serviceIds.length ? brain.services.filter((x) => d.serviceIds.includes(x.id)) : brain.services;
    for (const s of targets) {
      if (d.percentOff !== null) out.get(s.id)!.add(Math.round((s.priceCents * (100 - d.percentOff)) / 100));
      if (d.amountOffCents !== null) out.get(s.id)!.add(Math.max(0, s.priceCents - d.amountOffCents));
    }
  }
  return out;
}

const DAY_NAMES: Record<string, Weekday> = {
  monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu", friday: "fri", saturday: "sat", sunday: "sun",
  Mon: "mon", Tue: "tue", Tues: "tue", Wed: "wed", Thu: "thu", Thur: "thu", Thurs: "thu", Fri: "fri", Sat: "sat", Sun: "sun",
};
/** Full day names in any case (and plural); short names only capitalised, so "sat down" is not Saturday. */
const DAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b|\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b/gi;

function dayMentions(text: string): Array<{ day: Weekday; index: number }> {
  const out: Array<{ day: Weekday; index: number }> = [];
  for (const m of text.matchAll(DAY_RE)) {
    if (m[1]) out.push({ day: DAY_NAMES[m[1].toLowerCase()], index: m.index! });
    else if (/^[A-Z]/.test(m[2])) out.push({ day: DAY_NAMES[m[2]], index: m.index! });
  }
  return out;
}

function sentenceAround(text: string, index: number): [number, number] {
  const boundary = /[.!?](?=\s)|\n/g;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(boundary)) {
    if (m.index! < index) start = m.index! + 1;
    else {
      end = m.index!;
      break;
    }
  }
  return [start, end];
}

/**
 * The day a price or discount at index is applied to: the nearest weekday
 * named in the same sentence; else the latest availability result's day when
 * the sentence names one of its slot times; else null (a general statement).
 */
function dayContext(text: string, index: number, facts: Facts): Weekday | null {
  const [start, end] = sentenceAround(text, index);
  const near = dayMentions(text)
    .filter((d) => d.index >= start && d.index < end)
    .sort((a, b) => Math.abs(a.index - index) - Math.abs(b.index - index))[0];
  if (near) return near.day;
  const sentence = text.slice(start, end);
  const avail = facts.availability;
  if (avail && avail.slots.some((s) => sentence.includes(s.time))) return avail.weekday as Weekday;
  return null;
}

/** "Kids cut (under 12)" -> ["Kids cut (under 12)", "Kids cut"]: the name, and the name without a trailing bracketed qualifier. */
function nameForms(name: string): string[] {
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return stripped && stripped !== name ? [name, stripped] : [name];
}

type Span = { start: number; end: number };

/** Service-name occurrences, longest match wins where two forms start at the same place. */
function nameSpans(text: string, brain: BusinessBrain): Array<Span & { id: string }> {
  const spans: Array<Span & { id: string }> = [];
  for (const s of brain.services) {
    for (const form of nameForms(s.name)) {
      for (const m of text.matchAll(new RegExp(escape(form), "gi"))) spans.push({ id: s.id, start: m.index!, end: m.index! + m[0].length });
    }
  }
  return spans.filter((a) => !spans.some((b) => b !== a && b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start));
}

/**
 * The service a price is bound to: the nearest service name before it, only
 * when no other price, no sentence or line break, and at most BIND_WINDOW
 * characters lie between them. Otherwise null (unbound).
 */
function boundService(text: string, price: Span, names: Array<Span & { id: string }>, prices: Span[]): string | null {
  const near = names.filter((n) => n.end <= price.start).sort((a, b) => b.end - a.end)[0];
  if (!near || price.start - near.end > BIND_WINDOW) return null;
  if (prices.some((p) => p !== price && p.start >= near.end && p.end <= price.start)) return null;
  if (/\n|[.!?]\s/.test(text.slice(near.end, price.start))) return null;
  return near.id;
}

/** "10:00", "10:30pm", "10am" -> "HH:MM" 24h. */
function normaliseTime(h: string, m: string | undefined, ampm: string | undefined): string | null {
  let hour = Number(h);
  const min = m === undefined ? 0 : Number(m);
  if (hour > 24 || min > 59) return null;
  if (ampm) {
    const pm = ampm.toLowerCase() === "pm";
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function verifyText(text: string, facts: Facts): Verdict {
  const { brain } = facts;
  const checks: Check[] = [];

  for (const [re, detail] of LEAK_PATTERNS) {
    const m = text.match(re);
    if (m) checks.push({ rule: "protocol_leak", claim: m[0], pass: false, detail: `reply ${detail}; call the tool directly` });
  }
  const byService = pricesByService(brain);
  // A fixed discount amount ("$5 off") may also be quoted on its own.
  const amountsOff = brain.discounts.flatMap((d) => (d.amountOffCents !== null ? [d.amountOffCents] : []));
  const allPrices = new Set([...[...byService.values()].flatMap((s) => [...s]), ...amountsOff]);
  const money = (c: number) => `${(c / 100).toFixed(2).replace(/\.00$/, "")}`;

  const names = nameSpans(text, brain);
  const priceMatches = [...text.matchAll(PRICE_RE)];
  const priceSpans: Span[] = priceMatches.map((m) => ({ start: m.index!, end: m.index! + m[0].length }));

  priceMatches.forEach((m, i) => {
    const claim = m[0];
    const cents = toCents(m[2] ?? m[3]);
    if (!allPrices.has(cents)) {
      checks.push({ rule: "price", claim, pass: false, detail: `${money(cents)} is not a listed or discounted price` });
      return;
    }
    const id = boundService(text, priceSpans[i], names, priceSpans);
    if (!id) {
      checks.push({ rule: "price", claim, pass: true, inconclusive: true, detail: "listed price with no unambiguous service; for owner review" });
      return;
    }
    const ok = byService.get(id)!.has(cents);
    const service = brain.services.find((s) => s.id === id)!;
    const name = service.name;
    if (!ok || cents === service.priceCents) {
      checks.push({ rule: "service_price", claim: `${name} ${claim}`, pass: ok, ...(!ok && { detail: `${name} is not priced ${money(cents)}` }) });
      return;
    }
    // A discounted price: the rule's conditions must hold on the day it is applied to.
    const rules = rulesFor(brain, id).filter((r) => discountedCents(service, r) === cents);
    const day = dayContext(text, m.index!, facts);
    const holds = day ? rules.some((r) => ruleHoldsOn(r, day)) : rules.some((r) => r.weekdays.length === 0);
    const when = rules.flatMap((r) => r.weekdays).join("/");
    checks.push({
      rule: "discount_condition",
      claim: `${name} ${claim}${day ? ` on ${day}` : ""}`,
      pass: holds,
      ...(!holds && {
        detail: day
          ? `${money(cents)} is the ${name} price on ${when} only, not ${day}`
          : `${money(cents)} is a discounted ${name} price; say the day it applies to (${when})`,
      }),
    });
  });

  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)) {
    const rules = brain.discounts.filter((d) => d.percentOff === Number(m[1]));
    if (rules.length === 0) {
      checks.push({ rule: "discount", claim: m[0], pass: false, detail: `no ${m[0]} discount in the approved brain` });
      continue;
    }
    // Stating the rule passes; applying it to a named day passes only if a rule holds on that day.
    const day = dayContext(text, m.index!, facts);
    const holds = !day || rules.some((r) => ruleHoldsOn(r, day));
    checks.push({
      rule: "discount",
      claim: `${m[0]}${day ? ` on ${day}` : ""}`,
      pass: holds,
      ...(!holds && { detail: `${m[0]} off holds on ${rules.flatMap((r) => r.weekdays).join("/")} only, not ${day}` }),
    });
  }

  const durations = new Set(brain.services.map((s) => s.durationMin));
  for (const m of text.matchAll(/\b(\d+)\s?(?:min|mins|minutes)\b/gi)) {
    const ok = durations.has(Number(m[1]));
    checks.push({ rule: "duration", claim: m[0], pass: ok, ...(!ok && { detail: `no service lasts ${m[1]} minutes` }) });
  }

  // A time must be an opening or closing time, or a slot from the latest availability result.
  const boundaries = new Set(Object.values(brain.hours).flat().flat());
  const slotTimes = new Set((facts.availability?.slots ?? []).map((s) => s.time));
  const seen = new Set<number>();
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\s?(am|pm)?\b|\b(\d{1,2})\s?(am|pm)\b/gi)) {
    if (seen.has(m.index!)) continue;
    seen.add(m.index!);
    const t = m[1] !== undefined ? normaliseTime(m[1], m[2], m[3]) : normaliseTime(m[4], undefined, m[5]);
    if (!t) continue;
    const ok = boundaries.has(t) || slotTimes.has(t);
    checks.push({
      rule: "time",
      claim: m[0].trim(),
      pass: ok,
      ...(!ok && { detail: `${t} is neither an opening hour nor in the latest availability result` }),
    });
  }

  const confirmed = facts.bookings.some((b) => b.status === "confirmed");
  for (const m of text.matchAll(/\b(confirmed|booked|reserved|all set)\b/gi)) {
    const before = text.slice(Math.max(0, m.index! - CLAIM_WINDOW), m.index!);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 30);
    if (NEGATION_BEFORE.test(before) || CONDITION_AFTER.test(after)) {
      checks.push({ rule: "booking_claim", claim: m[0], pass: true, detail: "negated or conditional" });
      continue;
    }
    checks.push({
      rule: "booking_claim",
      claim: m[0],
      pass: confirmed,
      ...(!confirmed && { detail: "no CONFIRMED booking exists for this conversation" }),
    });
  }

  return { pass: checks.every((c) => c.pass), checks };
}

export function verifyToolCall(call: ToolCallRequest, facts: Facts): Verdict {
  if (call.name !== "request_booking") return { pass: true, checks: [] };
  const slot = String(call.arguments.slot ?? "");
  const service = String(call.arguments.service ?? "");
  const avail = facts.availability;
  const sameService = !!avail && (avail.service.id === service || avail.service.name.toLowerCase() === service.toLowerCase());
  const inSlots = !!avail && avail.slots.some((s) => s.slot === slot);
  const ok = sameService && inSlots;
  return {
    pass: ok,
    checks: [
      {
        rule: "booking_slot",
        claim: `${service} @ ${slot}`,
        pass: ok,
        ...(!ok && {
          detail: !avail
            ? "no availability result in this conversation"
            : !sameService
              ? `latest availability is for ${avail.service.id}`
              : "slot is not in the latest availability result",
        }),
      },
    ],
  };
}
