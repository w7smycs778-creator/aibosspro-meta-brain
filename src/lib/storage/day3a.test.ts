// Day 3A: durable ledger, durable dedupe, tool loop, hosted-inference gate.
// Mock model client only; no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveGateway } from "../gateway";
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MockModelClient } from "../gateway/mock-client";
import { usdToNano } from "../gateway/money";
import type { PriceTable } from "../gateway/pricing";
import { runToolLoop } from "../gateway/tool-loop";
import { DEFAULT_TOOLS } from "../gateway/tools";
import { assertStartupConfig } from "../startup";
import { createStore, resolveBackend, SEED_BUSINESS_ID } from ".";
import { LocalStore } from "./local-store";

// "mock-chat" costs exactly $0.40 per call at 100 output tokens.
const MOCK_MODEL = "mock-chat";
const MOCK_PRICES: PriceTable = { [MOCK_MODEL]: { kind: "chat", inputPerToken: 0, cachedPerToken: 0, outputPerToken: 4_000_000 } };
const CALL_USAGE = { promptTokens: 20, completionTokens: 100 };

const dirs: string[] = [];
const open: LocalStore[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "meta-brain-3a-"));
  dirs.push(d);
  return d;
}
function openStore(dir: string): LocalStore {
  const s = LocalStore.open(dir);
  open.push(s);
  return s;
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const limits = (capUsd: number) => ({ hardCapNano: usdToNano(capUsd), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) });

function mockGateway(store: LocalStore, capUsd: number, script: ConstructorParameters<typeof MockModelClient>[0]) {
  const client = new MockModelClient(script, CALL_USAGE);
  const gateway = new SpendGateway({ ledger: new StoreSpendLedger(store, limits(capUsd)), dispatcher: client, prices: MOCK_PRICES });
  return { client, gateway };
}

const chat = (turnId: string) => ({
  kind: "chat" as const,
  model: MOCK_MODEL,
  messages: [{ role: "user" as const, content: "synthetic" }],
  maxOutputTokens: 100,
  businessId: SEED_BUSINESS_ID,
  turnId,
});

describe("durable spend ledger", () => {
  it("cap $1.00, three $0.40 calls: third refused, two rows persisted, survives reopen", async () => {
    const dir = tempDir();
    const store = openStore(dir);
    const script = [{ text: "one", usage: CALL_USAGE }, { text: "two", usage: CALL_USAGE }, { text: "three", usage: CALL_USAGE }];
    const { client, gateway } = mockGateway(store, 1, script);

    expect((await gateway.call(chat("t1"))).outcome).toBe("ok");
    expect((await gateway.call(chat("t2"))).outcome).toBe("ok");
    expect(await gateway.call(chat("t3"))).toMatchObject({ outcome: "denied", reason: "hard_cap_reached" });
    expect(client.calls).toHaveLength(2);

    const rows = await store.listSpend();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.state, r.settledNano, r.tokensIn, r.tokensOut, r.businessId, r.turnId, r.model])).toEqual([
      ["settled", usdToNano(0.4), 20, 100, SEED_BUSINESS_ID, "t1", MOCK_MODEL],
      ["settled", usdToNano(0.4), 20, 100, SEED_BUSINESS_ID, "t2", MOCK_MODEL],
    ]);
    await store.close();

    // New process, same file: the cap is read from the summed rows.
    const reopened = openStore(dir);
    expect(await reopened.listSpend()).toHaveLength(2);
    expect((await reopened.spendTotals()).settledNano).toBe(usdToNano(0.8));
    const after = mockGateway(reopened, 1, [{ text: "four", usage: CALL_USAGE }]);
    expect(await after.gateway.call(chat("t4"))).toMatchObject({ outcome: "denied", reason: "hard_cap_reached" });
    expect(after.client.calls).toHaveLength(0);
  });
});

describe("durable dedupe", () => {
  it("same event id twice is processed once, and stays processed after reopen", async () => {
    const dir = tempDir();
    const store = openStore(dir);
    expect(await store.claimEvent("whatsapp", "wamid.synthetic.1")).toBe(true);
    expect(await store.claimEvent("whatsapp", "wamid.synthetic.1")).toBe(false);
    expect(await store.claimEvent("whatsapp", "wamid.synthetic.2")).toBe(true);
    await store.close();

    const reopened = openStore(dir);
    expect(await reopened.claimEvent("whatsapp", "wamid.synthetic.1")).toBe(false);
    expect(await reopened.claimEvent("whatsapp", "wamid.synthetic.2")).toBe(false);
    expect(await reopened.claimEvent("whatsapp", "wamid.synthetic.3")).toBe(true);
  });
});

describe("tool-call loop", () => {
  async function setup(mode: "AUTO" | "HUMAN") {
    const store = openStore(tempDir());
    const { businessId } = await store.reset();
    const conversation = await store.createConversation({ businessId, channel: "whatsapp", customerRef: "cust_synthetic_1", mode });
    const turn = await store.appendTurn({ conversationId: conversation.id, role: "customer", content: "Cut + beard Tuesday 10am?" });
    return { store, conversation, turn };
  }

  it("runs a permitted tool, checkpoints it, and reaches a pending booking", async () => {
    const { store, conversation, turn } = await setup("AUTO");
    const { client, gateway } = mockGateway(store, 10, [
      { toolCall: { name: "list_services", arguments: {} } },
      { toolCall: { name: "request_booking", arguments: { service_id: "cut_and_beard", starts_at: "2026-11-03T10:00:00-05:00" } } },
      { text: "Requested. The owner will confirm." },
    ]);

    const r = await runToolLoop({
      gateway, store, registry: DEFAULT_TOOLS, conversationId: conversation.id, turnId: turn.id,
      model: MOCK_MODEL, messages: [{ role: "user", content: turn.content }], maxOutputTokens: 100,
    });

    expect(r).toEqual({ status: "final", text: "Requested. The owner will confirm.", iterations: 3 });
    expect(client.calls[0].tools?.map((t) => t.name)).toEqual(["list_services", "request_booking"]);
    const kinds = (await store.listTurns(conversation.id)).map((t) => t.checkpoint?.kind ?? t.role);
    expect(kinds).toEqual(["customer", "tool_call", "tool_result", "tool_call", "tool_result", "final"]);
    const results = (await store.listTurns(conversation.id)).filter((t) => t.checkpoint?.kind === "tool_result");
    expect(results.every((t) => (t.checkpoint!.result as { ok: boolean }).ok)).toBe(true);

    const [booking] = await store.listBookings(conversation.businessId);
    expect(booking).toMatchObject({ serviceId: "cut_and_beard", status: "pending_approval", conversationId: conversation.id });
    const [approval] = await store.listPendingApprovals(conversation.businessId);
    expect(approval).toMatchObject({ id: booking.approvalId, kind: "booking", status: "pending" });
    expect((await store.getConversation(conversation.id))!.state).toBe("active");
    // Every model call in the loop is on the ledger under the customer turn.
    expect((await store.listSpend()).map((e) => e.turnId)).toEqual([turn.id, turn.id, turn.id]);
  });

  it("refuses a non-permitted tool, logs it, and ends in owner help", async () => {
    const { store, conversation, turn } = await setup("HUMAN");
    const { client, gateway } = mockGateway(store, 10, [
      { toolCall: { name: "request_booking", arguments: { service_id: "classic_cut", starts_at: "2026-11-03T10:00:00-05:00" } } },
      { text: "never reached" },
    ]);

    const r = await runToolLoop({
      gateway, store, registry: DEFAULT_TOOLS, conversationId: conversation.id, turnId: turn.id,
      model: MOCK_MODEL, messages: [{ role: "user", content: turn.content }], maxOutputTokens: 100,
    });

    expect(r).toMatchObject({ status: "owner_help", reason: "tool_not_permitted", iterations: 1 });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].tools?.map((t) => t.name)).toEqual(["list_services"]);
    const turns = await store.listTurns(conversation.id);
    const refused = turns.find((t) => t.checkpoint?.kind === "tool_refused");
    expect(refused?.checkpoint).toMatchObject({ reason: "not_permitted", permitted: ["list_services"], toolCall: { name: "request_booking" } });
    expect(turns.at(-1)?.checkpoint).toMatchObject({ kind: "owner_help", reason: "tool_not_permitted" });
    expect((await store.getConversation(conversation.id))!.state).toBe("owner_help");
    expect(await store.listBookings(conversation.businessId)).toEqual([]);
  });

  it("stops at max iterations and hands to the owner", async () => {
    const { store, conversation, turn } = await setup("AUTO");
    const loopStep = { toolCall: { name: "list_services", arguments: {} } };
    const { client, gateway } = mockGateway(store, 10, Array.from({ length: 10 }, () => loopStep));
    const r = await runToolLoop({
      gateway, store, registry: DEFAULT_TOOLS, conversationId: conversation.id, turnId: turn.id,
      model: MOCK_MODEL, messages: [{ role: "user", content: turn.content }], maxOutputTokens: 100, maxIterations: 2,
    });
    expect(r).toMatchObject({ status: "owner_help", reason: "max_iterations" });
    expect(client.calls).toHaveLength(2);
  });
});

describe("hosted inference gate", () => {
  const env = {
    MODEL_API_BASE_URL: "https://api.meta.ai/v1",
    MODEL_API_KEY: "test-placeholder",
    MODEL_SPEND_HARD_CAP_USD: "130",
    MODEL_CREDIT_BALANCE_USD: "150",
    LIVE_CREDITS_VERIFIED: "true",
  };
  const image = { kind: "image" as const, model: "muse-image-1.0", prompt: "synthetic mug", n: 1 };

  it("STORAGE_BACKEND=local with LIVE_CREDITS_VERIFIED=true is still refused before any network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const store = openStore(tempDir());
    const gw = createLiveGateway({ store, env: { ...env, STORAGE_BACKEND: "local" } });
    const r = await gw.call(image);
    expect(r).toMatchObject({ outcome: "denied", reason: "hosted_inference_blocked" });
    expect(r.outcome === "denied" && r.detail).toMatch(/STORAGE_BACKEND/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await store.listSpend()).toEqual([]);
  });

  it("refuses when the env says supabase but the ledger store is local", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const store = openStore(tempDir());
    const r = await createLiveGateway({ store, env: { ...env, STORAGE_BACKEND: "supabase" } }).call(image);
    expect(r).toMatchObject({ outcome: "denied", reason: "hosted_inference_blocked" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses when the Supabase ledger table is unreachable", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const local = openStore(tempDir());
    const unreachable = Object.assign(Object.create(local), {
      backend: "supabase" as const,
      ping: async () => {
        throw new Error("relation does not exist");
      },
    });
    const r = await createLiveGateway({ store: unreachable, env: { ...env, STORAGE_BACKEND: "supabase" } }).call(image);
    expect(r).toMatchObject({ outcome: "denied", reason: "hosted_inference_blocked" });
    expect(r.outcome === "denied" && r.detail).toMatch(/unreachable/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("storage factory and startup", () => {
  it("defaults to local, refuses local on a hosted deploy, rejects unknown backends", () => {
    expect(resolveBackend({})).toBe("local");
    expect(resolveBackend({ STORAGE_BACKEND: "supabase" })).toBe("supabase");
    expect(() => resolveBackend({ VERCEL: "1" })).toThrow(/hosted deploy/);
    expect(() => resolveBackend({ STORAGE_BACKEND: "sqlite" })).toThrow(/local.*supabase/);
  });

  it("refuses to start without MODEL_SPEND_HARD_CAP_USD", () => {
    expect(() => assertStartupConfig({})).toThrow(/MODEL_SPEND_HARD_CAP_USD is not set/);
    expect(() => assertStartupConfig({ MODEL_SPEND_HARD_CAP_USD: "131" })).toThrow(/ceiling/);
    expect(() => assertStartupConfig({ MODEL_SPEND_HARD_CAP_USD: "130" })).not.toThrow();
  });

  it("supabase backend needs its URL and service-role key", async () => {
    await expect(createStore({ STORAGE_BACKEND: "supabase" })).rejects.toThrow(/SUPABASE_URL/);
  });

  it("reset wipes business data, reseeds one approved brain, keeps ledger and dedupe", async () => {
    const store = openStore(tempDir());
    await store.reset();
    const c = await store.createConversation({ businessId: SEED_BUSINESS_ID, channel: "web", customerRef: "cust_synthetic_2" });
    await store.claimEvent("whatsapp", "wamid.keep");
    const { gateway } = mockGateway(store, 10, [{ text: "x" }]);
    await gateway.call(chat("t-reset"));

    await store.reset();
    expect(await store.getConversation(c.id)).toBeNull();
    const brain = await store.getBrain(SEED_BUSINESS_ID, { approvedOnly: true });
    expect(brain).toMatchObject({ version: 1, approved: true });
    expect(brain!.brain.discounts).toHaveLength(1);
    expect(await store.listSpend()).toHaveLength(1);
    expect(await store.claimEvent("whatsapp", "wamid.keep")).toBe(false);

    const v2 = await store.addBrainVersion(SEED_BUSINESS_ID, { ...brain!.brain, name: "Harbor Lane Barbers (demo v2)" });
    expect(v2).toMatchObject({ version: 2, approved: false });
    expect((await store.getBrain(SEED_BUSINESS_ID, { approvedOnly: true }))!.version).toBe(1);
  });
});
