// Friday gate pulled forward: takeover, discount conditions, restart-safe
// resume, owner decision replies. Mock model client and stub senders only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MOCK_MODEL, MOCK_PRICES, MockModelClient, type ScriptedStep } from "../gateway/mock-client";
import { usdToNano } from "../gateway/money";
import type { DispatchResult, Dispatcher, ModelCall } from "../gateway/types";
import { SlotTakenError } from "../storage/errors";
import { LocalStore } from "../storage/local-store";
import { SEED_BRAIN, SEED_BUSINESS_ID } from "../storage/seed";
import type { BusinessBrain, Conversation, NewTurn, Storage } from "../storage/types";
import { handleInbound } from "./conversation-service";
import { DEMO_CLOCK } from "./demo-script";
import type { Deliver } from "./delivery";
import type { EngineDeps } from "./deps";
import { decideBooking, sendOwnerMessage, setMode } from "./owner";
import { resumeConversation } from "./resume";
import { requestBookingTool } from "./tools";
import { verifyText, type Facts } from "./verifier";

const whatsapp = vi.hoisted(() => ({ sendText: vi.fn() }));
vi.mock("../whatsapp/send", () => whatsapp);

const dirs: string[] = [];
const stores: LocalStore[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "meta-brain-friday-"));
  dirs.push(d);
  return d;
}
function open(d: string): LocalStore {
  const s = LocalStore.open(d);
  stores.push(s);
  return s;
}
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  whatsapp.sendText.mockReset();
});

/** The seed brain with the Tuesday rule at 15% (Cut + beard $50 -> $42.50). */
const BRAIN_15: BusinessBrain = {
  ...SEED_BRAIN,
  discounts: [{ ...SEED_BRAIN.discounts[0], description: "15% off Cut + beard on Tuesdays", percentOff: 15 }],
};
const TUESDAY = "2026-11-03";
const WEDNESDAY = "2026-11-04";

async function seeded(d = dir()): Promise<LocalStore> {
  const s = open(d);
  await s.reset();
  const v = await s.addBrainVersion(SEED_BUSINESS_ID, BRAIN_15);
  await s.approveBrainVersion(SEED_BUSINESS_ID, v.version);
  return s;
}

const LIMITS = { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) };
function deps(store: Storage, dispatcher: Dispatcher, deliver: Deliver): EngineDeps {
  return {
    store,
    gateway: new SpendGateway({ ledger: new StoreSpendLedger(store, LIMITS), dispatcher, prices: MOCK_PRICES }),
    model: MOCK_MODEL,
    now: () => DEMO_CLOCK,
    deliver,
  };
}
const recordingDeliver = () => {
  const sent: Array<{ channel: string; text: string }> = [];
  const deliver: Deliver = async (c, text) => {
    sent.push({ channel: c.channel, text });
    return { ok: true, status: 200, channel: c.channel };
  };
  return { sent, deliver };
};

const call = (name: string, args: Record<string, unknown> = {}): ScriptedStep => ({ toolCall: { name, arguments: args } });
const final = (text: string): ScriptedStep => ({ text });
const panel = (text: string, id: string, ext = "panel-friday") => ({ businessId: SEED_BUSINESS_ID, channel: "panel" as const, externalConversationId: ext, senderId: ext, text, externalEventId: id });
const BOOK = (date: string, name = "Dana") => ({ service: "cut_and_beard", slot: `${date}T10:00`, customer_name: name, customer_contact: "050-0000000" });

/** Runs a scripted step, then runs `after` (e.g. the owner taking over) before the engine sees the result. */
function scriptWithHook(script: ScriptedStep[], hookAt: number, after: () => Promise<void>): Dispatcher & { calls: number } {
  const inner = new MockModelClient(script);
  const d = {
    calls: 0,
    async dispatch(c: ModelCall): Promise<DispatchResult> {
      const r = await inner.dispatch(c);
      if (++d.calls === hookAt) await after();
      return r;
    },
  };
  return d;
}

describe("takeover", () => {
  it("mode flips to HUMAN between the model's tool call and its execution: no tool, no send, taken_over", async () => {
    const store = await seeded();
    const { sent, deliver } = recordingDeliver();
    let conversationId = "";
    const first = await handleInbound(panel("hi", "t0"), deps(store, new MockModelClient([final("Hello.")]), deliver));
    conversationId = first.conversationId!;
    sent.length = 0;

    const dispatcher = scriptWithHook(
      [call("check_availability", { date: TUESDAY, service: "cut_and_beard" }), call("request_booking", BOOK(TUESDAY)), final("Requested.")],
      2,
      async () => void (await setMode(store, conversationId, "HUMAN")),
    );
    const r = await handleInbound(panel("Book Tuesday 10:00", "t1"), deps(store, dispatcher, deliver));

    expect(r).toMatchObject({ outcome: "taken_over", replyText: null });
    expect(dispatcher.calls).toBe(2);
    expect(await store.listBookings(SEED_BUSINESS_ID)).toEqual([]);
    expect(r.trace.some((t) => t.checkpoint?.kind === "tool_pending" && (t.checkpoint.toolCall as { name: string }).name === "request_booking")).toBe(false);
    expect(r.trace.find((t) => t.checkpoint?.kind === "taken_over")?.checkpoint).toMatchObject({ point: "before_tool", reason: "mode is HUMAN" });
    expect(sent).toEqual([]);
  });

  it("an owner message during the model's final reply suppresses the send", async () => {
    const store = await seeded();
    const { sent, deliver } = recordingDeliver();
    const first = await handleInbound(panel("hi", "s0"), deps(store, new MockModelClient([final("Hello.")]), deliver));
    sent.length = 0;
    const dispatcher = scriptWithHook([final("We open at 09:00.")], 1, async () => {
      await sendOwnerMessage(store, first.conversationId!, "I'll answer this one myself.", deliver);
    });
    const r = await handleInbound(panel("When do you open?", "s1"), deps(store, dispatcher, deliver));
    expect(r).toMatchObject({ outcome: "taken_over", replyText: null, delivery: "suppressed" });
    expect(sent).toEqual([{ channel: "panel", text: "I'll answer this one myself." }]);
    expect(r.trace.find((t) => t.checkpoint?.kind === "taken_over")?.checkpoint).toMatchObject({ point: "before_send" });
  });

  it("after takeover the engine stays silent until AUTO, and AUTO does not catch up", async () => {
    const store = await seeded();
    const { deliver } = recordingDeliver();
    const first = await handleInbound(panel("hi", "a0"), deps(store, new MockModelClient([final("Hello.")]), deliver));
    await sendOwnerMessage(store, first.conversationId!, "Owner here.", deliver);
    const silent = new MockModelClient([final("never")]);
    expect(await handleInbound(panel("still there?", "a1"), deps(store, silent, deliver))).toMatchObject({ outcome: "not_active", replyText: null });
    expect(silent.calls).toHaveLength(0);
    await setMode(store, first.conversationId!, "AUTO");
    const back = new MockModelClient([final("Back with you.")]);
    expect(back.calls).toHaveLength(0);
    expect(await handleInbound(panel("ok?", "a2"), deps(store, back, deliver))).toMatchObject({ outcome: "final", replyText: "[AI assistant] Back with you." });
  });

  it("owner messages are persisted and sent on the conversation's channel (WhatsApp mocked)", async () => {
    whatsapp.sendText.mockResolvedValue({ ok: true, status: 200 });
    const store = await seeded();
    const wa = await store.createConversation({ businessId: SEED_BUSINESS_ID, channel: "whatsapp", externalId: "15550001111", customerRef: "15550001111", mode: "AUTO" });
    const pc = await store.createConversation({ businessId: SEED_BUSINESS_ID, channel: "panel", externalId: "panel-o", customerRef: "panel-o", mode: "AUTO" });

    const r = await sendOwnerMessage(store, wa.id, "Hi, it's the owner. Thursday works.");
    expect(whatsapp.sendText).toHaveBeenCalledWith("15550001111", "Hi, it's the owner. Thursday works.");
    expect(r.delivery).toMatchObject({ ok: true, channel: "whatsapp" });
    expect((await store.getConversation(wa.id))!.mode).toBe("HUMAN");
    const turns = await store.listTurns(wa.id);
    expect(turns[0]).toMatchObject({ role: "owner", content: "Hi, it's the owner. Thursday works." });
    expect(turns[1].checkpoint).toMatchObject({ kind: "outbound_result", outboundTurnId: turns[0].id, status: "sent" });

    await sendOwnerMessage(store, pc.id, "Panel reply.");
    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    expect((await store.listTurns(pc.id))[1].checkpoint).toMatchObject({ status: "sent" });
  });
});

describe("discount conditions", () => {
  const facts = (weekday: string, date: string): Facts => ({
    brain: BRAIN_15,
    availability: {
      date,
      weekday,
      service: { id: "cut_and_beard", name: "Cut + beard", durationMin: 45, priceCents: 5000 },
      price: { priceCents: weekday === "tue" ? 4250 : 5000, currency: "USD", discountId: weekday === "tue" ? "tuesday_combo" : null },
      slots: [{ slot: `${date}T10:00`, time: "10:00", startsAt: `${date}T08:00:00.000Z` }],
    },
    bookings: [],
  });

  it("15% applied to a Tuesday slot passes; the same price on a Wednesday slot fails; the rule statement passes", () => {
    expect(verifyText("Tuesday Nov 3 at 10:00, Cut + beard is $42.50 with our 15% Tuesday discount.", facts("tue", TUESDAY)).pass).toBe(true);
    const wed = verifyText("Wednesday Nov 4 at 10:00 is open, Cut + beard is $42.50.", facts("wed", WEDNESDAY));
    expect(wed.pass).toBe(false);
    expect(wed.checks).toContainEqual(expect.objectContaining({ rule: "discount_condition", pass: false }));
    // The day can come from the availability result when the sentence names its slot time.
    expect(verifyText("10:00 is open, Cut + beard is $42.50.", facts("wed", WEDNESDAY)).pass).toBe(false);
    expect(verifyText("I can do 15% off on Wednesday.", facts("wed", WEDNESDAY)).pass).toBe(false);
    expect(verifyText("We have 15% off Cut + beard on Tuesdays.", facts("wed", WEDNESDAY)).pass).toBe(true);
    expect(verifyText("Cut + beard is $50 on Wednesday.", facts("wed", WEDNESDAY)).pass).toBe(true);
  });

  it("request_booking computes the price: discounted on a qualifying day, list price otherwise", async () => {
    const store = await seeded();
    const ctx = async (ext: string) => {
      const c = await store.createConversation({ businessId: SEED_BUSINESS_ID, channel: "panel", externalId: ext, customerRef: ext, mode: "AUTO" });
      return { store, businessId: SEED_BUSINESS_ID, conversationId: c.id, customerRef: ext, now: () => DEMO_CLOCK };
    };
    const tue = (await requestBookingTool.execute(BOOK(TUESDAY), await ctx("panel-tue"))) as Record<string, unknown>;
    const wed = (await requestBookingTool.execute(BOOK(WEDNESDAY), await ctx("panel-wed"))) as Record<string, unknown>;
    expect(tue).toMatchObject({ priceCents: 4_250, currency: "USD", discountId: "tuesday_combo" });
    expect(wed).toMatchObject({ priceCents: 5_000, currency: "USD", discountId: null });
    const rows = await store.listBookings(SEED_BUSINESS_ID);
    expect(rows.map((b) => [b.startsAt.slice(0, 10), b.priceCents, b.discountId])).toEqual([
      [TUESDAY, 4_250, "tuesday_combo"],
      [WEDNESDAY, 5_000, null],
    ]);
  });
});

describe("restart-safe resume", () => {
  /** A store whose appendTurn dies at one checkpoint kind, like a process killed there. */
  function dying(store: LocalStore, kind: "tool_pending" | "tool_result", afterWrite: boolean): Storage {
    const proxy = Object.create(store) as LocalStore;
    proxy.appendTurn = async (input: NewTurn) => {
      const isBooking = (input.checkpoint?.toolCall as { name?: string } | undefined)?.name === "request_booking";
      if (input.checkpoint?.kind === kind && isBooking) {
        if (afterWrite) await store.appendTurn(input);
        throw new Error("process killed");
      }
      return store.appendTurn(input);
    };
    return proxy;
  }

  for (const [label, kind, afterWrite] of [
    ["after the booking was written, before its result was recorded", "tool_result", false],
    ["after the call was recorded, before the tool ran", "tool_pending", true],
  ] as const) {
    it(`killed ${label}: restart leaves exactly one booking and one pending approval`, async () => {
      const d = dir();
      const store = await seeded(d);
      const { deliver } = recordingDeliver();
      const script = [call("check_availability", { date: TUESDAY, service: "cut_and_beard" }), call("request_booking", BOOK(TUESDAY)), final("Requested.")];
      await expect(handleInbound(panel("Book Tuesday 10:00", "k1"), deps(dying(store, kind, afterWrite), new MockModelClient(script), deliver))).rejects.toThrow("process killed");
      await store.close();

      // Restart: a new process opens the same file and resumes.
      const restarted = open(d);
      const conversation = (await restarted.findConversation(SEED_BUSINESS_ID, "panel", "panel-friday"))!;
      const report = await resumeConversation({ store: restarted, deliver, now: () => DEMO_CLOCK }, conversation.id);
      expect(report.toolsResumed).toBe(1);
      expect(await restarted.listBookings(SEED_BUSINESS_ID)).toHaveLength(1);
      expect(await restarted.listPendingApprovals(SEED_BUSINESS_ID)).toHaveLength(1);
      const resumed = (await restarted.listTurns(conversation.id)).find((t) => t.checkpoint?.resumed);
      expect(resumed?.checkpoint).toMatchObject({ kind: "tool_result", result: { ok: true, output: { status: "pending_approval" } } });

      // A second resume, and the next customer message, change nothing.
      await resumeConversation({ store: restarted, deliver, now: () => DEMO_CLOCK }, conversation.id);
      await handleInbound(panel("thanks", "k2"), deps(restarted, new MockModelClient([final("You're welcome.")]), deliver));
      expect(await restarted.listBookings(SEED_BUSINESS_ID)).toHaveLength(1);
      expect(await restarted.listPendingApprovals(SEED_BUSINESS_ID)).toHaveLength(1);
    });
  }

  it("a reply left pending delivery is sent once on resume", async () => {
    const store = await seeded();
    const { sent, deliver } = recordingDeliver();
    const c = await store.createConversation({ businessId: SEED_BUSINESS_ID, channel: "panel", externalId: "panel-p", customerRef: "panel-p", mode: "AUTO" });
    await store.appendTurn({ conversationId: c.id, role: "system", content: "[AI assistant] Hi.", checkpoint: { kind: "outbound", text: "[AI assistant] Hi.", delivery: "pending" } });
    const first = await resumeConversation({ store, deliver, now: () => new Date() }, c.id);
    const second = await resumeConversation({ store, deliver, now: () => new Date() }, c.id);
    expect([first.sendsResumed, second.sendsResumed]).toEqual([1, 0]);
    expect(sent).toEqual([{ channel: "panel", text: "[AI assistant] Hi." }]);
  });

  it("request_booking is idempotent per conversation, service and slot", async () => {
    const store = await seeded();
    const c = await store.createConversation({ businessId: SEED_BUSINESS_ID, channel: "panel", externalId: "panel-i", customerRef: "panel-i", mode: "AUTO" });
    const ctx = { store, businessId: SEED_BUSINESS_ID, conversationId: c.id, customerRef: c.customerRef, now: () => DEMO_CLOCK };
    const a = (await requestBookingTool.execute(BOOK(TUESDAY), ctx)) as Record<string, unknown>;
    const b = (await requestBookingTool.execute(BOOK(TUESDAY), ctx)) as Record<string, unknown>;
    expect(b).toMatchObject({ bookingId: a.bookingId, approvalId: a.approvalId, existing: true });
    expect(await store.listBookings(SEED_BUSINESS_ID)).toHaveLength(1);
  });
});

describe("one booking per slot", () => {
  it("two conversations request the same slot: one pending booking, the second gets an availability failure", async () => {
    const store = await seeded();
    const { deliver } = recordingDeliver();
    const book = [call("request_booking", BOOK(TUESDAY)), final("Requested.")];
    // Both have seen the slot open in an earlier availability check.
    for (const ext of ["panel-a", "panel-b"]) {
      await handleInbound(panel("Tuesday?", `${ext}-0`, ext), deps(store, new MockModelClient([call("check_availability", { date: TUESDAY, service: "cut_and_beard" }), final("Tuesday 10:00 is open.")]), deliver));
    }
    await handleInbound(panel("Book it", "a-1", "panel-a"), deps(store, new MockModelClient(book), deliver));
    const second = await handleInbound(panel("Book it", "b-1", "panel-b"), deps(store, new MockModelClient([call("request_booking", BOOK(TUESDAY, "Sam")), final("Sorry, that time just went.")]), deliver));

    const rows = await store.listBookings(SEED_BUSINESS_ID);
    expect(rows.filter((b) => b.status === "pending_approval")).toHaveLength(1);
    expect(rows[0].customerName).toBe("Dana");
    const result = second.trace.find((t) => t.checkpoint?.kind === "tool_result")!.checkpoint!.result as { ok: boolean; error?: string };
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/not open|no longer available/);
  });

  it("the store refuses a second active booking at the same start time even when both pass the availability check", async () => {
    const store = await seeded();
    const base = { businessId: SEED_BUSINESS_ID, conversationId: null, serviceId: "cut_and_beard", customerRef: "x", startsAt: `${TUESDAY}T08:00:00.000Z` };
    await store.requestBooking({ ...base, idempotencyKey: "k-a" });
    await expect(store.requestBooking({ ...base, idempotencyKey: "k-b" })).rejects.toBeInstanceOf(SlotTakenError);
    expect(await store.listPendingApprovals(SEED_BUSINESS_ID)).toHaveLength(1);
    // A rejected booking frees the slot.
    const [approval] = await store.listPendingApprovals(SEED_BUSINESS_ID);
    await store.decideApproval(approval.id, "rejected");
    await expect(store.requestBooking({ ...base, idempotencyKey: "k-c" })).resolves.toMatchObject({ existing: false });
  });
});

describe("owner decision replies", () => {
  it("name the time with the zone abbreviation and go out on the conversation's channel", async () => {
    whatsapp.sendText.mockResolvedValue({ ok: true, status: 200 });
    const store = await seeded();
    const wa: Conversation = await store.createConversation({ businessId: SEED_BUSINESS_ID, channel: "whatsapp", externalId: "15550002222", customerRef: "15550002222", mode: "AUTO" });
    const ctx = { store, businessId: SEED_BUSINESS_ID, conversationId: wa.id, customerRef: wa.customerRef, now: () => DEMO_CLOCK };
    const booked = (await requestBookingTool.execute(BOOK(TUESDAY), ctx)) as { approvalId: string };

    const r = await decideBooking(store, booked.approvalId, "approved");
    expect(r.replyText).toBe("Good news: your Cut + beard on Tue, Nov 3, 10:00 IST is confirmed. See you then.");
    expect(whatsapp.sendText).toHaveBeenCalledWith("15550002222", r.replyText);
    expect(r.delivery).toMatchObject({ ok: true, channel: "whatsapp" });
    expect((await decideBooking(store, booked.approvalId, "approved")).changed).toBe(false);
    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);

    const ctx2 = { ...ctx, conversationId: (await store.createConversation({ businessId: SEED_BUSINESS_ID, channel: "panel", externalId: "panel-r", customerRef: "panel-r", mode: "AUTO" })).id };
    const second = (await requestBookingTool.execute(BOOK(WEDNESDAY), ctx2)) as { approvalId: string };
    const rejected = await decideBooking(store, second.approvalId, "rejected");
    expect(rejected.replyText).toBe("Sorry, the Cut + beard on Wed, Nov 4, 10:00 IST isn't available after all. Would you like me to check another time?");
    expect(rejected.delivery).toMatchObject({ ok: true, channel: "panel" });
  });
});
