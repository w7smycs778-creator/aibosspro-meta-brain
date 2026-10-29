// The engine's tools. Deterministic code over the approved brain version and
// storage. No tool confirms a booking: request_booking only creates a pending
// booking and the owner approval that gates it.
import type { ToolContext, ToolSpec } from "../gateway/tools";
import type { BusinessBrain, Service } from "../storage/types";
import { formatLocal, hhmm, localDate, localToUtc, minutes, weekdayOf } from "./time";

export const SLOT_STEP_MIN = 30;

export type Slot = { slot: string; time: string; startsAt: string };

export type AvailabilityResult = {
  date: string;
  weekday: string;
  service: { id: string; name: string; durationMin: number; priceCents: number };
  slots: Slot[];
};

async function approvedBrain(ctx: ToolContext): Promise<BusinessBrain> {
  const v = await ctx.store.getBrain(ctx.businessId, { approvedOnly: true });
  if (!v) throw new Error("no approved brain for this business");
  return v.brain;
}

/** Matches a service by id, or by name ignoring case. */
export function resolveService(brain: BusinessBrain, ref: string): Service {
  const key = ref.trim().toLowerCase();
  const s = brain.services.find((x) => x.id === ref || x.name.toLowerCase() === key);
  if (!s) throw new Error(`unknown service "${ref}"; use an id from list_services`);
  return s;
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
  description: "Open start times for one service on one date. Offer customers only times returned here.",
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
  async execute(args, ctx) {
    const brain = await approvedBrain(ctx);
    const service = resolveService(brain, args.service as string);
    const slot = args.slot as string;
    const m = slot.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
    if (!m) throw new Error('slot must look like "YYYY-MM-DDTHH:MM"');
    // Re-checked here so a slot taken since the last lookup is never requested.
    const open = await availability(ctx, brain, m[1], service);
    const hit = open.slots.find((s) => s.slot === slot);
    if (!hit) throw new Error(`slot ${slot} is not open for ${service.name}`);
    const { booking, approval } = await ctx.store.requestBooking({
      businessId: ctx.businessId,
      conversationId: ctx.conversationId,
      serviceId: service.id,
      customerRef: ctx.customerRef,
      customerName: (args.customer_name as string).trim(),
      customerContact: (args.customer_contact as string).trim(),
      startsAt: hit.startsAt,
    });
    return {
      bookingId: booking.id,
      approvalId: approval.id,
      status: booking.status,
      slot,
      when: formatLocal(hit.startsAt, brain.timezone),
      service: service.name,
    };
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
