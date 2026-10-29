// Day 3 cleanup: transcript display, place-name time zones, owner header and
// booking display. Mock model client and stub dispatchers only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MOCK_MODEL, MOCK_PRICES, MockModelClient } from "../gateway/mock-client";
import { usdToNano } from "../gateway/money";
import { PRICES } from "../gateway/pricing";
import type { DispatchResult, Dispatcher, ModelCall } from "../gateway/types";
import { LocalStore } from "../storage/local-store";
import { SEED_BRAIN, SEED_BUSINESS_ID } from "../storage/seed";
import type { Storage } from "../storage/types";
import { DEMO_CLOCK } from "./demo-script";
import type { EngineDeps } from "./deps";
import { formatWithZone, sourceBox } from "./display";
import { approveDraft, extractBrainDraft, namedZone, transcribeVoiceNote } from "./onboarding";
import { ownerState } from "./owner";

const dirs: string[] = [];
const stores: Storage[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "meta-brain-cleanup-"));
  dirs.push(d);
  return d;
}
async function seeded(): Promise<LocalStore> {
  const s = LocalStore.open(tempDir());
  stores.push(s);
  await s.reset();
  return s;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const LIMITS = { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) };
const deps = (store: LocalStore, dispatcher: Dispatcher): EngineDeps => ({
  store,
  gateway: new SpendGateway({ ledger: new StoreSpendLedger(store, LIMITS), dispatcher, prices: { ...PRICES, ...MOCK_PRICES } }),
  model: MOCK_MODEL,
  now: () => DEMO_CLOCK,
});

// The onboarding demo script (research/ONBOARDING-DEMO-SCRIPT.md), inlined because research/ is not in the repo.
const DEMO_TEXT =
  "Hi, this is Cedar Street Barbers in Jerusalem. We do four services. A classic cut is eighty shekels, thirty minutes. A skin fade is ninety shekels, forty minutes. A beard trim is fifty shekels, twenty minutes. Cut plus beard is a hundred and twenty shekels, fifty minutes. We're open Sunday to Thursday, nine to seven, and Friday eight to one. Closed Saturday. On Tuesdays, cut plus beard is fifteen percent off. Keep it warm, short and relaxed.";

/** What Spark returned live on 2026-10-29, including the wrong time zone. */
const EXTRACTED = {
  business_name: "Cedar Street Barbers",
  timezone: "America/New_York",
  languages: ["en"],
  tone: { adjectives: ["warm", "short", "relaxed"], example_sentence: "Hey, grab a seat." },
  services: [
    { id: "classic_cut", name: "classic cut", price: 80, currency: "ILS", duration_min: 30 },
    { id: "cut_plus_beard", name: "cut plus beard", price: 120, currency: "ILS", duration_min: 50 },
  ],
  weekly_hours: { sun: [{ open: "09:00", close: "19:00" }], mon: [], tue: [], wed: [], thu: [], fri: [{ open: "08:00", close: "13:00" }], sat: [] },
  discount_rules: [],
  booking_policy: { approval_required: true },
  do_not_say: [],
};

/** Makes the stored approved brain a New York one, like the pre-B2 ./data seed. */
async function withNewYorkBrain(store: LocalStore): Promise<void> {
  const v = await store.addBrainVersion(SEED_BUSINESS_ID, { ...SEED_BRAIN, timezone: "America/New_York" });
  await store.approveBrainVersion(SEED_BUSINESS_ID, v.version);
}

describe("transcript on audio drafts", () => {
  it("is persisted on the draft and shown under a voice label; typed drafts keep their own label", async () => {
    const store = await seeded();
    const stub: Dispatcher = {
      async dispatch(call: ModelCall): Promise<DispatchResult> {
        if (call.kind === "transcribe") return { ok: true, status: 200, retryable: false, units: { kind: "transcribe", audioMs: 1_000 }, output: DEMO_TEXT };
        return { ok: true, status: 200, retryable: false, units: { kind: "chat", promptTokens: 10, cachedTokens: 0, completionTokens: 10 }, output: JSON.stringify(EXTRACTED) };
      },
    };
    const d = deps(store, stub);
    const wav = new Uint8Array(44 + 32_000);
    const v = new DataView(wav.buffer);
    [..."RIFF"].forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
    v.setUint32(4, 36 + 32_000, true);
    [..."WAVEfmt "].forEach((c, i) => v.setUint8(8 + i, c.charCodeAt(0)));
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 16_000, true);
    v.setUint32(28, 32_000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    [..."data"].forEach((c, i) => v.setUint8(36 + i, c.charCodeAt(0)));
    v.setUint32(40, 32_000, true);

    const t = await transcribeVoiceNote(d, { businessId: SEED_BUSINESS_ID, wav, audioDir: join(tempDir(), "audio") });
    await extractBrainDraft(d, { businessId: SEED_BUSINESS_ID, text: t.transcript, source: { kind: "voice", audioPath: t.audioPath } });

    const [draft] = await store.listBrainVersions(SEED_BUSINESS_ID);
    expect(draft).toMatchObject({ version: 2, approved: false, source: { kind: "voice", text: DEMO_TEXT, audioPath: t.audioPath } });
    expect(sourceBox(draft.version, draft.source)).toEqual({ label: "Voice transcript (v2)", text: DEMO_TEXT });
    expect(sourceBox(4, { kind: "text", text: "We open at nine." })).toEqual({ label: "Typed text (v4)", text: "We open at nine." });
    expect(sourceBox(3, null).text).toBe("(no source text was stored for this version)");
  });

  it("getStore reopens the store after its module is replaced (the hot-reload case that lost v3's transcript)", async () => {
    vi.stubEnv("STORAGE_BACKEND", "local");
    vi.stubEnv("STORAGE_DIR", tempDir());
    const { getStore } = await import("../storage");
    const first = await getStore();
    stores.push(first);
    expect(await getStore()).toBe(first);
    vi.resetModules();
    const fresh = await import("../storage/local-store");
    const second = await getStore();
    stores.push(second);
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(fresh.LocalStore);
  });
});

describe("time zone from a named place", () => {
  it('"in Jerusalem" gives Asia/Jerusalem even when the current brain and the model say New York', async () => {
    const store = await seeded();
    await withNewYorkBrain(store);
    const client = new MockModelClient([{ text: JSON.stringify(EXTRACTED) }]);
    const draft = await extractBrainDraft(deps(store, client), { businessId: SEED_BUSINESS_ID, text: DEMO_TEXT, source: { kind: "text", audioPath: null } });
    expect(draft.brain.timezone).toBe("Asia/Jerusalem");
    const prompt = client.calls[0].messages[0].content;
    expect(prompt).toContain("timezone is Asia/Jerusalem");
    expect(prompt).not.toContain("America/New_York");
  });

  it("falls back to the current brain's zone only when no place is named", async () => {
    const store = await seeded();
    await withNewYorkBrain(store);
    const client = new MockModelClient([{ text: JSON.stringify({ ...EXTRACTED, timezone: "" }) }]);
    const draft = await extractBrainDraft(deps(store, client), {
      businessId: SEED_BUSINESS_ID,
      text: "Classic cut eighty, thirty minutes. Open Sunday nine to seven.",
      source: { kind: "text", audioPath: null },
    });
    expect(draft.brain.timezone).toBe("America/New_York");
    expect(client.calls[0].messages[0].content).toContain("If the time zone is not stated, use America/New_York.");
  });

  it("uses an explicit place list, whole words only", () => {
    expect(namedZone("We're in Tel-Aviv")).toBe("Asia/Jerusalem");
    expect(namedZone("We're in Tel Aviv, Israel")).toBe("Asia/Jerusalem");
    expect(namedZone("A shop in New York")).toBe("America/New_York");
    expect(namedZone("A shop in London")).toBe("Europe/London");
    expect(namedZone("Jerusalem and London branches")).toBeNull();
    expect(namedZone("Londoner style cuts, Israeli-born barber")).toBeNull();
    expect(namedZone("Cuts and fades")).toBeNull();
  });
});

describe("owner screen data", () => {
  it("the header uses the current approved brain's name, not the seeded registry name", async () => {
    const store = await seeded();
    const v = await store.addBrainVersion(SEED_BUSINESS_ID, { ...SEED_BRAIN, name: "Cedar Street Barbers" });
    expect((await ownerState(store, SEED_BUSINESS_ID)).businessName).toBe("Harbor Lane Barbers (demo)");
    await approveDraft(store, SEED_BUSINESS_ID, v.version);
    const state = await ownerState(store, SEED_BUSINESS_ID);
    expect(state.business?.name).toBe("Harbor Lane Barbers (demo)");
    expect(state.businessName).toBe("Cedar Street Barbers");
  });

  it("a booking shows the service name from the brain it was made under, and its time in the business zone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T09:00:00Z"));
    const store = await seeded();
    vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
    await store.requestBooking({ businessId: SEED_BUSINESS_ID, conversationId: null, serviceId: "cut_and_beard", customerRef: "x", startsAt: "2026-11-05T08:00:00.000Z" });
    await store.requestBooking({ businessId: SEED_BUSINESS_ID, conversationId: null, serviceId: "gone_service", customerRef: "y", startsAt: "2026-11-05T09:00:00.000Z" });
    vi.setSystemTime(new Date("2026-10-29T11:00:00Z"));
    // A later brain that no longer has cut_and_beard.
    const v2 = await store.addBrainVersion(SEED_BUSINESS_ID, { ...SEED_BRAIN, name: "Cedar Street Barbers", services: [SEED_BRAIN.services[0]], discounts: [] });
    await approveDraft(store, SEED_BUSINESS_ID, v2.version);

    const { bookings, approvals } = await ownerState(store, SEED_BUSINESS_ID);
    expect(bookings!.map((b) => [b.serviceId, b.serviceName, b.when])).toEqual([
      ["cut_and_beard", "Cut + beard", "Thu, Nov 5, 10:00 IST"],
      ["gone_service", "gone_service", "Thu, Nov 5, 11:00 IST"],
    ]);
    expect(approvals![0].booking).toMatchObject({ serviceName: "Cut + beard", when: "Thu, Nov 5, 10:00 IST" });
    // Storage stays absolute UTC.
    expect((await store.listBookings(SEED_BUSINESS_ID))[0].startsAt).toBe("2026-11-05T08:00:00.000Z");
  });

  it("formats zone abbreviations, including Israeli summer time", () => {
    expect(formatWithZone("2026-10-29T14:00:00.000Z", "Asia/Jerusalem")).toBe("Thu, Oct 29, 16:00 IST");
    expect(formatWithZone("2026-07-01T09:00:00.000Z", "Asia/Jerusalem")).toBe("Wed, Jul 1, 12:00 IDT");
    expect(formatWithZone("2026-11-05T15:00:00.000Z", "America/New_York")).toBe("Thu, Nov 5, 10:00 EST");
  });
});
