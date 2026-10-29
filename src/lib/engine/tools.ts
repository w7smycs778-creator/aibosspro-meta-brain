// The engine's tools. Deterministic code over the approved brain version and
// storage. No tool confirms a booking: request_booking only creates a pending
// booking and the owner approval that gates it.
import type { ToolContext, ToolSpec } from "../gateway/tools";
import { SlotTakenError } from "../storage/errors";
import { formatMoney } from "./brain-prompt";
import { priceOn } from "./discounts";
import { brainLangs, dayName, serviceName, STRINGS, type Lang } from "./i18n";
import type { BusinessBrain, Service, Weekday } from "../storage/types";
import { formatLocal, hhmm, localDate, localToUtc, minutes, weekdayOf } from "./time";

export const SLOT_STEP_MIN = 30;

export type Slot = { slot: string; time: string; startsAt: string };

/** What the customer is told about the price on this date, computed here so the model never does price arithmetic. */
export type PriceQuote = {
  priceCents: number;
  currency: string;
  discountId: string | null;
  /** The service's list price; differs from priceCents only when a discount applies. */
  listPriceCents: number;
  /** In the brain's first language, e.g. "Cut plus beard is ₪102 on Tuesday, normally ₪120 (Tuesdays cut plus beard is 15% off)". */
  quote: string;
  /** The same quote in each of the brain's languages, keyed by language code. */
  quotes: Partial<Record<Lang, string>>;
};

export type AvailabilityResult = {
  date: string;
  weekday: string;
  service: { id: string; name: string; durationMin: number; priceCents: number };
  /** The price on this date: the list price, or the discounted price when a rule's conditions hold. */
  price: PriceQuote;
  slots: Slot[];
};

async function approvedBrain(ctx: ToolContext): Promise<BusinessBrain> {
  const v = await ctx.store.getBrain(ctx.businessId, { approvedOnly: true });
  if (!v) throw new Error("no approved brain for this business");
  return v.brain;
}

/** Matches a service by id, or by name (or a local-language name) ignoring case. */
export function resolveService(brain: BusinessBrain, ref: string): Service {
  const key = ref.trim().toLowerCase();
  const names = (x: Service) => [x.name, ...Object.values(x.localNames ?? {})].map((n) => n.trim().toLowerCase());
  const s = brain.services.find((x) => x.id === ref || names(x).includes(key));
  if (!s) throw new Error(`unknown service "${ref}"; use an id from list_services`);
  return s;
}

export function priceQuote(brain: BusinessBrain, service: Service, weekday: Weekday): PriceQuote {
  const { priceCents, discountId } = priceOn(brain, service, weekday);
  const currency = service.currency || brain.currency;
  const rule = discountId ? brain.discounts.find((d) => d.id === discountId) : undefined;
  const price = formatMoney(priceCents, currency);
  const normal = formatMoney(service.priceCents, currency);
  const langs = brainLangs(brain);
  const quotes: Partial<Record<Lang, string>> = {};
  for (const lang of langs) {
    const name = serviceName(service, lang);
    const t = STRINGS[lang];
    // The rule's description is in the owner's words, so only the first language's quote carries it.
    const why = rule && lang === langs[0] ? ` (${rule.description})` : "";
    quotes[lang] = rule ? `${t.quote(name, price, dayName(weekday, lang), normal)}${why}` : t.plainQuote(name, price);
  }
  return { priceCents, currency, discountId, listPriceCents: service.priceCents, quote: quotes[langs[0]]!, quotes };
}

/** Open slots for service on date: weekly hours minus pending and confirmed bookings, future only. */
export async function availability(ctx: ToolContext, brain: BusinessBrain, date: string, service: Service): Promise<AvailabilityResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be "YYYY-MM-DD"');
  const weekday = weekdayOf(date);
  const tz = brain.timezone;
  const durationOf = (id: string) => brain.services.find((s) => s.id === id)?.durationMin ?? SLOT_STEP_MIN;
  const busy = (await ctx.store.listBookings(ctx.businessId))
    .filter((b) => b.status === "pending_approval" || b.status === "confirmed")
    .map((b) => {
      const start = new Date(b.startsAt).getTime();
      return [start, start + durationOf(b.serviceId) * 60_000] as const;
    });
  const nowMs = ctx.now().getTime();
  const slots: Slot[] = [];
  for (const [open, close] of brain.hours[weekday]) {
    for (let m = minutes(open); m + service.durationMin <= minutes(close); m += SLOT_STEP_MIN) {
      const time = hhmm(m);
      const start = localToUtc(date, time, tz).getTime();
      const end = start + service.durationMin * 60_000;
      if (start <= nowMs) continue;
      if (busy.some(([bs, be]) => start < be && bs < end)) continue;
      slots.push({ slot: `${date}T${time}`, time, startsAt: new Date(start).toISOString() });
    }
  }
  return {
    date,
    weekday,
    service: { id: service.id, name: service.name, durationMin: service.durationMin, priceCents: service.priceCents },
    price: priceQuote(brain, service, weekday),
    slots,
  };
}

export const listServicesTool: ToolSpec = {
  name: "list_services",
  description: "Services with duration and price, plus the discount rules, from the owner-approved brain.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  access: "read",
  async execute(_args, ctx) {
    const brain = await approvedBrain(ctx);
    return { currency: brain.currency, services: brain.services, discounts: brain.discounts };
  },
};

export const getHoursTool: ToolSpec = {
  name: "get_hours",
  description: "Weekly opening hours (local time) from the owner-approved brain.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  access: "read",
  async execute(_args, ctx) {
    const brain = await approvedBrain(ctx);
    return { timezone: brain.timezone, today: localDate(ctx.now(), brain.timezone), hours: brain.hours };
  },
};

export const checkAvailabilityTool: ToolSpec = {
  name: "check_availability",
  description:
    "Open start times for one service on one date, and the price on that date. Offer customers only times returned here; quote price.quotes for the reply's language, which includes any discount for that day.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: 'Local date, "YYYY-MM-DD".' },
      service: { type: "string", description: "Service id from list_services." },
    },
    required: ["date", "service"],
    additionalProperties: false,
  },
  access: "read",
  async execute(args, ctx) {
    const brain = await approvedBrain(ctx);
    return availability(ctx, brain, args.date as string, resolveService(brain, args.service as string));
  },
};

export const requestBookingTool: ToolSpec = {
  name: "request_booking",
  description:
    "Ask the owner to approve a booking for a slot returned by check_availability. Creates a PENDING booking; nothing is confirmed until the owner approves.",
  parameters: {
    type: "object",
    properties: {
      service: { type: "string", description: "Service id from list_services." },
      slot: { type: "string", description: 'A "slot" value from check_availability, e.g. "2026-11-05T10:00".' },
      customer_name: { type: "string" },
      customer_contact: { type: "string", description: "Phone or email the customer gave." },
    },
    required: ["service", "slot", "customer_name", "customer_contact"],
    additionalProperties: false,
  },
  access: "write",
  // One booking per conversation, service and slot: a retried or resumed call returns the first booking.
  idempotencyKey: (args, ctx) => `request_booking:${ctx.conversationId}:${String(args.service)}:${String(args.slot)}`,
  async execute(args, ctx) {
    const brain = await approvedBrain(ctx);
    const service = resolveService(brain, args.service as string);
    const slot = args.slot as string;
    const m = slot.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
    if (!m) throw new Error('slot must look like "YYYY-MM-DDTHH:MM"');
    const key = requestBookingTool.idempotencyKey!(args, ctx);
    const prior = (await ctx.store.listBookings(ctx.businessId)).find((b) => b.idempotencyKey === key);
    // Re-checked here so a slot taken since the last lookup is never requested; a resumed call finds its own booking first.
    const open = await availability(ctx, brain, m[1], service);
    const hit = open.slots.find((s) => s.slot === slot);
    if (!hit && !prior) throw new Error(`slot ${slot} is not open for ${service.name}`);
    const startsAt = hit?.startsAt ?? prior!.startsAt;
    try {
      const { booking, approval, existing } = await ctx.store.requestBooking({
        businessId: ctx.businessId,
        conversationId: ctx.conversationId,
        serviceId: service.id,
        customerRef: ctx.customerRef,
        customerName: (args.customer_name as string).trim(),
        customerContact: (args.customer_contact as string).trim(),
        startsAt,
        priceCents: open.price.priceCents,
        currency: open.price.currency,
        discountId: open.price.discountId,
        idempotencyKey: key,
      });
      return {
        bookingId: booking.id,
        approvalId: approval.id,
        status: booking.status,
        slot,
        when: formatLocal(booking.startsAt, brain.timezone),
        service: service.name,
        priceCents: booking.priceCents,
        currency: booking.currency,
        discountId: booking.discountId,
        ...(existing && { existing: true }),
      };
    } catch (err) {
      if (err instanceof SlotTakenError) throw new Error(`slot ${slot} is no longer available for ${service.name}`);
      throw err;
    }
  },
};

export const requestOwnerHelpTool: ToolSpec = {
  name: "request_owner_help",
  description: "Hand the conversation to the owner when the customer needs something you cannot do with the other tools.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "What the customer needs." } },
    required: ["reason"],
    additionalProperties: false,
  },
  access: "escalate",
  endsTurn: true,
  async execute(args) {
    return { handedToOwner: true, reason: args.reason };
  },
};

export const ENGINE_TOOLS: readonly ToolSpec[] = [
  listServicesTool,
  getHoursTool,
  checkAvailabilityTool,
  requestBookingTool,
  requestOwnerHelpTool,
];
