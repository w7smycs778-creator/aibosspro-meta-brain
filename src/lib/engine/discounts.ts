// Discount rules as code: which rules cover a service, whether a rule's
// conditions hold on a day, and the price a booking gets. The model never
// sets a price; request_booking and the verifier both use these.
import type { BusinessBrain, DiscountRule, Service, Weekday } from "../storage/types";

/** Rules whose service list covers serviceId (an empty list covers every service). */
export function rulesFor(brain: BusinessBrain, serviceId: string): DiscountRule[] {
  return brain.discounts.filter((d) => d.serviceIds.length === 0 || d.serviceIds.includes(serviceId));
}

/** A rule with no weekdays holds every day. */
export function ruleHoldsOn(rule: DiscountRule, weekday: Weekday): boolean {
  return rule.weekdays.length === 0 || rule.weekdays.includes(weekday);
}

export function discountedCents(service: Service, rule: DiscountRule): number {
  if (rule.percentOff !== null) return Math.round((service.priceCents * (100 - rule.percentOff)) / 100);
  return Math.max(0, service.priceCents - (rule.amountOffCents ?? 0));
}

/** The price for service on weekday: the lowest price among the rules whose conditions hold, else the list price. */
export function priceOn(brain: BusinessBrain, service: Service, weekday: Weekday): { priceCents: number; discountId: string | null } {
  let best = { priceCents: service.priceCents, discountId: null as string | null };
  for (const rule of rulesFor(brain, service.id)) {
    if (!ruleHoldsOn(rule, weekday)) continue;
    const cents = discountedCents(service, rule);
    if (cents < best.priceCents) best = { priceCents: cents, discountId: rule.id };
  }
  return best;
}
