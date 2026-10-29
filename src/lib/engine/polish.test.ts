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
import { brainFacts } from "./brain-prompt";
import { handleInbound } from "./conversation-service";
import { DEMO_CLOCK } from "./demo-script";
import { priceQuote } from "./tools";

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
  await s.reset();
  const draft = await s.addBrainVersion(SEED_BUSINESS_ID, CEDAR_BRAIN, { kind: "seed", text: null, audioPath: null });
  await s.approveBrainVersion(SEED_BUSINESS_ID, draft.version);
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
