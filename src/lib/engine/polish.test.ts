// Sunday polish: discounted price quoted from the availability result, and
// replies in the customer's language. Mock model client only; no network.
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
import { upgradeBrain } from "../storage/brain";
import { brainFacts } from "./brain-prompt";
import { handleInbound } from "./conversation-service";
import { DEMO_CLOCK } from "./demo-script";
import { disclosureFor } from "./deps";
import { decideBooking } from "./owner";
import { availability, priceQuote, resolveService, type AvailabilityResult } from "./tools";
import { verifyText, type Facts } from "./verifier";

const TUESDAY = "2026-11-03";
const WEDNESDAY = "2026-11-04";
const CUT_BEARD = CEDAR_BRAIN.services.find((s) => s.id === "cut_plus_beard")!;

const dirs: string[] = [];
const stores: LocalStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh store with Cedar Street Barbers as the approved brain. */
async function cedarStore(): Promise<LocalStore> {
  const d = mkdtempSync(join(tmpdir(), "meta-brain-polish-"));
  dirs.push(d);
  const s = LocalStore.open(d);
  stores.push(s);
  await s.reset(CEDAR_BRAIN);
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

const inbound = (text: string, eventId: string) => ({
  businessId: SEED_BUSINESS_ID,
  channel: "panel" as const,
  externalConversationId: "panel-polish",
  senderId: "panel-polish",
  text,
  externalEventId: eventId,
});
const final = (text: string): ScriptedStep => ({ raw: JSON.stringify({ type: "final", text }) });
const call = (name: string, args: Record<string, unknown> = {}): ScriptedStep => ({ raw: JSON.stringify({ type: "tool_call", name, args }) });

describe("discounted price quote", () => {
  it("is computed by code: ₪102 on a Tuesday with the normal price, list price on other days", () => {
    expect(priceQuote(CEDAR_BRAIN, CUT_BEARD, "tue")).toEqual({
      priceCents: 10_200,
      currency: "ILS",
      discountId: "discount_1",
      listPriceCents: 12_000,
      quote: "Cut plus beard is ₪102 on Tuesday, normally ₪120 (Tuesdays cut plus beard is 15% off)",
    });
    expect(priceQuote(CEDAR_BRAIN, CUT_BEARD, "wed")).toEqual({
      priceCents: 12_000,
      currency: "ILS",
      discountId: null,
      listPriceCents: 12_000,
      quote: "Cut plus beard is ₪120",
    });
  });

  it("the prompt facts carry the computed discounted price", () => {
    expect(brainFacts(CEDAR_BRAIN, 1)).toContain("price then: Cut plus beard ₪102 instead of ₪120");
  });

  it("a Tuesday slot question gets the discounted price from the tool result, verified", async () => {
    const s = await cedarStore();
    const reply = "Tuesday 10:00 is open, Cut plus beard is ₪102 on Tuesday, normally ₪120. Shall I request it for you?";
    const { client, deps: d } = deps(s, [call("check_availability", { date: TUESDAY, service: "cut_plus_beard" }), final(reply)]);
    const r = await handleInbound(inbound("Do you have Tuesday 10:00 for a cut plus beard?", "e1"), d);

    expect(r.outcome).toBe("final");
    expect(r.replyText).toBe(`[AI assistant] ${reply}`);
    const result = r.trace.find((t) => t.checkpoint?.kind === "tool_result")!.checkpoint!.result as { output: { price: Record<string, unknown> } };
    expect(result.output.price).toMatchObject({ priceCents: 10_200, listPriceCents: 12_000, discountId: "discount_1" });
    // The price the model saw came from the tool result.
    expect(JSON.stringify(client.calls[1].messages)).toContain("Cut plus beard is ₪102 on Tuesday, normally ₪120");
    const verdicts = r.trace.filter((t) => t.checkpoint?.kind === "verifier");
    expect(verdicts.map((t) => t.checkpoint!.pass)).toEqual([true, true]);
    expect(verdicts[1].checkpoint!.checks).toContainEqual(expect.objectContaining({ rule: "discount_condition", claim: "Cut plus beard ₪102 on tue", pass: true }));
  });

  it("the discounted price on a non-discount day is still blocked by the unchanged verifier", async () => {
    const s = await cedarStore();
    const { deps: d } = deps(s, [
      call("check_availability", { date: WEDNESDAY, service: "cut_plus_beard" }),
      final("Wednesday 10:00 is open, Cut plus beard is ₪102."),
      final("Wednesday 10:00 is open, Cut plus beard is ₪120."),
    ]);
    const r = await handleInbound(inbound("Wednesday 10:00 for a cut plus beard?", "e2"), d);
    expect(r.replyText).toBe("[AI assistant] Wednesday 10:00 is open, Cut plus beard is ₪120.");
    const blocked = r.trace.find((t) => t.checkpoint?.kind === "verifier" && t.checkpoint.pass === false)!;
    expect(blocked.checkpoint!.checks).toContainEqual(expect.objectContaining({ rule: "discount_condition", pass: false }));
  });

  it("the system prompt tells the model to quote price.quote and never calculate", async () => {
    const s = await cedarStore();
    const { client, deps: d } = deps(s, [final("Hi.")]);
    await handleInbound(inbound("hi", "e3"), d);
    const system = client.calls[0].messages[0].content as string;
    expect(system).toContain("price.quote");
    expect(system).toContain("Never calculate a price yourself.");
  });
});

describe("Hebrew", () => {
  const TUE_AVAIL: AvailabilityResult = {
    date: TUESDAY,
    weekday: "tue",
    service: { id: "cut_plus_beard", name: "Cut plus beard", durationMin: 50, priceCents: 12_000 },
    price: priceQuote(CEDAR_BRAIN, CUT_BEARD, "tue"),
    slots: [{ slot: `${TUESDAY}T10:00`, time: "10:00", startsAt: "2026-11-03T08:00:00.000Z" }],
  };
  const facts = (over: Partial<Facts> = {}): Facts => ({ brain: CEDAR_BRAIN, availability: TUE_AVAIL, bookings: [], ...over });
  const failed = (text: string, f = facts()) => verifyText(text, f).checks.filter((c) => !c.pass);

  it("the prompt names the languages and the Hebrew service names", () => {
    const p = brainFacts(CEDAR_BRAIN, 1);
    expect(p).toContain("Languages: English, Hebrew.");
    expect(p).toContain("- Cut plus beard (Hebrew: תספורת וזקן): ₪120, 50 min");
    expect(p).toContain("In Hebrew: use the Hebrew service names");
    expect(brainFacts({ ...CEDAR_BRAIN, languages: ["en", "he"] }, 1)).toContain("Languages: English, Hebrew.");
  });

  it("verifier: a Hebrew price is bound to the Hebrew service name and its day", () => {
    const ok = verifyText("ביום שלישי ב-10:00 יש מקום. תספורת וזקן ב-₪102 ביום שלישי, במקום ₪120.", facts());
    expect(ok.pass).toBe(true);
    expect(ok.checks).toContainEqual(expect.objectContaining({ rule: "discount_condition", claim: "Cut plus beard ₪102 on tue", pass: true }));
    expect(verifyText("תספורת קלאסית 80 ש״ח, סידור זקן 50 שקלים.", facts()).checks.filter((c) => c.rule === "service_price").map((c) => c.claim)).toEqual([
      "Classic cut 80 ש״ח",
      "Beard trim 50 שקלים",
    ]);
  });

  it("verifier: wrong Hebrew prices, days, discounts, durations are blocked", () => {
    expect(failed("תספורת וזקן ב-102 ש\"ח ביום רביעי.")).toEqual([expect.objectContaining({ rule: "discount_condition" })]);
    expect(failed("בשלישי, תספורת וזקן ב-₪102.").length).toBe(0);
    expect(failed("תספורת קלאסית ב-95 ש״ח.")).toEqual([expect.objectContaining({ rule: "price" })]);
    expect(failed("תספורת קלאסית ב-₪120.")).toEqual([expect.objectContaining({ rule: "service_price" })]);
    expect(failed("אפשר לתת לך 50 אחוז הנחה.")).toEqual([expect.objectContaining({ rule: "discount" })]);
    expect(failed("יש לנו 15% הנחה ביום שלישי.").length).toBe(0);
    expect(failed("תספורת וזקן לוקחת 45 דקות.")).toEqual([expect.objectContaining({ rule: "duration" })]);
    expect(failed("תספורת וזקן לוקחת 50 דקות.").length).toBe(0);
    expect(failed("יש מקום ב-11:15.")).toEqual([expect.objectContaining({ rule: "time" })]);
  });

  it("verifier: a Hebrew booking claim without a confirmed booking is blocked; negated or conditional passes", () => {
    for (const claim of ["התור שלך אושר!", "מעולה, קבעתי לך ליום שלישי.", "התור נקבע.", "התור שלך שמור."]) {
      expect(failed(claim), claim).toEqual([expect.objectContaining({ rule: "booking_claim" })]);
    }
    for (const ok of [
      "שלחתי את הבקשה לבעל העסק. התור עדיין לא מאושר.",
      "התור יהיה מאושר רק אחרי שבעל העסק יאשר.",
      "כשבעל העסק יאשר, התור נקבע.",
      "התור נקבע רק לאחר אישור בעל העסק.",
    ]) {
      expect(failed(ok), ok).toEqual([]);
    }
    const confirmedBooking = { status: "confirmed" } as Facts["bookings"][number];
    expect(failed("התור שלך אושר!", facts({ bookings: [confirmedBooking] }))).toEqual([]);
  });

  it("verifier: a Hebrew promise to check later is a protocol leak", () => {
    expect(failed("רגע, אבדוק ואחזור אליך.").map((c) => c.rule)).toEqual(["protocol_leak"]);
    expect(failed("תן לי לבדוק את זה.").map((c) => c.rule)).toEqual(["protocol_leak"]);
  });

  it("services resolve by Hebrew name; local names survive a stored-brain upgrade", async () => {
    expect(resolveService(CEDAR_BRAIN, "תספורת וזקן").id).toBe("cut_plus_beard");
    expect(upgradeBrain(JSON.parse(JSON.stringify(CEDAR_BRAIN))).services[3].localNames).toEqual({ he: "תספורת וזקן" });
  });

  it("the AI disclosure follows the reply's script so Hebrew renders right to left", () => {
    expect(disclosureFor("שלום")).toBe("[עוזר AI] ");
    expect(disclosureFor("₪102 ביום שלישי")).toBe("[עוזר AI] ");
    expect(disclosureFor("Hello")).toBe("[AI assistant] ");
  });

  it("a Hebrew conversation: services list, then a Tuesday slot with the discounted price", async () => {
    const s = await cedarStore();
    const list = "אנחנו מציעים: תספורת קלאסית ₪80 (30 דקות), סקין פייד ₪90 (40 דקות), סידור זקן ₪50 (20 דקות), תספורת וזקן ₪120 (50 דקות). בימי שלישי תספורת וזקן ב-15% הנחה.";
    const slot = "כן, ביום שלישי ב-10:00 יש מקום. תספורת וזקן ב-₪102 ביום שלישי, במקום ₪120. לשלוח בקשה לבעל העסק?";
    const { client, deps: d } = deps(s, [final(list), call("check_availability", { date: TUESDAY, service: "cut_plus_beard" }), final(slot)]);

    const r1 = await handleInbound(inbound("מה אתם מציעים?", "h1"), d);
    expect(r1.replyText).toBe(`[עוזר AI] ${list}`);
    const v1 = r1.trace.find((t) => t.checkpoint?.kind === "verifier")!.checkpoint!;
    expect(v1.pass).toBe(true);
    expect((v1.checks as Array<{ rule: string; claim: string }>).filter((c) => c.rule === "service_price").map((c) => c.claim)).toEqual([
      "Classic cut ₪80", "Skin fade ₪90", "Beard trim ₪50", "Cut plus beard ₪120",
    ]);

    const r2 = await handleInbound(inbound("יש לכם ביום שלישי ב-10:00 תספורת וזקן?", "h2"), d);
    expect(r2.replyText).toBe(`[עוזר AI] ${slot}`);
    expect(r2.trace.filter((t) => t.checkpoint?.kind === "verifier").every((t) => t.checkpoint!.pass)).toBe(true);
    expect(JSON.stringify(client.calls[0].messages[0])).toContain("Reply in the language of the customer's latest message");
  });

  it("a Hebrew booking request, approved and rejected by the owner, is answered in Hebrew", async () => {
    const s = await cedarStore();
    const book = (slot: string) => ({ service: "cut_plus_beard", slot, customer_name: "דנה", customer_contact: "050-0000000" });
    const { deps: d } = deps(s, [
      call("check_availability", { date: TUESDAY, service: "cut_plus_beard" }),
      call("request_booking", book(`${TUESDAY}T10:00`)),
      final("שלחתי את הבקשה לבעל העסק. התור עדיין לא מאושר."),
      call("check_availability", { date: TUESDAY, service: "cut_plus_beard" }),
      call("request_booking", book(`${TUESDAY}T12:00`)),
      final("שלחתי גם את הבקשה הזו לבעל העסק לאישור."),
    ]);
    const first = await handleInbound(inbound("תקבע לי ביום שלישי ב-10:00 תספורת וזקן, דנה 050-0000000", "b1"), d);
    const second = await handleInbound(inbound("ואפשר גם ב-12:00?", "b2"), d);
    const [b1, b2] = await s.listBookings(SEED_BUSINESS_ID);
    expect(b1).toMatchObject({ status: "pending_approval", priceCents: 10_200 });
    const ok = await decideBooking(s, first.pendingApprovalId!, "approved", async () => ({ ok: true }) as never);
    expect(ok.replyText).toBe("התור שלך לתספורת וזקן ביום שלישי, 3 בנובמבר בשעה 10:00 אושר. נתראה!");
    const no = await decideBooking(s, second.pendingApprovalId!, "rejected", async () => ({ ok: true }) as never);
    expect(no.replyText).toBe("מצטערים, התור לתספורת וזקן ביום שלישי, 3 בנובמבר בשעה 12:00 לא זמין בסוף. לבדוק לך מועד אחר?");
    expect(b2.status).toBe("pending_approval");
  });

  it("a Hebrew customer handed to the owner gets the hand-off notice in Hebrew", async () => {
    const s = await cedarStore();
    const r = await handleInbound(inbound("שלום, אפשר לדבר עם מישהו?", "h3"), { store: s, gateway: null, gatewayError: "test", model: MOCK_MODEL, now: () => DEMO_CLOCK });
    expect(r.outcome).toBe("model_unavailable");
    expect(r.replyText).toBe("[עוזר AI] תודה, העברתי את זה לצוות ומישהו יחזור אליך בקרוב.");
  });

  it("availability for a Hebrew-named service on a Tuesday carries the code-computed discount", async () => {
    const s = await cedarStore();
    const ctx = { store: s, businessId: SEED_BUSINESS_ID, conversationId: "c", customerRef: "x", now: () => DEMO_CLOCK } as never;
    const a = await availability(ctx, CEDAR_BRAIN, TUESDAY, resolveService(CEDAR_BRAIN, "תספורת וזקן"));
    expect(a.price).toMatchObject({ priceCents: 10_200, listPriceCents: 12_000 });
    expect(a.slots.some((x) => x.time === "10:00")).toBe(true);
  });
});
