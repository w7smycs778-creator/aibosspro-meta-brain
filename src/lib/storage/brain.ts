// Reading stored brains: versions written before a field existed get its
// default, so older rows keep working without a reset.
import type { BusinessBrain, DiscountRule, Service, Weekday } from "./types";

export const WEEKDAY_KEYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function upgradeBrain(raw: any): BusinessBrain {
  const currency: string = raw?.currency ?? "USD";
  const services: Service[] = (raw?.services ?? []).map((s: any) => ({
    id: s.id,
    name: s.name,
    durationMin: s.durationMin,
    priceCents: s.priceCents,
    currency: s.currency ?? currency,
    ...(s.localNames && { localNames: s.localNames }),
  }));
  const discounts: DiscountRule[] = (raw?.discounts ?? []).map((d: any) => ({
    id: d.id,
    description: d.description ?? "",
    percentOff: d.percentOff ?? null,
    amountOffCents: d.amountOffCents ?? null,
    serviceIds: d.serviceIds ?? (d.serviceId ? [d.serviceId] : []),
    weekdays: d.weekdays ?? [],
    conditions: d.conditions ?? "",
  }));
  const hours = Object.fromEntries(WEEKDAY_KEYS.map((k) => [k, raw?.hours?.[k] ?? []])) as BusinessBrain["hours"];
  return {
    name: raw?.name ?? "",
    timezone: raw?.timezone ?? "UTC",
    languages: raw?.languages ?? ["English"],
    tone: { adjectives: raw?.tone?.adjectives ?? [], example: raw?.tone?.example ?? "" },
    currency,
    services,
    hours,
    discounts,
    bookingPolicy: { approvalRequired: true },
    doNotSay: raw?.doNotSay ?? [],
  };
}
