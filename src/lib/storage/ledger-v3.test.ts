// Ledger v3: finish_reason, reasoning_tokens and usage_raw persisted; v2 files
// migrated in place; the engine's json-mode request carries the step schema.
// Stubbed fetch only; no network.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveGateway } from "../gateway";
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MetaDispatcher } from "../gateway/meta-dispatcher";
import { usdToNano } from "../gateway/money";
import { handleInbound } from "../engine/conversation-service";
import { DEMO_CLOCK } from "../engine/demo-script";
import { ENGINE_TOOLS } from "../engine/tools";
import { LOCAL_DB_FILE, LocalStore, migrateV2ToV3 } from "./local-store";
import { SEED_BUSINESS_ID } from "./seed";

const REAL_DB = join(process.cwd(), "data", LOCAL_DB_FILE);

function realSpendRows(): number {
  if (!existsSync(REAL_DB)) return 0;
  const db = new Database(REAL_DB, { readonly: true });
  try {
    return (db.prepare("select count(*) as n from model_spend_reservations").get() as { n: number }).n;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}
const V3_COLUMNS = ["finish_reason", "reasoning_tokens", "usage_raw"];

const dirs: string[] = [];
const stores: LocalStore[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "meta-brain-v3-"));
  dirs.push(d);
  return d;
}
/** Durable store: a real file outside temp directories (./data is gitignored). */
function durableDir(): string {
  const d = join(process.cwd(), "data", `.v3-test-${randomUUID()}`);
  dirs.push(d);
  return d;
}
function open(dir: string): LocalStore {
  const s = LocalStore.open(dir);
  stores.push(s);
  return s;
}
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function columns(file: string): string[] {
  const db = new Database(file, { readonly: true });
  const names = (db.prepare("pragma table_info(model_spend_reservations)").all() as Array<{ name: string }>).map((c) => c.name);
  db.close();
  return names;
}

const env = {
  MODEL_API_BASE_URL: "https://api.meta.ai/v1",
  MODEL_API_KEY: "test-placeholder",
  MODEL_SPEND_HARD_CAP_USD: "130",
  MODEL_CREDIT_BALANCE_USD: "150",
  LIVE_CREDITS_VERIFIED: "true",
};

const chatResponse = (content: string, finish = "stop") =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
      usage: { prompt_tokens: 812, completion_tokens: 230, completion_tokens_details: { reasoning_tokens: 120 } },
    }),
    { status: 200 },
  );

describe("v2 -> v3 ledger migration", () => {
  // Only on a checkout whose ./data holds real history; a fresh clone seeded by npm run judge has an empty ledger.
  it.skipIf(realSpendRows() < 5)("migrates a copy of the current ./data file, keeping every spend row", async () => {
    const source = new Database(REAL_DB, { readonly: true });
    const before = source.prepare("select id, model, tokens_in, tokens_out, reserved_nano, settled_nano, state from model_spend_reservations order by id").all();
    const dir = tempDir();
    await source.backup(join(dir, LOCAL_DB_FILE));
    source.close();

    const store = open(dir);
    const rows = await store.listSpend();
    expect(rows).toHaveLength(before.length);
    expect(before.length).toBeGreaterThanOrEqual(5);
    const after = [...rows]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ id: r.id, model: r.model, tokens_in: r.tokensIn, tokens_out: r.tokensOut, reserved_nano: r.reservedNano, settled_nano: r.settledNano, state: r.state }));
    expect(after).toEqual(before);
    await store.close();
    expect(columns(join(dir, LOCAL_DB_FILE))).toEqual(expect.arrayContaining(V3_COLUMNS));

    // Idempotent: reopening a migrated file changes nothing.
    const again = open(dir);
    expect(await again.listSpend()).toHaveLength(before.length);
  });

  it("adds the columns to a v2 file in place and is idempotent", async () => {
    const dir = tempDir();
    const store = open(dir);
    const r = await store.reserveSpend({ amountNano: 1_000, model: "muse-spark-1.3" }, { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) });
    if (!r.granted) throw new Error("reserve denied");
    await store.settleSpend(r.reservationId, 900, { tokensIn: 3, tokensOut: 4 });
    await store.close();

    // Rewind the file to v2: drop the v3 columns and the version.
    const file = join(dir, LOCAL_DB_FILE);
    const raw = new Database(file);
    for (const c of V3_COLUMNS) raw.exec(`alter table model_spend_reservations drop column ${c}`);
    raw.pragma("user_version = 2");
    raw.close();
    expect(columns(file)).not.toEqual(expect.arrayContaining(V3_COLUMNS));

    const reopened = open(dir);
    expect(await reopened.listSpend()).toEqual([
      expect.objectContaining({ settledNano: 900, tokensIn: 3, tokensOut: 4, finishReason: null, reasoningTokens: null, usageRaw: null }),
    ]);
    await reopened.close();
    expect(columns(file)).toEqual(expect.arrayContaining(V3_COLUMNS));
    const db = new Database(file);
    // Migrated through to the current schema (v4 brain sources, v5 booking price and keys, v6 business setting and creatives).
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(migrateV2ToV3(db)).toEqual([]);
    db.close();
  });
});

describe("finish_reason and reasoning tokens on the ledger", () => {
  it("a settled live call persists finish_reason, reasoning_tokens and usage_raw across reopen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse("Hello.")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = durableDir();
    const store = open(dir);
    const r = await createLiveGateway({ store, env }).call({
      kind: "chat",
      model: "muse-spark-1.3",
      maxOutputTokens: 100,
      messages: [{ role: "user", content: "synthetic" }],
    });
    expect(r.outcome).toBe("ok");
    await store.close();

    const [row] = await open(dir).listSpend();
    expect(row).toMatchObject({ state: "settled", tokensIn: 812, tokensOut: 230, finishReason: "stop", reasoningTokens: 120 });
    expect(JSON.parse(row.usageRaw!)).toMatchObject({ completion_tokens_details: { reasoning_tokens: 120 } });
  });
});

describe("engine json-mode request", () => {
  it("carries the agent_step json_schema, reasoning_effort low and 2,048 output tokens", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => chatResponse('{"type":"final","text":"Hello."}'));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = open(tempDir());
    await store.reset();
    const probe = { backend: "local" as const, ping: async () => {}, isDurable: async () => true };
    const gateway = new SpendGateway({
      ledger: new StoreSpendLedger(store, { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) }),
      dispatcher: new MetaDispatcher(env, fetchSpy as unknown as typeof fetch, probe),
    });

    const r = await handleInbound(
      { businessId: SEED_BUSINESS_ID, channel: "panel", externalConversationId: "panel-v3", senderId: "panel-v3", text: "hi", externalEventId: "v3-1" },
      { store, gateway, model: "muse-spark-1.3", now: () => DEMO_CLOCK },
    );

    expect(r).toMatchObject({ outcome: "final", replyText: "[AI assistant] Hello." });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_completion_tokens).toBe(2_048);
    expect(body.tools).toBeUndefined();
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("agent_step");
    const branches = body.response_format.json_schema.schema.anyOf;
    expect(branches).toHaveLength(ENGINE_TOOLS.length + 1);
    expect(branches.slice(0, -1).map((b: any) => b.properties.name.enum)).toEqual(ENGINE_TOOLS.map((t) => [t.name]));
    // Every tool's arguments are expressible: args carries that tool's own properties and required keys.
    const avail = branches.find((b: any) => b.properties.name.enum[0] === "check_availability");
    expect(avail.required).toEqual(["type", "name", "args"]);
    expect(Object.keys(avail.properties.args.properties)).toEqual(["date", "service"]);
    expect(avail.properties.args.required).toEqual(["date", "service"]);
    const booking = branches.find((b: any) => b.properties.name.enum[0] === "request_booking");
    expect(booking.properties.args.required).toEqual(["service", "slot", "customer_name", "customer_contact"]);
    expect(branches.at(-1).required).toEqual(["type", "text"]);
    expect((await store.listSpend())[0]).toMatchObject({ finishReason: "stop", reasoningTokens: 120 });
  });
});

describe("engine native-mode request (MODEL_TOOL_MODE=native)", () => {
  it("drives check_availability(args) -> request_booking(args) -> PENDING booking through the real dispatcher", async () => {
    const native = (message: Record<string, unknown>, finish: string) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: null, ...message }, finish_reason: finish }],
          usage: { prompt_tokens: 600, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 40 } },
        }),
        { status: 200 },
      );
    const toolCall = (id: string, name: string, args: Record<string, unknown>) =>
      native({ tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    const replies = [
      toolCall("t1", "check_availability", { date: "2026-11-05", service: "cut_and_beard" }),
      native({ content: "Thursday Nov 5 at 10:00 is open for Cut + beard ($50)." }, "stop"),
      toolCall("t2", "request_booking", { service: "cut_and_beard", slot: "2026-11-05T10:00", customer_name: "Dana", customer_contact: "050-0000000" }),
      native({ content: "Thanks Dana, I've sent Thu Nov 5 at 10:00 to the owner for approval." }, "stop"),
    ];
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => replies.shift()!);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = open(tempDir());
    await store.reset();
    const probe = { backend: "local" as const, ping: async () => {}, isDurable: async () => true };
    const gateway = new SpendGateway({
      ledger: new StoreSpendLedger(store, { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) }),
      dispatcher: new MetaDispatcher({ ...env, MODEL_TOOL_MODE: "native" }, fetchSpy as unknown as typeof fetch, probe),
    });
    const deps = { store, gateway, model: "muse-spark-1.3", now: () => DEMO_CLOCK };
    const msg = (text: string, id: string) => ({ businessId: SEED_BUSINESS_ID, channel: "panel" as const, externalConversationId: "panel-native", senderId: "panel-native", text, externalEventId: id });

    const a = await handleInbound(msg("Do you have Thursday 10:00 for a Cut + beard?", "n1"), deps);
    const b = await handleInbound(msg("Book it, I'm Dana 050-0000000", "n2"), deps);

    expect([a.outcome, b.outcome]).toEqual(["final", "final"]);
    const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(c[1]!.body as string));
    for (const body of bodies) {
      expect(body.tool_choice).toBe("auto");
      expect(body.response_format).toBeUndefined();
      expect(body.reasoning_effort).toBe("low");
      expect(body.tools.map((t: any) => t.function.name)).toEqual(ENGINE_TOOLS.map((t) => t.name));
    }
    expect(bodies[0].tools.find((t: any) => t.function.name === "check_availability").function.parameters.required).toEqual(["date", "service"]);
    // The tool result goes back as an OpenAI tool message tied to the call id.
    expect(bodies[1].messages.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "t1", function: { name: "check_availability" } }] });
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "t1" });

    const [booking] = await store.listBookings(SEED_BUSINESS_ID);
    expect(booking).toMatchObject({ status: "pending_approval", serviceId: "cut_and_beard", customerName: "Dana", startsAt: "2026-11-05T08:00:00.000Z" });
    expect(await store.getApproval(booking.approvalId!)).toMatchObject({ kind: "booking", status: "pending" });
    expect(b.pendingApprovalId).toBe(booking.approvalId);
    const rows = await store.listSpend();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.finishReason)).toEqual(["tool_calls", "stop", "tool_calls", "stop"]);
  });
});
