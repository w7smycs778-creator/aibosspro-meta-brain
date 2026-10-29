// Day 3B1: conversation engine, verifier, tools, owner actions, tool protocol.
// Mock model client and stubbed fetch only; no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MetaDispatcher } from "../gateway/meta-dispatcher";
import { MOCK_MODEL, MOCK_PRICES, MockModelClient, type ScriptedStep } from "../gateway/mock-client";
import { usdToNano } from "../gateway/money";
import { decodeJsonMode } from "../gateway/tool-protocol";
import { LocalStore } from "../storage/local-store";
import { SEED_BRAIN, SEED_BUSINESS_ID } from "../storage/seed";
import { handleInbound } from "./conversation-service";
import { runDemo, traceLines } from "./demo-run";
import { DEMO_CLOCK, DEMO_DATE } from "./demo-script";
import { decideBooking, setMode } from "./owner";
import { availability, type AvailabilityResult } from "./tools";
import { verifyText, verifyToolCall, type Facts } from "./verifier";

const dirs: string[] = [];
const stores: LocalStore[] = [];
function store(): LocalStore {
  const d = mkdtempSync(join(tmpdir(), "meta-brain-b1-"));
  dirs.push(d);
  const s = LocalStore.open(d);
  stores.push(s);
  return s;
}
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function deps(s: LocalStore, script: ScriptedStep[]) {
  const client = new MockModelClient(script);
  const gateway = new SpendGateway({
    ledger: new StoreSpendLedger(s, { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) }),
    dispatcher: client,
    prices: MOCK_PRICES,
  });
  return { client, deps: { store: s, gateway, model: MOCK_MODEL, now: () => DEMO_CLOCK } };
}

const inbound = (text: string, eventId: string, channel: "panel" | "whatsapp" = "panel", externalId = "panel-t") => ({
  businessId: SEED_BUSINESS_ID,
  channel,
  externalConversationId: externalId,
  senderId: externalId,
  text,
  externalEventId: eventId,
});

const final = (text: string): ScriptedStep => ({ raw: JSON.stringify({ type: "final", text }) });
const call = (name: string, args: Record<string, unknown> = {}): ScriptedStep => ({ raw: JSON.stringify({ type: "tool_call", name, args }) });

const AVAIL: AvailabilityResult = {
  date: DEMO_DATE,
  weekday: "thu",
  service: { id: "cut_and_beard", name: "Cut + beard", durationMin: 45, priceCents: 5000 },
  price: { priceCents: 5000, currency: "USD", discountId: null },
  slots: [{ slot: `${DEMO_DATE}T10:00`, time: "10:00", startsAt: "2026-11-05T08:00:00.000Z" }],
};
const facts = (over: Partial<Facts> = {}): Facts => ({ brain: SEED_BRAIN, availability: AVAIL, bookings: [], ...over });

describe("Step 7a mock run", () => {
  it("demo path ends at a pending booking and approval; 50% off is blocked and corrected", async () => {
    const s = store();
    const { results, client } = await runDemo(s);
    expect(results.map((r) => r.outcome)).toEqual(["final", "final", "final", "final"]);
    expect(client.remaining).toBe(0);

    const conversationId = results[0].conversationId!;
    const turns = await s.listTurns(conversationId);
    const [booking] = await s.listBookings(SEED_BUSINESS_ID);
    expect(booking).toMatchObject({ serviceId: "cut_and_beard", status: "pending_approval", customerName: "Dana", startsAt: "2026-11-05T08:00:00.000Z" });
    expect(results[2].pendingApprovalId).toBe(booking.approvalId);
    expect(await s.getApproval(booking.approvalId!)).toMatchObject({ kind: "booking", status: "pending" });

    const verdicts = turns.filter((t) => t.checkpoint?.kind === "verifier").map((t) => t.checkpoint!.pass);
    expect(verdicts.filter((p) => p === false)).toHaveLength(1);
    const blocked = turns.find((t) => t.checkpoint?.kind === "verifier" && t.checkpoint.pass === false)!;
    expect(blocked.checkpoint!.checks).toEqual([expect.objectContaining({ rule: "discount", claim: "50%", pass: false })]);
    expect(results[3].replyText).toContain("10% off Cut + beard on Tuesdays");
    expect(results[3].replyText).not.toContain("50%");
    expect(results[3].replyText!.startsWith("[AI assistant] ")).toBe(true);
    expect(traceLines(turns).some((l) => l.includes("BLOCK"))).toBe(true);
    expect((await s.listSpend()).length).toBe(8);
  });
});

describe("verifier", () => {
  it("rejects an unlisted price and a wrong price for a named service", () => {
    expect(verifyText("A Classic cut is $35.", facts()).pass).toBe(true);
    const unlisted = verifyText("Beard trim is just $12 today.", facts());
    expect(unlisted.pass).toBe(false);
    expect(unlisted.checks).toEqual([expect.objectContaining({ rule: "price", claim: "$12", pass: false })]);
    const mismatched = verifyText("Classic cut ($50)", facts());
    expect(mismatched.checks).toEqual([expect.objectContaining({ rule: "service_price", pass: false })]);
  });

  // Live run 2026-10-29: $25 (Kids cut) was credited to "Cut + beard" by proximity and a correct reply was blocked.
  const MESSAGE_1 = (kids: string) =>
    `We offer:\n- Classic cut, 30 min, $35\n- Beard trim, 15 min, $20\n- Cut + beard, 45 min, $50\n- ${kids}, 20 min, $25\n\n10% off Cut + beard on Tuesdays.`;

  it("regression: the message-1 list passes with and without the (under 12) qualifier", () => {
    for (const kids of ["Kids cut (under 12)", "Kids cut", "kids cut"]) {
      const v = verifyText(MESSAGE_1(kids), facts());
      expect(v.pass, kids).toBe(true);
      expect(v.checks.filter((c) => c.rule === "service_price").map((c) => c.claim)).toEqual([
        "Classic cut $35", "Beard trim $20", "Cut + beard $50", "Kids cut (under 12) $25",
      ]);
    }
  });

  it("a listed price with no unambiguous service is inconclusive, not a block", () => {
    const v = verifyText(MESSAGE_1("Junior trim"), facts());
    expect(v.pass).toBe(true);
    expect(v.checks).toContainEqual(expect.objectContaining({ claim: "$25", inconclusive: true, pass: true }));
  });

  it("still blocks a wrong price bound to a service, an unlisted price and an unlisted discount", () => {
    expect(verifyText("Cut + beard is $25.", facts()).checks).toContainEqual(
      expect.objectContaining({ rule: "service_price", claim: "Cut + beard $25", pass: false }),
    );
    expect(verifyText("- Cut + beard, 45 min, $25", facts()).pass).toBe(false);
    expect(verifyText("A Classic cut is $15 today.", facts()).checks).toContainEqual(expect.objectContaining({ rule: "price", claim: "$15", pass: false }));
    expect(verifyText("Sure, 50% off.", facts()).checks).toContainEqual(expect.objectContaining({ rule: "discount", claim: "50%", pass: false }));
  });

  it("stores the candidate text in every verifier checkpoint, pass or fail", async () => {
    const s = store();
    await s.reset();
    const { deps: d } = deps(s, [final("Cut + beard is $25."), final("Cut + beard is $50.")]);
    const r = await handleInbound(inbound("price?", "cand-1"), d);
    expect(r.outcome).toBe("final");
    const verdicts = r.trace.filter((t) => t.checkpoint?.kind === "verifier").map((t) => t.checkpoint!);
    expect(verdicts).toEqual([
      expect.objectContaining({ pass: false, candidate: { text: "Cut + beard is $25." } }),
      expect.objectContaining({ pass: true, candidate: { text: "Cut + beard is $50." } }),
    ]);
  });

  it("leak guard blocks \"I'll check Thursday\", corrects, and the turn reaches a tool call", async () => {
    const s = store();
    await s.reset();
    const { deps: d } = deps(s, [
      final("I'll check Thursday for you."),
      call("check_availability", { date: DEMO_DATE, service: "cut_and_beard" }),
      final("Thursday Nov 5 at 10:00 is open for Cut + beard."),
    ]);
    const r = await handleInbound(inbound("Thursday 10:00 for a Cut + beard?", "leak-1"), d);
    expect(r.outcome).toBe("final");
    expect(r.replyText).toBe("[AI assistant] Thursday Nov 5 at 10:00 is open for Cut + beard.");
    const first = r.trace.find((t) => t.checkpoint?.kind === "verifier")!.checkpoint!;
    expect(first).toMatchObject({ pass: false, candidate: { text: "I'll check Thursday for you." } });
    expect(first.checks).toContainEqual(expect.objectContaining({ rule: "protocol_leak", claim: "I'll check", pass: false }));
  });

  it("leak guard blocks protocol talk and JSON fragments; a second leak goes to the owner", async () => {
    // The live leak text: protocol talk plus a JSON fragment (one check per matching pattern).
    expect(
      verifyText('Need to output tool call but format requires final? {"type":"tool_call"}', facts())
        .checks.filter((c) => c.rule === "protocol_leak")
        .map((c) => c.detail),
    ).toEqual(["reply talks about the tool protocol; call the tool directly", "reply contains a JSON fragment; call the tool directly"]);
    expect(verifyText("See you Thursday. Let me know if anything changes.", facts()).pass).toBe(true);
    const s = store();
    await s.reset();
    const { deps: d } = deps(s, [final("Let me check that."), final("I will look into it.")]);
    const r = await handleInbound(inbound("?", "leak-2"), d);
    expect(r).toMatchObject({ outcome: "owner_help", state: "owner_help" });
  });

  it("stores tool arguments as the candidate for a tool-call check", async () => {
    const s = store();
    await s.reset();
    const { deps: d } = deps(s, [call("get_hours"), final("We open at 09:00.")]);
    const r = await handleInbound(inbound("hours?", "cand-2"), d);
    const first = r.trace.find((t) => t.checkpoint?.kind === "verifier")!.checkpoint!;
    expect(first).toMatchObject({ target: "get_hours", candidate: { tool: "get_hours", args: {} } });
  });

  it("rejects a slot not in the latest availability, in text and in request_booking", () => {
    expect(verifyText("Thursday at 10:00 is open.", facts()).pass).toBe(true);
    expect(verifyText("Thursday at 11:30 is open.", facts()).pass).toBe(false);
    expect(verifyText("We open at 09:00 and close at 20:00 on Thursdays.", facts()).pass).toBe(true);
    const args = { service: "cut_and_beard", customer_name: "Dana", customer_contact: "x" };
    expect(verifyToolCall({ id: "c", name: "request_booking", arguments: { ...args, slot: `${DEMO_DATE}T10:00` } }, facts()).pass).toBe(true);
    const off = verifyToolCall({ id: "c", name: "request_booking", arguments: { ...args, slot: `${DEMO_DATE}T11:30` } }, facts());
    expect(off.checks).toEqual([expect.objectContaining({ rule: "booking_slot", pass: false, detail: "slot is not in the latest availability result" })]);
    expect(verifyToolCall({ id: "c", name: "request_booking", arguments: { ...args, slot: `${DEMO_DATE}T10:00` } }, facts({ availability: null })).pass).toBe(false);
  });

  it("allows a booking claim only when a CONFIRMED booking exists; negated claims pass", () => {
    expect(verifyText("You're booked for Thursday.", facts()).pass).toBe(false);
    expect(verifyText("It is not confirmed until the owner approves.", facts()).pass).toBe(true);
    const confirmed = { status: "confirmed" } as Facts["bookings"][number];
    expect(verifyText("You're booked for Thursday.", facts({ bookings: [confirmed] })).pass).toBe(true);
  });

  it("a second block hands the turn to the owner with the failing claim recorded", async () => {
    const s = store();
    await s.reset();
    const { deps: d } = deps(s, [final("Sure, 50% off."), final("Fine, 40% off then.")]);
    const r = await handleInbound(inbound("50% off?", "e1"), d);
    expect(r.outcome).toBe("owner_help");
    expect(r.state).toBe("owner_help");
    const help = r.trace.find((t) => t.checkpoint?.kind === "owner_help")!;
    expect(help.checkpoint).toMatchObject({ reason: "verifier_blocked" });
    expect(String(help.checkpoint!.detail)).toContain("40%");
    expect(r.trace.some((t) => t.checkpoint?.kind === "tool_result" && (t.checkpoint.toolCall as { name: string }).name === "request_owner_help")).toBe(true);
    expect(r.replyText).toContain("passed this to the team");
  });
});

describe("conversation service", () => {
  it("processes a duplicate panel event once", async () => {
    const s = store();
    await s.reset();
    const { client, deps: d } = deps(s, [final("Hello."), final("never used")]);
    const first = await handleInbound(inbound("hi", "evt-1"), d);
    const second = await handleInbound(inbound("hi", "evt-1"), d);
    expect(first.replyText).toBe("[AI assistant] Hello.");
    expect(second).toMatchObject({ duplicate: true, replyText: null });
    expect(client.calls).toHaveLength(1);
    expect((await s.listTurns(first.conversationId!)).filter((t) => t.role === "customer")).toHaveLength(1);
  });

  it("panel conversations start in AUTO, WhatsApp in the business default (HUMAN here); the owner switch persists", async () => {
    const s = store();
    await s.reset();
    await s.updateBusinessSettings(SEED_BUSINESS_ID, { whatsappDefaultMode: "HUMAN" });
    const { deps: d } = deps(s, [final("Hi."), final("Hi.")]);
    const panel = await handleInbound(inbound("hi", "p1"), d);
    const wa = await handleInbound(inbound("hi", "w1", "whatsapp", "15550000002"), d);
    expect(panel.mode).toBe("AUTO");
    expect(wa.mode).toBe("HUMAN");
    await setMode(s, wa.conversationId!, "PAUSED");
    expect((await s.getConversation(wa.conversationId!))!.mode).toBe("PAUSED");
    const paused = await handleInbound(inbound("anyone?", "w2", "whatsapp", "15550000002"), d);
    expect(paused).toMatchObject({ outcome: "not_active", replyText: null });
  });
});

describe("owner decisions", () => {
  it("approve flips PENDING to CONFIRMED; a second approve is a no-op", async () => {
    const s = store();
    const { results } = await runDemo(s);
    const approvalId = results[2].pendingApprovalId!;
    const first = await decideBooking(s, approvalId, "approved");
    expect(first).toMatchObject({ changed: true, approval: { status: "approved" }, booking: { status: "confirmed" } });
    expect(first.replyText).toContain("is confirmed");
    const second = await decideBooking(s, approvalId, "approved");
    expect(second).toMatchObject({ changed: false, replyText: null, booking: { status: "confirmed" } });
    const rejectAfter = await decideBooking(s, approvalId, "rejected");
    expect(rejectAfter).toMatchObject({ changed: false, booking: { status: "confirmed" } });
    const decisions = (await s.listTurns(results[0].conversationId!)).filter((t) => t.checkpoint?.kind === "owner_decision");
    expect(decisions).toHaveLength(1);
  });

  it("reject flips PENDING to REJECTED and sends a reply offering another time", async () => {
    const s = store();
    const { results } = await runDemo(s);
    const r = await decideBooking(s, results[2].pendingApprovalId!, "rejected");
    expect(r).toMatchObject({ changed: true, booking: { status: "rejected" } });
    expect(r.replyText).toContain("another time");
    const turns = await s.listTurns(results[0].conversationId!);
    const reply = turns.find((t) => t.checkpoint?.kind === "owner_decision")!;
    expect(reply.checkpoint).toMatchObject({ decision: "rejected", delivery: "pending" });
    expect(turns.find((t) => t.checkpoint?.kind === "outbound_result" && t.checkpoint.outboundTurnId === reply.id)?.checkpoint).toMatchObject({ status: "sent" });
  });
});

describe("availability tool", () => {
  it("excludes past times and slots overlapping pending or confirmed bookings", async () => {
    const s = store();
    await s.reset();
    const ctx = { store: s, businessId: SEED_BUSINESS_ID, conversationId: "", customerRef: "", now: () => DEMO_CLOCK };
    const cut = SEED_BRAIN.services.find((x) => x.id === "classic_cut")!;
    const before = await availability(ctx, SEED_BRAIN, DEMO_DATE, cut);
    expect(before.slots[0].time).toBe("09:00");
    expect(before.slots.at(-1)!.time).toBe("19:30");
    await s.requestBooking({ businessId: SEED_BUSINESS_ID, conversationId: null, serviceId: "cut_and_beard", customerRef: "x", startsAt: "2026-11-05T08:00:00.000Z" });
    const after = await availability(ctx, SEED_BRAIN, DEMO_DATE, cut);
    // 10:00-10:45 Asia/Jerusalem (08:00Z) is taken: 10:00 and 10:30 starts overlap it.
    expect(after.slots.map((x) => x.time)).not.toContain("10:00");
    expect(after.slots.map((x) => x.time)).not.toContain("10:30");
    expect(after.slots.map((x) => x.time)).toContain("09:30");
    expect((await availability(ctx, SEED_BRAIN, "2026-10-28", cut)).slots).toEqual([]);
    expect((await availability(ctx, SEED_BRAIN, "2026-11-08", cut)).slots).toEqual([]); // Sunday, closed
  });
});

describe("tool protocol", () => {
  it("decodes fenced and prose-wrapped JSON and rejects malformed replies", () => {
    expect(decodeJsonMode('```json\n{"type":"final","text":"hi"}\n```')).toMatchObject({ ok: true, text: "hi" });
    expect(decodeJsonMode('Here: {"type":"tool_call","name":"get_hours","args":{}} done')).toMatchObject({ ok: true, toolCalls: [{ name: "get_hours" }] });
    expect(decodeJsonMode("Sure!")).toMatchObject({ ok: false });
    expect(decodeJsonMode('{"type":"final"}')).toMatchObject({ ok: false });
    expect(decodeJsonMode('{"type":"tool_call","name":"x","args":[1]}')).toMatchObject({ ok: false });
  });

  const env = { MODEL_API_BASE_URL: "https://api.meta.ai/v1", MODEL_API_KEY: "test-placeholder", LIVE_CREDITS_VERIFIED: "true" };
  const tools = [{ name: "get_hours", description: "Hours.", parameters: { type: "object" as const, properties: {} } }];
  const chatCall = {
    kind: "chat" as const,
    model: "muse-spark-1.3",
    maxOutputTokens: 100,
    tools,
    messages: [
      { role: "system" as const, content: "You are a test." },
      { role: "user" as const, content: "hours?" },
    ],
  };
  const reply = (content: string, extra: Record<string, unknown> = {}) =>
    vi.fn(async (_u: string, _i?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content, ...extra } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200 }),
    );

  it("json mode (default): tools go in the system prompt, the reply is parsed into a tool call", async () => {
    const fetchSpy = reply('{"type":"tool_call","name":"get_hours","args":{}}');
    const r = await new MetaDispatcher(env, fetchSpy as unknown as typeof fetch).dispatch(chatCall);
    const sent = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(sent.tools).toBeUndefined();
    expect(sent.messages[0].content).toContain('"type":"tool_call"');
    expect(sent.messages[0].content).toContain("get_hours");
    expect(r.toolCalls).toEqual([expect.objectContaining({ name: "get_hours", arguments: {} })]);
  });

  it("json mode reports a protocol error for non-JSON replies", async () => {
    const r = await new MetaDispatcher(env, reply("I'd love to help!") as unknown as typeof fetch).dispatch(chatCall);
    expect(r).toMatchObject({ ok: true, protocolError: "reply is not a JSON object", output: "I'd love to help!" });
  });

  it("native mode sends OpenAI-style tools and reads tool_calls", async () => {
    const fetchSpy = reply("", { tool_calls: [{ id: "t1", type: "function", function: { name: "get_hours", arguments: "{}" } }] });
    const r = await new MetaDispatcher({ ...env, MODEL_TOOL_MODE: "native" }, fetchSpy as unknown as typeof fetch).dispatch(chatCall);
    const sent = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(sent.tools).toEqual([{ type: "function", function: { name: "get_hours", description: "Hours.", parameters: { type: "object", properties: {} } } }]);
    expect(sent.tool_choice).toBe("auto");
    expect(sent.response_format).toBeUndefined();
    expect(r.toolCalls).toEqual([{ id: "t1", name: "get_hours", arguments: {} }]);
  });
});
