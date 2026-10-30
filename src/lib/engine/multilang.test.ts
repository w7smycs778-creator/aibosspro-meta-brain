// Step 7: four languages (en, he, es, fr), four demo businesses, tenant
// isolation. Mock model client only; no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MOCK_MODEL, MOCK_PRICES, MockModelClient, type ScriptedStep } from "../gateway/mock-client";
import { usdToNano } from "../gateway/money";
import { LocalStore } from "../storage/local-store";
import { SEED_BUSINESS_ID } from "../storage/seed";
import { CEDAR_BRAIN } from "../storage/seed-cedar";
import { DETAILING_BRAIN, DETAILING_ID, PHYSIO_BRAIN, PHYSIO_ID, PILATES_BRAIN, PILATES_ID, seedDemoBusinesses } from "../storage/seed-demo";
import type { BusinessBrain, Weekday } from "../storage/types";
import { brainFacts } from "./brain-prompt";
import { handleInbound } from "./conversation-service";
import { DEMO_CLOCK } from "./demo-script";
import { resolveBusiness } from "./http";
import { detectLanguage, STRINGS } from "./i18n";
import { decideBooking } from "./owner";
import { checkAvailabilityTool, listServicesTool, priceQuote, type AvailabilityResult } from "./tools";
import { verifyText, type Facts } from "./verifier";

// After DEMO_CLOCK (Thu 2026-10-29): Mon Nov 2, Tue Nov 3, Wed Nov 4.
const MONDAY = "2026-11-02";
const TUESDAY = "2026-11-03";
const WEDNESDAY = "2026-11-04";

const dirs: string[] = [];
const stores: LocalStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function demoStore(): Promise<LocalStore> {
  const d = mkdtempSync(join(tmpdir(), "meta-brain-ml-"));
  dirs.push(d);
  const s = LocalStore.open(d);
  stores.push(s);
  await s.reset(CEDAR_BRAIN);
  await seedDemoBusinesses(s);
  return s;
}

function deps(s: LocalStore, script: ScriptedStep[]) {
  const client = new MockModelClient(script);
  const gateway = new SpendGateway({
    ledger: new StoreSpendLedger(s, { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) }),
    dispatcher: client,
    prices: MOCK_PRICES,
  });
  return { client, deps: { store: s, gateway, model: MOCK_MODEL, now: () => DEMO_CLOCK } };
}

const inbound = (businessId: string, text: string, eventId: string, session = "panel-ml") => ({
  businessId,
  channel: "panel" as const,
  externalConversationId: session,
  senderId: session,
  text,
  externalEventId: eventId,
});
const final = (text: string): ScriptedStep => ({ raw: JSON.stringify({ type: "final", text }) });
const call = (name: string, args: Record<string, unknown> = {}): ScriptedStep => ({ raw: JSON.stringify({ type: "tool_call", name, args }) });
const okDeliver = async () => ({ ok: true, status: null, channel: "panel" }) as never;

function avail(brain: BusinessBrain, serviceId: string, date: string, weekday: Weekday): AvailabilityResult {
  const s = brain.services.find((x) => x.id === serviceId)!;
  return {
    date,
    weekday,
    service: { id: s.id, name: s.name, durationMin: s.durationMin, priceCents: s.priceCents },
    price: priceQuote(brain, s, weekday),
    slots: [{ slot: `${date}T10:00`, time: "10:00", startsAt: `${date}T15:00:00.000Z` }],
  };
}
const factsFor = (brain: BusinessBrain, a: AvailabilityResult | null, over: Partial<Facts> = {}): Facts => ({ brain, availability: a, bookings: [], ...over });
const failed = (text: string, f: Facts) => verifyText(text, f).checks.filter((c) => !c.pass);

describe("language detection and code-inserted strings", () => {
  it("detects en, he, es, fr; falls back when nothing decides", () => {
    expect(detectLanguage("Que ofrecen?")).toBe("es");
    expect(detectLanguage("Tienen hueco el martes a las 10 para corte y barba?")).toBe("es");
    expect(detectLanguage("Qu'est-ce que vous proposez?")).toBe("fr");
    expect(detectLanguage("Avez-vous de la place mardi a 10h pour coupe et barbe?")).toBe("fr");
    expect(detectLanguage("What do you offer?")).toBe("en");
    expect(detectLanguage("מה אתם מציעים?")).toBe("he");
    expect(detectLanguage("ok", "fr")).toBe("fr");
  });

  it("every string exists in all four languages", () => {
    for (const lang of ["en", "he", "es", "fr"] as const) {
      const t = STRINGS[lang];
      expect(t.disclosure.trim().length, lang).toBeGreaterThan(0);
      expect(t.ownerHelp.length, lang).toBeGreaterThan(0);
      expect(t.approved("X", "W")).toContain("X");
      expect(t.rejected("X", "W")).toContain("W");
    }
  });

  it("price quotes are computed by code in each business's languages and currency format", () => {
    const wed = priceQuote(DETAILING_BRAIN, DETAILING_BRAIN.services[1], "wed");
    expect(wed).toMatchObject({ priceCents: 14_500, listPriceCents: 17_500, discountId: "wednesday_full_detail" });
    expect(wed.quotes.es).toBe("Detallado completo cuesta $145 el miércoles, normalmente $175 (Los miércoles, $30 de descuento en el Detallado completo)");
    expect(wed.quotes.en).toBe("Full detail is $145 on Wednesday, normally $175");
    const tue = priceQuote(PHYSIO_BRAIN, PHYSIO_BRAIN.services[2], "tue");
    expect(tue.quotes.fr).toBe("Massage thérapeutique coûte 85 $ CA le mardi, normalement 100 $ CA (Le mardi, 15 % de rabais sur le massage thérapeutique)");
    expect(priceQuote(PHYSIO_BRAIN, PHYSIO_BRAIN.services[2], "wed").quotes.fr).toBe("Massage thérapeutique coûte 100 $ CA");
    expect(priceQuote(PILATES_BRAIN, PILATES_BRAIN.services[1], "mon").quotes.he).toBe("שיעור פרטי ב-₪240 ביום שני, במקום ₪300 (בימי שני שיעור פרטי ב-20% הנחה)");
  });

  it("the prompt lists each business's languages and conventions", () => {
    expect(brainFacts(DETAILING_BRAIN, 1)).toContain("Languages: Spanish, English.");
    expect(brainFacts(DETAILING_BRAIN, 1)).toContain("In Spanish: write prices with digits as listed");
    expect(brainFacts(PHYSIO_BRAIN, 1)).toContain("- Massage thérapeutique (English: Therapeutic massage): 100 $ CA, 60 min");
    expect(brainFacts(PILATES_BRAIN, 1)).toContain("Languages: Hebrew, English.");
  });
});

describe("verifier: Spanish", () => {
  const a = avail(DETAILING_BRAIN, "full_detail", WEDNESDAY, "wed");
  const f = factsFor(DETAILING_BRAIN, a);

  it("passes the code-computed discounted price on its day and the rule statement", () => {
    expect(verifyText("El miércoles a las 10:00 hay hueco. Detallado completo cuesta $145 el miércoles, normalmente $175.", f).pass).toBe(true);
    expect(verifyText("Los miércoles hay $30 de descuento en el Detallado completo.", f).pass).toBe(true);
    expect(verifyText("Lavado exterior $45, 45 minutos. Limpieza de interiores 95 dólares.", f).pass).toBe(true);
  });

  it("blocks wrong prices, wrong days, wrong durations and times", () => {
    expect(failed("Detallado completo cuesta $145 el jueves.", f)).toEqual([expect.objectContaining({ rule: "discount_condition" })]);
    expect(failed("Hay $30 de descuento el viernes.", f)).toEqual([expect.objectContaining({ rule: "discount" })]);
    expect(failed("Lavado exterior cuesta $40.", f)).toEqual([expect.objectContaining({ rule: "price" })]);
    expect(failed("Pulido y encerado cuesta $95.", f)).toEqual([expect.objectContaining({ rule: "service_price" })]);
    expect(failed("Te damos 50 por ciento de descuento.", f)).toEqual([expect.objectContaining({ rule: "discount" })]);
    expect(failed("El lavado exterior dura 30 minutos.", f)).toEqual([expect.objectContaining({ rule: "duration" })]);
    expect(failed("Te espero a las 7.", f)).toEqual([expect.objectContaining({ rule: "time" })]);
  });

  it("adversarial: a booking claimed as confirmed in Spanish is blocked", () => {
    for (const claim of [
      "¡Listo! Tu cita está confirmada para el miércoles a las 10:00.",
      "Te reservé el miércoles a las 10:00.",
      "Tu cita quedó agendada.",
      "Perfecto, el Detallado completo está reservado.",
      "Te confirmo la cita del miércoles.",
    ]) {
      expect(failed(claim, f), claim).toContainEqual(expect.objectContaining({ rule: "booking_claim" }));
    }
    for (const ok of [
      "Tu cita todavía no está confirmada; el dueño tiene que aprobarla.",
      "Quedará confirmada cuando el dueño la apruebe.",
      "Será confirmada por el dueño en breve.",
      "¿Quieres que te la reserve?",
    ]) {
      expect(failed(ok, f), ok).toEqual([]);
    }
  });

  it("a promise to check later is a protocol leak", () => {
    expect(failed("Déjame revisar y te aviso luego.", f).map((c) => c.rule)).toContain("protocol_leak");
  });
});

describe("verifier: French", () => {
  const a = avail(PHYSIO_BRAIN, "therapeutic_massage", TUESDAY, "tue");
  const f = factsFor(PHYSIO_BRAIN, a);

  it("passes the code-computed discounted price, French times and currency", () => {
    expect(verifyText("Mardi à 10h, c'est libre. Massage thérapeutique coûte 85 $ CA le mardi, normalement 100 $ CA.", f).pass).toBe(true);
    expect(verifyText("Le mardi, 15 % de rabais sur le massage thérapeutique.", f).pass).toBe(true);
    expect(verifyText("Ouvert de 8h à 20h. Massage suédois, 90 min, 155 $ CA.", f).pass).toBe(true);
  });

  it("blocks wrong prices, wrong days and times", () => {
    expect(failed("Massage thérapeutique coûte 85 $ CA le mercredi.", f)).toEqual([expect.objectContaining({ rule: "discount_condition" })]);
    expect(failed("Nous offrons 15 % de rabais le jeudi.", f)).toEqual([expect.objectContaining({ rule: "discount" })]);
    expect(failed("Massage suédois à 140 $ CA.", f)).toEqual([expect.objectContaining({ rule: "price" })]);
    expect(failed("Je peux vous voir à 21h.", f)).toEqual([expect.objectContaining({ rule: "time" })]);
  });

  it("adversarial: a booking claimed as confirmed in French is blocked", () => {
    for (const claim of ["Votre rendez-vous est confirmé pour mardi à 10h.", "C'est réservé!", "Parfait, votre massage est réservé.", "Votre séance est confirmée."]) {
      expect(failed(claim, f), claim).toContainEqual(expect.objectContaining({ rule: "booking_claim" }));
    }
    for (const ok of [
      "Votre rendez-vous n'est pas encore confirmé.",
      "Il sera confirmé dès que la clinique l'aura validé.",
      "Votre demande est en attente; elle sera confirmée par la clinique.",
      "Voulez-vous que je réserve ce créneau?",
    ]) {
      expect(failed(ok, f), ok).toEqual([]);
    }
  });

  it("a promise to check later is a protocol leak", () => {
    expect(failed("Je vais vérifier les disponibilités.", f).map((c) => c.rule)).toContain("protocol_leak");
  });
});

describe("verifier: Hebrew business", () => {
  const f = factsFor(PILATES_BRAIN, avail(PILATES_BRAIN, "private_session", MONDAY, "mon"));
  it("discounted price on its day passes; other days and confirmation claims are blocked", () => {
    expect(verifyText("ביום שני ב-10:00 יש מקום. שיעור פרטי ב-₪240 ביום שני, במקום ₪300.", f).pass).toBe(true);
    expect(failed("שיעור פרטי ב-₪240 ביום שלישי.", f)).toEqual([expect.objectContaining({ rule: "discount_condition" })]);
    expect(failed("השיעור הפרטי שלך אושר!", f)).toEqual([expect.objectContaining({ rule: "booking_claim" })]);
    expect(failed("התור שלך נקבע ליום שני.", f)).toEqual([expect.objectContaining({ rule: "booking_claim" })]);
  });
});

describe("tenant isolation", () => {
  it("seeds four approved businesses idempotently", async () => {
    const s = await demoStore();
    expect((await s.listBusinesses()).map((b) => b.id).sort()).toEqual([SEED_BUSINESS_ID, DETAILING_ID, PHYSIO_ID, PILATES_ID].sort());
    expect((await seedDemoBusinesses(s)).every((r) => !r.added && r.version === 1)).toBe(true);
    expect(await resolveBusiness(s, DETAILING_ID)).toBe(DETAILING_ID);
    expect(await resolveBusiness(s, undefined)).toBe(SEED_BUSINESS_ID);
    expect(((await resolveBusiness(s, "biz_nope")) as Response).status).toBe(404);
  });

  it("business B's prompt, tools and verifier never carry business A's services or prices", async () => {
    const s = await demoStore();
    const { client, deps: d } = deps(s, [
      call("check_availability", { date: TUESDAY, service: "cut_plus_beard" }),
      final("Cut plus beard is ₪120."),
      final("No tenemos ese servicio. Ofrecemos Lavado exterior $45, Detallado completo $175, Pulido y encerado $135 y Limpieza de interiores $95."),
    ]);
    const r = await handleInbound(inbound(DETAILING_ID, "¿Cuánto cuesta el Cut plus beard de Cedar Street?", "iso1"), d);

    const system = client.calls[0].messages[0].content as string;
    for (const leak of ["Cedar", "Cut plus beard", "₪", "Classic cut", "Skin fade"]) expect(system, leak).not.toContain(leak);
    const toolResult = r.trace.find((t) => t.checkpoint?.kind === "tool_result")!.checkpoint!.result as { ok: boolean; error?: string };
    expect(toolResult.ok).toBe(false);
    expect(toolResult.error).toContain('unknown service "cut_plus_beard"');
    const blocked = r.trace.find((t) => t.checkpoint?.kind === "verifier" && t.checkpoint.pass === false)!;
    expect(blocked.checkpoint!.checks).toContainEqual(expect.objectContaining({ rule: "price", claim: "₪120", pass: false }));
    expect(r.replyText).toBe("[Asistente IA] No tenemos ese servicio. Ofrecemos Lavado exterior $45, Detallado completo $175, Pulido y encerado $135 y Limpieza de interiores $95.");

    // Tools read only the conversation's business.
    const ctx = (businessId: string) => ({ store: s, businessId, conversationId: "c", customerRef: "x", now: () => DEMO_CLOCK }) as never;
    const services = (await listServicesTool.execute({}, ctx(PHYSIO_ID))) as { services: Array<{ id: string }> };
    expect(services.services.map((x) => x.id)).toEqual(PHYSIO_BRAIN.services.map((x) => x.id));
    await expect(checkAvailabilityTool.execute({ date: TUESDAY, service: "private_session" }, ctx(PHYSIO_ID))).rejects.toThrow("unknown service");
  });

  it("the same panel session id on two businesses is two separate conversations, bookings stay per business", async () => {
    const s = await demoStore();
    const book = (service: string, date: string) => ({ service, slot: `${date}T10:00`, customer_name: "Ana", customer_contact: "000-0000" });
    const { deps: d } = deps(s, [
      call("check_availability", { date: WEDNESDAY, service: "full_detail" }),
      call("request_booking", book("full_detail", WEDNESDAY)),
      final("Envié la solicitud al dueño; tu cita todavía no está confirmada."),
      call("check_availability", { date: TUESDAY, service: "therapeutic_massage" }),
      call("request_booking", book("therapeutic_massage", TUESDAY)),
      final("J'ai transmis votre demande; le rendez-vous n'est pas encore confirmé."),
    ]);
    const es = await handleInbound(inbound(DETAILING_ID, "Quiero el Detallado completo el miércoles a las 10, Ana 000-0000", "s1", "same"), d);
    const fr = await handleInbound(inbound(PHYSIO_ID, "Je voudrais le massage thérapeutique mardi à 10h, Ana 000-0000", "s2", "same"), d);
    expect(es.conversationId).not.toBe(fr.conversationId);
    const [mia] = await s.listBookings(DETAILING_ID);
    const [mtl] = await s.listBookings(PHYSIO_ID);
    expect(mia).toMatchObject({ serviceId: "full_detail", status: "pending_approval", priceCents: 14_500, currency: "USD" });
    expect(mtl).toMatchObject({ serviceId: "therapeutic_massage", status: "pending_approval", priceCents: 8_500, currency: "CAD" });
    expect(await s.listBookings(SEED_BUSINESS_ID)).toEqual([]);
    expect(await s.listBookings(PILATES_ID)).toEqual([]);

    const ok = await decideBooking(s, es.pendingApprovalId!, "approved", okDeliver);
    expect(ok.replyText).toBe("Buenas noticias: tu cita de Detallado completo el miércoles, 4 de noviembre, 10:00 EST está confirmada. ¡Te esperamos!");
    const no = await decideBooking(s, fr.pendingApprovalId!, "rejected", okDeliver);
    expect(no.replyText).toBe(
      "Désolé, le rendez-vous Massage thérapeutique le mardi 3 novembre à 10 h 00 EST n'est finalement plus disponible. Voulez-vous que je cherche un autre créneau?",
    );
  });
});

describe("replies follow the customer's language", () => {
  it("switches disclosure and hand-off language when the customer switches", async () => {
    const s = await demoStore();
    const { deps: d } = deps(s, [
      final("Ofrecemos Lavado exterior $45 y Detallado completo $175."),
      final("We offer Exterior wash $45 and Full detail $175."),
    ]);
    const es = await handleInbound(inbound(DETAILING_ID, "¿Qué ofrecen?", "l1"), d);
    const en = await handleInbound(inbound(DETAILING_ID, "Sorry, do you speak English? What do you offer?", "l2"), d);
    expect(es.replyText!.startsWith("[Asistente IA] ")).toBe(true);
    expect(en.replyText!.startsWith("[AI assistant] ")).toBe(true);

    const fr = await handleInbound(inbound(PHYSIO_ID, "Bonjour, je voudrais parler à quelqu'un.", "l3", "fr-off"), { store: s, gateway: null, gatewayError: "test", model: MOCK_MODEL, now: () => DEMO_CLOCK });
    expect(fr.replyText).toBe(`[Assistant IA] ${STRINGS.fr.ownerHelp}`);
  });

  it("new panel conversations on every demo business start in AUTO", async () => {
    const s = await demoStore();
    for (const id of [PILATES_ID, DETAILING_ID, PHYSIO_ID]) {
      const { deps: d } = deps(s, [final("שלום")]);
      const r = await handleInbound(inbound(id, "hi", `auto-${id}`, `auto-${id}`), d);
      expect(r.mode, id).toBe("AUTO");
    }
  });
});
