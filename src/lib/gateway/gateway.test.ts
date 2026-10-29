import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../storage/local-store";
import { CREDIT_BUFFER_USD, loadSpendConfig } from "./config";
import { SpendGateway } from "./gateway";
import { StoreSpendLedger, type LedgerLimits } from "./ledger";
import { MetaDispatcher } from "./meta-dispatcher";
import { usdToNano } from "./money";
import { estimateMaxCost } from "./pricing";
import type { ChatCall, DispatchResult, Dispatcher, ImageCall, ModelCall } from "./types";

const IMAGE_NANO = usdToNano(0.01);

function limits(over: Partial<{ capUsd: number; creditUsd: number; bufferUsd: number }> = {}): LedgerLimits {
  return {
    hardCapNano: usdToNano(over.capUsd ?? 130),
    creditBalanceNano: usdToNano(over.creditUsd ?? 1_000),
    bufferNano: usdToNano(over.bufferUsd ?? CREDIT_BUFFER_USD),
  };
}

// Every ledger here is the durable one, in a fresh SQLite store per test.
const stores: LocalStore[] = [];
const dirs: string[] = [];
function storeLedger(l: LedgerLimits): StoreSpendLedger {
  const dir = mkdtempSync(join(tmpdir(), "meta-brain-gw-"));
  const store = LocalStore.open(dir);
  dirs.push(dir);
  stores.push(store);
  return new StoreSpendLedger(store, l);
}
afterAll(async () => {
  for (const s of stores) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const image = (): ImageCall => ({ kind: "image", model: "muse-image-1.0", prompt: "synthetic red mug on white", n: 1 });

const chat = (maxOutputTokens = 1_000): ChatCall => ({
  kind: "chat",
  model: "muse-spark-1.3",
  messages: [{ role: "user", content: "Say hi." }],
  maxOutputTokens,
});

/** Fake dispatcher: yields to the event loop, then answers from a script. */
function fakeDispatcher(script: (call: ModelCall, n: number) => DispatchResult): Dispatcher & { calls: number } {
  const d = {
    calls: 0,
    async dispatch(call: ModelCall) {
      d.calls++;
      await new Promise((r) => setTimeout(r, 0));
      return script(call, d.calls);
    },
  };
  return d;
}

const okImage = (): DispatchResult => ({ ok: true, status: 200, retryable: false, units: { kind: "image", images: 1 }, output: "b64" });

describe("SpendGateway", () => {
  it("concurrent reservations cannot exceed the cap", async () => {
    const ledger = storeLedger(limits({ capUsd: 1 }));
    const gw = new SpendGateway({ ledger, dispatcher: fakeDispatcher(okImage) });
    const results = await Promise.all(Array.from({ length: 500 }, () => gw.call(image())));
    const ok = results.filter((r) => r.outcome === "ok").length;
    const denied = results.filter((r) => r.outcome === "denied" && r.reason === "hard_cap_reached").length;
    expect(ok).toBe(100);
    expect(denied).toBe(400);
    const snap = await ledger.snapshot();
    expect(snap.settledNano).toBe(usdToNano(1));
    expect(snap.reservedNano).toBe(0);
  });

  it("concurrent raw ledger reservations never overshoot", async () => {
    const ledger = storeLedger(limits({ capUsd: 0.5 }));
    const amount = usdToNano(0.03);
    const res = await Promise.all(Array.from({ length: 200 }, () => ledger.reserve({ amountNano: amount, model: "m" })));
    const granted = res.filter((r) => r.granted).length;
    expect(granted).toBe(16); // floor(0.5 / 0.03)
    expect((await ledger.snapshot()).reservedNano).toBeLessThanOrEqual(usdToNano(0.5));
  });

  it("counts every retry toward spend", async () => {
    const ledger = storeLedger(limits());
    const dispatcher = fakeDispatcher((_c, n) =>
      n < 3 ? { ok: false, status: 503, retryable: true, units: null, errorBody: "busy" } : okImage(),
    );
    const gw = new SpendGateway({ ledger, dispatcher, bounds: { maxRetries: 2 } });
    const r = await gw.call(image());
    expect(r.outcome).toBe("ok");
    expect(r.attempts).toHaveLength(3);
    // Two failed attempts settle at the full reservation, the success at actual.
    expect(r.settledNano).toBe(3 * IMAGE_NANO);
    expect((await ledger.snapshot()).settledNano).toBe(3 * IMAGE_NANO);
  });

  it("stops after maxRetries and still bills every attempt", async () => {
    const ledger = storeLedger(limits());
    const dispatcher = fakeDispatcher(() => ({ ok: false, status: 500, retryable: true, units: null }));
    const gw = new SpendGateway({ ledger, dispatcher, bounds: { maxRetries: 1 } });
    const r = await gw.call(image());
    expect(r.outcome).toBe("failed");
    expect(dispatcher.calls).toBe(2);
    expect((await ledger.snapshot()).settledNano).toBe(2 * IMAGE_NANO);
  });

  it("denies unknown cost without dispatching", async () => {
    const ledger = storeLedger(limits());
    const dispatcher = fakeDispatcher(okImage);
    const gw = new SpendGateway({ ledger, dispatcher });
    const unknownModel = await gw.call({ ...image(), model: "muse-unknown-9" });
    const kindMismatch = await gw.call({ ...image(), model: "muse-spark-1.3" });
    expect(unknownModel).toMatchObject({ outcome: "denied", reason: "unknown_cost" });
    expect(kindMismatch).toMatchObject({ outcome: "denied", reason: "unknown_cost" });
    expect(dispatcher.calls).toBe(0);
    expect(await ledger.snapshot()).toMatchObject({ settledNano: 0, reservedNano: 0 });
  });

  it("denies once the hard cap is reached", async () => {
    const ledger = storeLedger(limits({ capUsd: 0.02 }));
    const gw = new SpendGateway({ ledger, dispatcher: fakeDispatcher(okImage) });
    expect((await gw.call(image())).outcome).toBe("ok");
    expect((await gw.call(image())).outcome).toBe("ok");
    expect(await gw.call(image())).toMatchObject({ outcome: "denied", reason: "hard_cap_reached" });
  });

  it("enforces the $20 credit buffer", async () => {
    // $20.015 of credit leaves $0.015 spendable: one $0.01 image, not two.
    const ledger = storeLedger(limits({ creditUsd: 20.015 }));
    const gw = new SpendGateway({ ledger, dispatcher: fakeDispatcher(okImage) });
    expect((await gw.call(image())).outcome).toBe("ok");
    expect(await gw.call(image())).toMatchObject({ outcome: "denied", reason: "insufficient_credit" });
    expect(loadSpendConfig({ MODEL_SPEND_HARD_CAP_USD: "130", MODEL_CREDIT_BALANCE_USD: "150" }).bufferNano).toBe(usdToNano(20));
  });

  it("settlement releases the unused reservation", async () => {
    const ledger = storeLedger(limits());
    const dispatcher = fakeDispatcher(() => ({
      ok: true,
      status: 200,
      retryable: false,
      units: { kind: "chat", promptTokens: 10, cachedTokens: 0, completionTokens: 5 },
      output: "hi",
    }));
    const gw = new SpendGateway({ ledger, dispatcher });
    const call = chat(1_000);
    const reserved = estimateMaxCost(call)!;
    const r = await gw.call(call);
    const actual = 10 * 1_250 + 5 * 4_250;
    expect(r.reservedNano).toBe(reserved);
    expect(r.settledNano).toBe(actual);
    expect(actual).toBeLessThan(reserved);
    expect(await ledger.snapshot()).toMatchObject({ settledNano: actual, reservedNano: 0 });
  });

  it("enforces the per-run cap", async () => {
    const ledger = storeLedger(limits());
    const gw = new SpendGateway({ ledger, dispatcher: fakeDispatcher(okImage), run: { id: "smoke", capNano: usdToNano(0.015) } });
    expect((await gw.call(image())).outcome).toBe("ok");
    expect(await gw.call(image())).toMatchObject({ outcome: "denied", reason: "run_cap_reached" });
  });

  it("denies out-of-bounds output tokens, images and rounds", async () => {
    const gw = new SpendGateway({ ledger: storeLedger(limits()), dispatcher: fakeDispatcher(okImage) });
    expect(await gw.call(chat(100_000))).toMatchObject({ outcome: "denied", reason: "bounds_exceeded" });
    expect(await gw.call({ ...image(), n: 50 })).toMatchObject({ outcome: "denied", reason: "bounds_exceeded" });
    expect(await gw.call({ ...image(), round: 99 })).toMatchObject({ outcome: "denied", reason: "bounds_exceeded" });
    expect(
      await gw.call({ kind: "transcribe", model: "muse-voice-transcribe-1.0", audio: new Uint8Array(11 * 1024 * 1024) }),
    ).toMatchObject({ outcome: "denied", reason: "bounds_exceeded" });
  });

  it("rejects a configured cap above $130 and a missing balance", () => {
    expect(() => loadSpendConfig({ MODEL_SPEND_HARD_CAP_USD: "131", MODEL_CREDIT_BALANCE_USD: "150" })).toThrow(/ceiling/);
    expect(() => loadSpendConfig({ MODEL_SPEND_HARD_CAP_USD: "130" })).toThrow(/MODEL_CREDIT_BALANCE_USD/);
  });
});

describe("live-credit guard", () => {
  const baseEnv = { MODEL_API_BASE_URL: "https://api.meta.ai/v1", MODEL_API_KEY: "test-placeholder" };

  for (const flag of [undefined, "false", "TRUE", "1", "yes"]) {
    it(`blocks the real dispatcher when LIVE_CREDITS_VERIFIED=${String(flag)}`, async () => {
      const fetchSpy = vi.fn();
      const env = flag === undefined ? { ...baseEnv } : { ...baseEnv, LIVE_CREDITS_VERIFIED: flag };
      const ledger = storeLedger(limits());
      const gw = new SpendGateway({ ledger, dispatcher: new MetaDispatcher(env, fetchSpy as unknown as typeof fetch) });
      const r = await gw.call(image());
      expect(r).toMatchObject({ outcome: "denied", reason: "live_credits_not_verified" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await ledger.snapshot()).toMatchObject({ settledNano: 0, reservedNano: 0 });
    });
  }

  it("lets the real dispatcher through with LIVE_CREDITS_VERIFIED=true and a Supabase ledger", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ created: 1, data: [{ b64_json: "AAAA" }] }), { status: 200 }));
    const ledger = storeLedger(limits());
    const env = { ...baseEnv, LIVE_CREDITS_VERIFIED: "true", STORAGE_BACKEND: "supabase" };
    // Stand-in for a reachable Supabase ledger; the parsing path is what is under test.
    const supabaseProbe = { backend: "supabase" as const, ping: async () => {} };
    const gw = new SpendGateway({ ledger, dispatcher: new MetaDispatcher(env, fetchSpy as unknown as typeof fetch, supabaseProbe) });
    const r = await gw.call(image());
    expect(r.outcome).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.meta.ai/v1/images/generations");
    expect((await ledger.snapshot()).settledNano).toBe(IMAGE_NANO);
  });
});

describe("gateway isolation", () => {
  it("only meta-dispatcher.ts touches the Meta API, its key or fetch", () => {
    const root = join(__dirname, "..", "..");
    const allowed = new Set(["lib/gateway/meta-dispatcher.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || name.endsWith(".test.ts")) continue;
        const rel = relative(root, p);
        if (allowed.has(rel)) continue;
        const src = readFileSync(p, "utf8");
        if (/api\.meta\.ai|MODEL_API_KEY|MODEL_API_BASE_URL|\bfetch\(/.test(src)) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
