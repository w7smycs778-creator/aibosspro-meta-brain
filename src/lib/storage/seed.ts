// The one synthetic business used by reset(). Invented name, services,
// prices, hours and discount; no real client data.
import type { BusinessBrain } from "./types";

export const SEED_BUSINESS_ID = "biz_demo_harbor_lane";

export const SEED_BRAIN: BusinessBrain = {
  name: "Harbor Lane Barbers (demo)",
  timezone: "Asia/Jerusalem",
  languages: ["English", "Hebrew"],
  tone: { adjectives: ["friendly", "brief", "upbeat"], example: "Happy to help, we have a spot for you." },
  currency: "USD",
  services: [
    { id: "classic_cut", name: "Classic cut", durationMin: 30, priceCents: 3_500, currency: "USD" },
    { id: "beard_trim", name: "Beard trim", durationMin: 15, priceCents: 2_000, currency: "USD" },
    { id: "cut_and_beard", name: "Cut + beard", durationMin: 45, priceCents: 5_000, currency: "USD" },
    { id: "kids_cut", name: "Kids cut (under 12)", durationMin: 20, priceCents: 2_500, currency: "USD" },
  ],
  hours: {
    mon: [["09:00", "18:00"]],
    tue: [["09:00", "18:00"]],
    wed: [["09:00", "18:00"]],
    thu: [["09:00", "20:00"]],
    fri: [["09:00", "18:00"]],
    sat: [["10:00", "15:00"]],
    sun: [],
  },
  discounts: [
    {
      id: "tuesday_combo",
      description: "10% off Cut + beard on Tuesdays",
      percentOff: 10,
      amountOffCents: null,
      serviceIds: ["cut_and_beard"],
      weekdays: ["tue"],
      conditions: "",
    },
  ],
  bookingPolicy: { approvalRequired: true },
  doNotSay: [],
};
