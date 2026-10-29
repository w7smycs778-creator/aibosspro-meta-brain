// Offers for creatives, computed from the approved brain by code. The model
// never computes or chooses a price: the text band and the caption check both
// read these facts.
import { formatMoney } from "../engine/brain-prompt";
import { discountedCents } from "../engine/discounts";
import type { BusinessBrain, Weekday } from "../storage/types";

export type Offer = {
  id: string;
  kind: "service" | "discount";
  serviceId: string;
  serviceName: string;
  durationMin: number;
  currency: string;
  listPriceCents: number;
  offerPriceCents: number;
  discountId: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  weekdays: Weekday[];
  /** When the offer holds, e.g. "Tuesdays"; null for a plain service. */
  condition: string | null;
  /** Dropdown label, e.g. "Cut plus beard, 15% off Tuesdays -> ₪102". */
  label: string;
  /** Offer line in the text band, e.g. "Cut plus beard · 15% off · Tuesdays". */
  headline: string;
  /** The price exactly as rendered, e.g. "₪102". */
  priceText: string;
  listPriceText: string;
};

const PLURAL: Record<Weekday, string> = {
  mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays", thu: "Thursdays", fri: "Fridays", sat: "Saturdays", sun: "Sundays",
};

export function listOffers(brain: BusinessBrain): Offer[] {
  const offers: Offer[] = [];
  for (const s of brain.services) {
    const currency = s.currency || brain.currency;
    const listPriceText = formatMoney(s.priceCents, currency);
    offers.push({
      id: `service:${s.id}`,
      kind: "service",
      serviceId: s.id,
      serviceName: s.name,
      durationMin: s.durationMin,
      currency,
      listPriceCents: s.priceCents,
      offerPriceCents: s.priceCents,
      discountId: null,
      percentOff: null,
      amountOffCents: null,
      weekdays: [],
      condition: null,
      label: `${s.name} -> ${listPriceText}`,
      headline: `${s.name} · ${s.durationMin} min`,
      priceText: listPriceText,
      listPriceText,
    });
  }
  for (const d of brain.discounts) {
    const targets = d.serviceIds.length ? brain.services.filter((s) => d.serviceIds.includes(s.id)) : brain.services;
    for (const s of targets) {
      const currency = s.currency || brain.currency;
      const price = discountedCents(s, d);
      const off = d.percentOff !== null ? `${d.percentOff}% off` : `${formatMoney(d.amountOffCents ?? 0, currency)} off`;
      const days = d.weekdays.map((w) => PLURAL[w]).join(" & ");
      const condition = [days, d.conditions].filter(Boolean).join("; ") || null;
      const priceText = formatMoney(price, currency);
      offers.push({
        id: `discount:${d.id}:${s.id}`,
        kind: "discount",
        serviceId: s.id,
        serviceName: s.name,
        durationMin: s.durationMin,
        currency,
        listPriceCents: s.priceCents,
        offerPriceCents: price,
        discountId: d.id,
        percentOff: d.percentOff,
        amountOffCents: d.amountOffCents,
        weekdays: d.weekdays,
        condition,
        label: `${s.name}, ${off}${days ? ` ${days}` : ""} -> ${priceText}`,
        headline: [s.name, off, days].filter(Boolean).join(" · "),
        priceText,
        listPriceText: formatMoney(s.priceCents, currency),
      });
    }
  }
  return offers;
}

export function findOffer(brain: BusinessBrain, id: string): Offer | null {
  return listOffers(brain).find((o) => o.id === id) ?? null;
}
