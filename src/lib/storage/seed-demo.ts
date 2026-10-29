// Three more synthetic demo businesses next to Cedar Street Barbers, one per
// supported language. Invented names, services, prices, hours and discounts;
// no real client data. Prices do not repeat across businesses, so a price
// leaking from one business into another is always a verifier failure.
import { upgradeBrain } from "./brain";
import { SEED_BUSINESS_ID } from "./seed";
import { CEDAR_BRAIN } from "./seed-cedar";
import type { BusinessBrain, Storage } from "./types";

export const PILATES_ID = "biz_demo_pilates_tlv";
export const PILATES_BRAIN: BusinessBrain = {
  name: "סטודיו אופק פילאטיס",
  timezone: "Asia/Jerusalem",
  languages: ["Hebrew", "English"],
  tone: { adjectives: ["חם", "אנרגטי", "קצר"], example: "בואי לנשום, לזוז ולהתחזק איתנו." },
  currency: "ILS",
  services: [
    { id: "reformer_group", name: "שיעור מכשירים קבוצתי", durationMin: 55, priceCents: 14_000, currency: "ILS", localNames: { en: "Reformer group class" } },
    { id: "private_session", name: "שיעור פרטי", durationMin: 55, priceCents: 30_000, currency: "ILS", localNames: { en: "Private session" } },
    { id: "mat_class", name: "שיעור מזרן", durationMin: 50, priceCents: 7_000, currency: "ILS", localNames: { en: "Mat class" } },
    { id: "trial_class", name: "שיעור ניסיון", durationMin: 45, priceCents: 5_500, currency: "ILS", localNames: { en: "Trial class" } },
  ],
  hours: {
    sun: [["07:00", "21:00"]],
    mon: [["07:00", "21:00"]],
    tue: [["07:00", "21:00"]],
    wed: [["07:00", "21:00"]],
    thu: [["07:00", "21:00"]],
    fri: [["08:00", "13:00"]],
    sat: [],
  },
  discounts: [
    {
      id: "monday_private",
      description: "בימי שני שיעור פרטי ב-20% הנחה",
      percentOff: 20,
      amountOffCents: null,
      serviceIds: ["private_session"],
      weekdays: ["mon"],
      conditions: "",
    },
  ],
  bookingPolicy: { approvalRequired: true },
  doNotSay: [],
};

export const DETAILING_ID = "biz_demo_detailing_mia";
export const DETAILING_BRAIN: BusinessBrain = {
  name: "Bahía Azul Auto Detailing",
  timezone: "America/New_York",
  languages: ["Spanish", "English"],
  tone: { adjectives: ["amable", "directo", "entusiasta"], example: "¡Tu carro va a quedar como nuevo!" },
  currency: "USD",
  services: [
    { id: "exterior_wash", name: "Lavado exterior", durationMin: 45, priceCents: 4_500, currency: "USD", localNames: { en: "Exterior wash" } },
    { id: "full_detail", name: "Detallado completo", durationMin: 120, priceCents: 17_500, currency: "USD", localNames: { en: "Full detail" } },
    { id: "polish_wax", name: "Pulido y encerado", durationMin: 90, priceCents: 13_500, currency: "USD", localNames: { en: "Polish and wax" } },
    { id: "interior_clean", name: "Limpieza de interiores", durationMin: 60, priceCents: 9_500, currency: "USD", localNames: { en: "Interior cleaning" } },
  ],
  hours: {
    mon: [["08:00", "18:00"]],
    tue: [["08:00", "18:00"]],
    wed: [["08:00", "18:00"]],
    thu: [["08:00", "18:00"]],
    fri: [["08:00", "18:00"]],
    sat: [["08:00", "18:00"]],
    sun: [],
  },
  discounts: [
    {
      id: "wednesday_full_detail",
      description: "Los miércoles, $30 de descuento en el Detallado completo",
      percentOff: null,
      amountOffCents: 3_000,
      serviceIds: ["full_detail"],
      weekdays: ["wed"],
      conditions: "",
    },
  ],
  bookingPolicy: { approvalRequired: true },
  doNotSay: [],
};

export const PHYSIO_ID = "biz_demo_physio_mtl";
export const PHYSIO_BRAIN: BusinessBrain = {
  name: "Clinique Physio Érable",
  timezone: "America/Toronto",
  languages: ["French", "English"],
  tone: { adjectives: ["rassurant", "professionnel", "chaleureux"], example: "On s'occupe de vous, à votre rythme." },
  currency: "CAD",
  services: [
    { id: "physio_assessment", name: "Évaluation en physiothérapie", durationMin: 60, priceCents: 11_500, currency: "CAD", localNames: { en: "Physiotherapy assessment" } },
    { id: "physio_treatment", name: "Traitement de physiothérapie", durationMin: 40, priceCents: 8_800, currency: "CAD", localNames: { en: "Physiotherapy treatment" } },
    { id: "therapeutic_massage", name: "Massage thérapeutique", durationMin: 60, priceCents: 10_000, currency: "CAD", localNames: { en: "Therapeutic massage" } },
    { id: "swedish_massage", name: "Massage suédois", durationMin: 90, priceCents: 15_500, currency: "CAD", localNames: { en: "Swedish massage" } },
  ],
  hours: {
    mon: [["08:00", "20:00"]],
    tue: [["08:00", "20:00"]],
    wed: [["08:00", "20:00"]],
    thu: [["08:00", "20:00"]],
    fri: [["09:00", "19:00"]],
    sat: [["09:00", "14:00"]],
    sun: [],
  },
  discounts: [
    {
      id: "tuesday_massage",
      description: "Le mardi, 15 % de rabais sur le massage thérapeutique",
      percentOff: 15,
      amountOffCents: null,
      serviceIds: ["therapeutic_massage"],
      weekdays: ["tue"],
      conditions: "",
    },
  ],
  bookingPolicy: { approvalRequired: true },
  doNotSay: [],
};

/** Every demo business, Cedar Street Barbers first (it keeps the original demo id). */
export const DEMO_BUSINESSES: ReadonlyArray<{ id: string; brain: BusinessBrain }> = [
  { id: SEED_BUSINESS_ID, brain: CEDAR_BRAIN },
  { id: PILATES_ID, brain: PILATES_BRAIN },
  { id: DETAILING_ID, brain: DETAILING_BRAIN },
  { id: PHYSIO_ID, brain: PHYSIO_BRAIN },
];

export function isDemoBusiness(id: string): boolean {
  return DEMO_BUSINESSES.some((b) => b.id === id);
}

/**
 * Idempotent: creates each of the three extra businesses if missing and
 * approves its seed brain unless the approved brain already equals it. Cedar
 * Street Barbers is left to reset/demo:reset. Returns what happened per business.
 */
export async function seedDemoBusinesses(store: Storage): Promise<Array<{ id: string; name: string; version: number; added: boolean }>> {
  const out: Array<{ id: string; name: string; version: number; added: boolean }> = [];
  for (const { id, brain } of DEMO_BUSINESSES.slice(1)) {
    await store.ensureBusiness({ id, name: brain.name, whatsappDefaultMode: "AUTO" });
    const current = await store.getBrain(id, { approvedOnly: true });
    // Stored brains are normalized (field and weekday order), so compare normalized forms.
    if (current && JSON.stringify(upgradeBrain(current.brain)) === JSON.stringify(upgradeBrain(brain))) {
      out.push({ id, name: brain.name, version: current.version, added: false });
      continue;
    }
    const draft = await store.addBrainVersion(id, brain, { kind: "seed", text: null, audioPath: null });
    const approved = await store.approveBrainVersion(id, draft.version);
    out.push({ id, name: brain.name, version: approved.version, added: true });
  }
  return out;
}
