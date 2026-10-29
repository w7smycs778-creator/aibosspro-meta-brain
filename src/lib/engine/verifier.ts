// Deterministic fact check run before any model reply or tool call is
// accepted. Pure functions, no model. It matches strings and numbers in the
// reply against the approved brain's structured fields, the latest
// availability result, and the conversation's bookings.
import type { ToolCallRequest } from "../gateway/types";
import type { Booking, BusinessBrain, Turn } from "../storage/types";
import type { AvailabilityResult } from "./tools";

export type Rule = "price" | "service_price" | "discount" | "duration" | "time" | "booking_claim" | "booking_slot";

export type Check = { rule: Rule; claim: string; pass: boolean; detail?: string };
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

const NAME_WINDOW = 40;
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
    const s = brain.services.find((x) => x.id === d.serviceId);
    if (s) out.get(s.id)!.add(Math.round((s.priceCents * (100 - d.percentOff)) / 100));
  }
  return out;
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
  const byService = pricesByService(brain);
  const allPrices = new Set([...byService.values()].flatMap((s) => [...s]));
  const money = (c: number) => `${(c / 100).toFixed(2).replace(/\.00$/, "")}`;

  // Service names in the text, for pairing a price with the service it follows.
  const names: Array<{ id: string; end: number }> = [];
  for (const s of brain.services) {
    for (const m of text.matchAll(new RegExp(escape(s.name), "gi"))) names.push({ id: s.id, end: m.index! + m[0].length });
  }

  for (const m of text.matchAll(/([$₪€£])\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(?:USD|dollars?)\b/gi)) {
    const claim = m[0];
    const cents = toCents(m[2] ?? m[3]);
    if (!allPrices.has(cents)) {
      checks.push({ rule: "price", claim, pass: false, detail: `${money(cents)} is not a listed or discounted price` });
      continue;
    }
    const near = names.filter((n) => n.end <= m.index! && m.index! - n.end <= NAME_WINDOW).sort((a, b) => b.end - a.end)[0];
    if (near) {
      const ok = byService.get(near.id)!.has(cents);
      const name = brain.services.find((s) => s.id === near.id)!.name;
      checks.push({ rule: "service_price", claim: `${name} ${claim}`, pass: ok, ...(!ok && { detail: `${name} is not priced ${money(cents)}` }) });
    } else {
      checks.push({ rule: "price", claim, pass: true });
    }
  }

  const percents = new Set(brain.discounts.map((d) => d.percentOff));
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)) {
    const ok = percents.has(Number(m[1]));
    checks.push({ rule: "discount", claim: m[0], pass: ok, ...(!ok && { detail: `no ${m[0]} discount in the approved brain` }) });
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
    const before = text.slice(Math.max(0, m.index! - NAME_WINDOW), m.index!);
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
