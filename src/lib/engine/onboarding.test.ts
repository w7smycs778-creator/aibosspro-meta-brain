// Day 3B2: voice/text onboarding -> draft brain -> owner review -> approved
// version used by the engine. Mock model client and stub dispatchers only.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MOCK_MODEL, MOCK_PRICES, MockModelClient, type ScriptedStep } from "../gateway/mock-client";
import { usdToNano } from "../gateway/money";
import { PRICES } from "../gateway/pricing";
import type { DispatchResult, Dispatcher, ModelCall } from "../gateway/types";
import { upgradeBrain } from "../storage/brain";
import { LocalStore } from "../storage/local-store";
import { SEED_BRAIN, SEED_BUSINESS_ID } from "../storage/seed";
import { handleInbound } from "./conversation-service";
import { DEMO_CLOCK } from "./demo-script";
import type { EngineDeps } from "./deps";
import { approveDraft, discardDraft, extractBrainDraft, OnboardingError, parseWav, saveDraftEdits, transcribeVoiceNote, TRANSCRIBE_MODEL } from "./onboarding";

const dirs: string[] = [];
const stores: LocalStore[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "meta-brain-b2-"));
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
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const LIMITS = { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) };
function deps(store: LocalStore, dispatcher: Dispatcher): EngineDeps {
  const gateway = new SpendGateway({ ledger: new StoreSpendLedger(store, LIMITS), dispatcher, prices: { ...PRICES, ...MOCK_PRICES } });
  return { store, gateway, model: MOCK_MODEL, now: () => DEMO_CLOCK };
}

/** What Spark would return for the typed rules below. */
const EXTRACTED = {
  business_name: "Cedar Street Barbers",
  timezone: "Asia/Jerusalem",
  languages: ["Hebrew", "English"],
  tone: { adjectives: ["warm", "direct", "relaxed"], example_sentence: "Come in, we'll take care of you." },
  services: [
    { id: "skin_fade", name: "Skin fade", price: 90, currency: "ILS", duration_min: 40 },
    { id: "beard_shape", name: "Beard shape", price: 50, currency: "ILS", duration_min: 20 },
  ],
  weekly_hours: {
    sun: [{ open: "09:00", close: "19:00" }],
    mon: [{ open: "09:00", close: "19:00" }],
    tue: [{ open: "09:00", close: "19:00" }],
    wed: [{ open: "09:00", close: "19:00" }],
    thu: [{ open: "09:00", close: "21:00" }],
    fri: [{ open: "08:00", close: "13:00" }],
    sat: [],
  },
  discount_rules: [
    { description: "15% off Skin fade on Tuesdays", pct_or_amount: { kind: "pct", value: 15 }, conditions: { service_ids: ["skin_fade"], weekdays: ["tue"], note: "" } },
  ],
  booking_policy: { approval_required: true },
  do_not_say: ["walk-ins guaranteed"],
};
const TYPED = "We're Cedar Street Barbers. Skin fade 90 shekels, 40 minutes. Beard shape 50, 20 minutes. Sunday to Thursday 9 to 7, Thursday until 9, Friday 8 to 1. 15% off fades on Tuesdays.";

function wav(samples: number, rate = 16_000, channels = 1): Uint8Array {
  const v = new DataView(new ArrayBuffer(44 + samples * 2 * channels));
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2 * channels, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2 * channels, true);
  v.setUint16(32, 2 * channels, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2 * channels, true);
  return new Uint8Array(v.buffer);
}

/** Answers transcribe calls with a fixed transcript and chat calls with the extraction JSON. */
function voiceStub(): Dispatcher & { calls: ModelCall[] } {
  const d = {
    calls: [] as ModelCall[],
    async dispatch(call: ModelCall): Promise<DispatchResult> {
      d.calls.push(call);
      if (call.kind === "transcribe") return { ok: true, status: 200, retryable: false, units: { kind: "transcribe", audioMs: 2_000 }, output: TYPED };
      return { ok: true, status: 200, retryable: false, units: { kind: "chat", promptTokens: 400, cachedTokens: 0, completionTokens: 300 }, output: JSON.stringify(EXTRACTED) };
    },
  };
  return d;
}

const panel = (text: string, id: string) => ({ businessId: SEED_BUSINESS_ID, channel: "panel" as const, externalConversationId: "panel-b2", senderId: "panel-b2", text, externalEventId: id });

describe("typed onboarding -> draft -> approve -> engine", () => {
  it("builds a draft, keeps it out of the engine until approved, then the prompt carries the new services", async () => {
    const store = await seeded();
    const extraction = new MockModelClient([{ text: JSON.stringify(EXTRACTED) }]);
    const draft = await extractBrainDraft(deps(store, extraction), { businessId: SEED_BUSINESS_ID, text: TYPED, source: { kind: "text", audioPath: null } });

    expect(draft).toMatchObject({ version: 2, approved: false, source: { kind: "text", text: TYPED, audioPath: null } });
    expect(draft.brain.services).toEqual([
      { id: "skin_fade", name: "Skin fade", priceCents: 9_000, currency: "ILS", durationMin: 40 },
      { id: "beard_shape", name: "Beard shape", priceCents: 5_000, currency: "ILS", durationMin: 20 },
    ]);
    expect(draft.brain.discounts[0]).toMatchObject({ percentOff: 15, amountOffCents: null, serviceIds: ["skin_fade"], weekdays: ["tue"] });
    expect(draft.brain.bookingPolicy).toEqual({ approvalRequired: true });
    const extractionCall = extraction.calls[0];
    expect(extractionCall.jsonSchema?.name).toBe("business_brain");
    expect(extractionCall.maxOutputTokens).toBe(2_048);
    expect(extractionCall.reasoningEffort).toBe("low");

    // The draft is never used: the engine still answers from approved v1.
    const before = new MockModelClient([{ text: "We offer cuts." }]);
    await handleInbound(panel("What do you offer?", "b2-1"), deps(store, before));
    const promptBefore = before.calls[0].messages[0].content;
    expect(promptBefore).toContain("brain v1");
    expect(promptBefore).toContain("Classic cut: $35, 30 min");
    expect(promptBefore).not.toContain("Skin fade");

    const approved = await approveDraft(store, SEED_BUSINESS_ID, 2);
    expect(approved).toMatchObject({ version: 2, approved: true });

    const after = new MockModelClient([{ text: "We offer a Skin fade for ₪90 (40 min) and a Beard shape for ₪50 (20 min)." }]);
    const r = await handleInbound(panel("What do you offer?", "b2-2"), deps(store, after));
    const promptAfter = after.calls[0].messages[0].content;
    expect(promptAfter).toContain("brain v2");
    expect(promptAfter).toContain("Skin fade: ₪90, 40 min (id skin_fade)");
    expect(promptAfter).toContain("Beard shape: ₪50, 20 min");
    expect(promptAfter).toContain("- Sat: closed");
    expect(promptAfter).toContain("15% off Skin fade on Tuesdays");
    expect(promptAfter).toContain("Never say: walk-ins guaranteed");
    expect(promptAfter).not.toContain("Classic cut");
    // Answered from the prompt: one model call, no tool call, verified against v2.
    expect(r.outcome).toBe("final");
    expect(after.calls).toHaveLength(1);
    expect(r.trace.some((t) => t.checkpoint?.kind === "tool_call")).toBe(false);
    const verdict = r.trace.find((t) => t.checkpoint?.kind === "verifier")!.checkpoint!;
    expect(verdict).toMatchObject({ pass: true });
  });

  it("discard removes the draft; an approved version cannot be discarded or edited", async () => {
    const store = await seeded();
    await extractBrainDraft(deps(store, new MockModelClient([{ text: JSON.stringify(EXTRACTED) }])), {
      businessId: SEED_BUSINESS_ID,
      text: TYPED,
      source: { kind: "text", audioPath: null },
    });
    await discardDraft(store, SEED_BUSINESS_ID, 2);
    expect((await store.listBrainVersions(SEED_BUSINESS_ID)).map((v) => v.version)).toEqual([1]);
    await expect(discardDraft(store, SEED_BUSINESS_ID, 2)).rejects.toMatchObject({ status: 404 });
    await expect(discardDraft(store, SEED_BUSINESS_ID, 1)).rejects.toMatchObject({ status: 409 });
    await expect(saveDraftEdits(store, SEED_BUSINESS_ID, 1, SEED_BRAIN)).rejects.toMatchObject({ status: 409 });
  });

  it("owner edits are validated and saved; booking approval cannot be switched off", async () => {
    const store = await seeded();
    const draft = await extractBrainDraft(deps(store, new MockModelClient([{ text: JSON.stringify(EXTRACTED) }])), {
      businessId: SEED_BUSINESS_ID,
      text: TYPED,
      source: { kind: "text", audioPath: null },
    });
    const bad = { ...draft.brain, services: [{ ...draft.brain.services[0], priceCents: -5 }] };
    await expect(saveDraftEdits(store, SEED_BUSINESS_ID, 2, bad)).rejects.toMatchObject({ status: 400 });
    const edited = { ...draft.brain, name: "Cedar St. Barbers", bookingPolicy: { approvalRequired: false as unknown as true } };
    const saved = await saveDraftEdits(store, SEED_BUSINESS_ID, 2, edited);
    expect(saved.brain).toMatchObject({ name: "Cedar St. Barbers", bookingPolicy: { approvalRequired: true } });
  });

  it("an extraction that fails validation creates no draft", async () => {
    const store = await seeded();
    const broken = { ...EXTRACTED, services: [] };
    await expect(
      extractBrainDraft(deps(store, new MockModelClient([{ text: JSON.stringify(broken) }])), {
        businessId: SEED_BUSINESS_ID,
        text: TYPED,
        source: { kind: "text", audioPath: null },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { errors: ["no services", 'discount "15% off Skin fade on Tuesdays" names unknown service "skin_fade"'] },
    });
    await expect(
      extractBrainDraft(deps(store, new MockModelClient([{ text: "Sorry, I can't." }])), {
        businessId: SEED_BUSINESS_ID,
        text: TYPED,
        source: { kind: "text", audioPath: null },
      }),
    ).rejects.toBeInstanceOf(OnboardingError);
    expect((await store.listBrainVersions(SEED_BUSINESS_ID)).map((v) => v.version)).toEqual([1]);
  });
});

describe("voice onboarding", () => {
  it("stores the voice note, transcribes it through the gateway, and extracts a voice-sourced draft", async () => {
    const store = await seeded();
    const stub = voiceStub();
    const d = deps(store, stub);
    const audioDir = join(tempDir(), "audio");
    const t = await transcribeVoiceNote(d, { businessId: SEED_BUSINESS_ID, wav: wav(32_000), audioDir });

    expect(t).toMatchObject({ transcript: TYPED, durationMs: 2_000 });
    expect(t.audioPath.startsWith(audioDir)).toBe(true);
    expect(readFileSync(t.audioPath).byteLength).toBe(44 + 64_000);
    expect(stub.calls[0]).toMatchObject({ kind: "transcribe", model: TRANSCRIBE_MODEL, languageBias: ["English", "Hebrew"] });

    const draft = await extractBrainDraft(d, { businessId: SEED_BUSINESS_ID, text: t.transcript, source: { kind: "voice", audioPath: t.audioPath } });
    expect(draft.source).toEqual({ kind: "voice", text: TYPED, audioPath: t.audioPath });
    const rows = await store.listSpend();
    expect(rows.map((r) => r.model)).toEqual([TRANSCRIBE_MODEL, MOCK_MODEL]);
    expect(rows.every((r) => r.state === "settled")).toBe(true);
  });

  it("the upload route reaches the transcription client (stubbed) and stores the audio under STORAGE_DIR/audio", async () => {
    const store = await seeded();
    const stub = voiceStub();
    const storageDir = tempDir();
    vi.stubEnv("STORAGE_DIR", storageDir);
    vi.doMock("@/lib/engine/deps", async (orig) => ({ ...(await orig<typeof import("./deps")>()), engineDeps: async () => deps(store, stub) }));
    const { POST } = await import("@/app/api/onboard/transcribe/route");
    const form = new FormData();
    form.append("audio", new Blob([wav(16_000) as BlobPart], { type: "audio/wav" }), "note.wav");
    const res = await POST(new Request("http://local/api/onboard/transcribe", { method: "POST", body: form }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.transcript).toBe(TYPED);
    expect(body.audioPath.startsWith(join(storageDir, "audio"))).toBe(true);
    expect(existsSync(body.audioPath)).toBe(true);
    expect(stub.calls.map((c) => c.kind)).toEqual(["transcribe"]);
    vi.doUnmock("@/lib/engine/deps");
    vi.unstubAllEnvs();
  });

  it("accepts only mono 16-bit PCM WAV at 16 or 24 kHz", () => {
    expect(parseWav(wav(24_000, 24_000))).toMatchObject({ sampleRate: 24_000, channels: 1, durationMs: 1_000 });
    expect(() => parseWav(new TextEncoder().encode("not audio at all, definitely not RIFF data here"))).toThrow(/not a WAV/);
    expect(() => parseWav(wav(100, 44_100))).toThrow(/16 or 24 kHz/);
    expect(() => parseWav(wav(100, 16_000, 2))).toThrow(/mono/);
  });
});

describe("stored brains from before B2", () => {
  it("an old-shape brain row reads with defaults for the new fields", () => {
    const old = {
      name: "Old shop",
      timezone: "America/New_York",
      currency: "USD",
      services: [{ id: "cut", name: "Cut", durationMin: 30, priceCents: 3_000 }],
      hours: { mon: [["09:00", "17:00"]] },
      discounts: [{ id: "d", description: "10% off cuts on Tuesdays", serviceId: "cut", percentOff: 10, weekdays: ["tue"] }],
    };
    const b = upgradeBrain(old);
    expect(b.services[0].currency).toBe("USD");
    expect(b.discounts[0]).toMatchObject({ serviceIds: ["cut"], percentOff: 10, amountOffCents: null, conditions: "" });
    expect(b.hours.sun).toEqual([]);
    expect(b).toMatchObject({ languages: ["English"], bookingPolicy: { approvalRequired: true }, doNotSay: [] });
  });
});
