// Onboarding is bound to the business the owner selected: every onboard and
// brain route takes it explicitly, and a draft never touches another business.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MOCK_MODEL, MOCK_PRICES } from "../gateway/mock-client";
import { usdToNano } from "../gateway/money";
import { PRICES } from "../gateway/pricing";
import type { DispatchResult, Dispatcher, ModelCall } from "../gateway/types";
import { LocalStore } from "../storage/local-store";
import { SEED_BUSINESS_ID } from "../storage/seed";
import { CEDAR_BRAIN } from "../storage/seed-cedar";
import { PILATES_ID, seedDemoBusinesses } from "../storage/seed-demo";
import { DEMO_CLOCK } from "./demo-script";
import type { EngineDeps } from "./deps";
import { SupabaseMediaStore } from "../content/media-store";
import { transcribeVoiceNote } from "./onboarding";

const EXTRACTED = {
  business_name: "Studio Ofek Pilates",
  timezone: "Asia/Jerusalem",
  languages: ["Hebrew", "English"],
  tone: { adjectives: ["calm", "warm", "precise"], example_sentence: "Breathe in, we'll take it from here." },
  services: [{ id: "mat_class", name: "Mat class", price: 70, currency: "ILS", duration_min: 50 }],
  hours: [{ day: "mon", open: "08:00", close: "20:00" }],
  discounts: [],
  do_not_say: [],
};

function stub(transcriptFails = false): Dispatcher & { calls: ModelCall[] } {
  const d = {
    calls: [] as ModelCall[],
    async dispatch(call: ModelCall): Promise<DispatchResult> {
      d.calls.push(call);
      if (call.kind === "transcribe") {
        return transcriptFails
          ? { ok: false, status: 500, retryable: false, units: null, errorBody: "boom" }
          : { ok: true, status: 200, retryable: false, units: { kind: "transcribe", audioMs: 1_000 }, output: "We teach mat classes." };
      }
      return { ok: true, status: 200, retryable: false, units: { kind: "chat", promptTokens: 300, cachedTokens: 0, completionTokens: 200 }, output: JSON.stringify(EXTRACTED) };
    },
  };
  return d;
}

const dirs: string[] = [];
let store: LocalStore;
let dispatcher: ReturnType<typeof stub>;
const deps = (): EngineDeps => ({
  store,
  gateway: new SpendGateway({ ledger: new StoreSpendLedger(store, { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) }), dispatcher, prices: { ...PRICES, ...MOCK_PRICES } }),
  model: MOCK_MODEL,
  now: () => DEMO_CLOCK,
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-brain-onb-"));
  dirs.push(dir);
  vi.stubEnv("STORAGE_DIR", dir);
  store = LocalStore.open(join(dir, "store"));
  await store.reset(CEDAR_BRAIN);
  await seedDemoBusinesses(store);
  dispatcher = stub();
  vi.doMock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("../storage")>()), getStore: async () => store }));
  vi.doMock("@/lib/engine/deps", async (orig) => ({ ...(await orig<typeof import("./deps")>()), engineDeps: async () => deps() }));
});
afterEach(async () => {
  vi.doUnmock("@/lib/storage");
  vi.doUnmock("@/lib/engine/deps");
  vi.unstubAllEnvs();
  vi.resetModules();
  await store.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const wav = () => {
  const data = Buffer.alloc(16_000 * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24); h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([h, data]));
};
const versions = async (id: string) => (await store.listBrainVersions(id)).map((v) => `${v.version}${v.approved ? "a" : "d"}`);

describe("onboarding routes are bound to an explicit business", () => {
  it("every onboard and brain route answers 400 without a business and 404 for an unknown one", async () => {
    const { POST: transcribe } = await import("@/app/api/onboard/transcribe/route");
    const { POST: extract } = await import("@/app/api/onboard/extract/route");
    const { GET: list } = await import("@/app/api/brain/route");
    const { PUT: edit, DELETE: discard } = await import("@/app/api/brain/[version]/route");
    const { POST: approve } = await import("@/app/api/brain/[version]/approve/route");
    const params = { params: Promise.resolve({ version: "1" }) };
    for (const [q, status] of [["", 400], ["?business=biz_nope", 404]] as const) {
      const form = new FormData();
      form.append("audio", new Blob([wav() as BlobPart]), "a.wav");
      expect((await transcribe(new Request(`http://l/x${q}`, { method: "POST", body: form }))).status).toBe(status);
      expect((await extract(new Request(`http://l/x${q}`, { method: "POST", body: JSON.stringify({ text: "hi" }) }))).status).toBe(status);
      expect((await list(new Request(`http://l/x${q}`))).status).toBe(status);
      expect((await edit(new Request(`http://l/x${q}`, { method: "PUT", body: JSON.stringify({ brain: CEDAR_BRAIN }) }), params)).status).toBe(status);
      expect((await discard(new Request(`http://l/x${q}`, { method: "DELETE" }), params)).status).toBe(status);
      expect((await approve(new Request(`http://l/x${q}`, { method: "POST", body: "{}" }), params)).status).toBe(status);
    }
    expect(dispatcher.calls).toEqual([]);
  });

  it("a Pilates draft is written for Pilates only, stays a draft, and never touches Cedar", async () => {
    const cedarBefore = await versions(SEED_BUSINESS_ID);
    const { POST: extract } = await import("@/app/api/onboard/extract/route");
    const res = await extract(new Request(`http://l/x?business=${PILATES_ID}`, { method: "POST", body: JSON.stringify({ text: "We teach mat classes.", sourceKind: "text" }) }));
    expect(res.status).toBe(200);
    expect(await versions(PILATES_ID)).toEqual(["2d", "1a"]);
    expect((await store.getBrain(PILATES_ID, { approvedOnly: true }))!.version).toBe(1);
    expect(await versions(SEED_BUSINESS_ID)).toEqual(cedarBefore);
    const { GET: list } = await import("@/app/api/brain/route");
    const listed = await (await list(new Request(`http://l/x?business=${PILATES_ID}`))).json();
    expect(listed.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it("approve, edit and discard act only on the named business's versions", async () => {
    const { POST: extract } = await import("@/app/api/onboard/extract/route");
    await extract(new Request(`http://l/x?business=${PILATES_ID}`, { method: "POST", body: JSON.stringify({ text: "We teach mat classes.", sourceKind: "text" }) }));
    const { POST: approve } = await import("@/app/api/brain/[version]/approve/route");
    // Cedar has no version 2 draft: approving "2" for Cedar must not approve Pilates' draft.
    const wrong = await approve(new Request(`http://l/x?business=${SEED_BUSINESS_ID}`, { method: "POST", body: "{}" }), { params: Promise.resolve({ version: "2" }) });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await versions(PILATES_ID)).toEqual(["2d", "1a"]);
    const right = await approve(new Request(`http://l/x?business=${PILATES_ID}`, { method: "POST", body: "{}" }), { params: Promise.resolve({ version: "2" }) });
    expect(right.status).toBe(200);
    expect(await versions(PILATES_ID)).toEqual(["2a", "1a"]);
  });
});

describe("voice notes are stored through the media store, never under ./data on a hosted deploy", () => {
  it("the transcribe route stores the note for the named business and returns its ref; the draft keeps it as its source", async () => {
    const { POST: transcribe } = await import("@/app/api/onboard/transcribe/route");
    const form = new FormData();
    form.append("audio", new Blob([wav() as BlobPart]), "a.wav");
    const t = await (await transcribe(new Request(`http://l/x?business=${PILATES_ID}`, { method: "POST", body: form }))).json();
    expect(t.audioPath).toContain(join("audio", PILATES_ID));
    const { POST: extract } = await import("@/app/api/onboard/extract/route");
    const v = await (await extract(new Request(`http://l/x?business=${PILATES_ID}`, { method: "POST", body: JSON.stringify({ text: t.transcript, sourceKind: "voice", audioPath: t.audioPath }) }))).json();
    expect(v.version.source).toMatchObject({ kind: "voice", audioPath: t.audioPath });
  });

  it("with the Supabase media store the note goes to the private bucket under audio/<business>/ and nothing is written to disk; a failed transcription keeps it", async () => {
    const files = new Map<string, Buffer>();
    const client = {
      storage: {
        getBucket: async () => ({ data: { name: "creative-media" }, error: null }),
        createBucket: async () => ({ data: null, error: null }),
        from: (bucket: string) => ({ upload: async (path: string, body: Buffer) => (files.set(`${bucket}/${path}`, Buffer.from(body)), { data: { path }, error: null }) }),
      },
    } as never;
    dispatcher = stub(true);
    await expect(transcribeVoiceNote(deps(), { businessId: PILATES_ID, wav: wav(), media: new SupabaseMediaStore(client) })).rejects.toMatchObject({ status: 502 });
    const keys = [...files.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^creative-media/audio/${PILATES_ID}/.+\\.wav$`));
  });
});
