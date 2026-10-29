// Cedar Street Barbers: the synthetic demo brain approved locally on
// 2026-10-29 (local brain v3, from the voice onboarding demo script). Seeded
// into Supabase for the hosted demo. Invented business; no real client data.
import type { BusinessBrain } from "./types";

export const CEDAR_BRAIN: BusinessBrain = {
  name: "Cedar Street Barbers",
  timezone: "Asia/Jerusalem",
  languages: ["en"],
  tone: { adjectives: ["warm", "short", "relaxed"], example: "Come in, take a seat - we've got you." },
  currency: "ILS",
  services: [
    { id: "classic_cut", name: "Classic cut", durationMin: 30, priceCents: 8_000, currency: "ILS" },
    { id: "skin_fade", name: "Skin fade", durationMin: 40, priceCents: 9_000, currency: "ILS" },
    { id: "beard_trim", name: "Beard trim", durationMin: 20, priceCents: 5_000, currency: "ILS" },
    { id: "cut_plus_beard", name: "Cut plus beard", durationMin: 50, priceCents: 12_000, currency: "ILS" },
  ],
  hours: {
    mon: [["09:00", "19:00"]],
    tue: [["09:00", "19:00"]],
    wed: [["09:00", "19:00"]],
    thu: [["09:00", "19:00"]],
    fri: [["08:00", "13:00"]],
    sat: [],
    sun: [["09:00", "19:00"]],
  },
  discounts: [
    {
      id: "discount_1",
      description: "Tuesdays cut plus beard is 15% off",
      percentOff: 15,
      amountOffCents: null,
      serviceIds: ["cut_plus_beard"],
      weekdays: ["tue"],
      conditions: "",
    },
  ],
  bookingPolicy: { approvalRequired: true },
  doNotSay: [],
};
