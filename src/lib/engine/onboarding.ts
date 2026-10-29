// Voice or typed onboarding: voice note -> Meta transcription -> transcript;
// transcript or typed text -> Spark structured extraction -> DRAFT brain
// version (approved=false). The owner reviews, edits and approves; only
// approved versions reach the engine. Every model call goes through the
// gateway, so each one writes a ledger row under the hard cap.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WEEKDAY_KEYS } from "../storage/brain";
import type { BrainSource, BrainVersion, BusinessBrain, DiscountRule, Service, Storage, Weekday } from "../storage/types";
import { ENGINE_REASONING_EFFORT, type EngineDeps } from "./deps";

export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";
export const EXTRACTION_MAX_OUTPUT_TOKENS = 2_048;

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// ---- audio -----------------------------------------------------------------

export type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; durationMs: number };

/** Accepts only what the transcription endpoint takes: mono 16-bit PCM WAV at 16 or 24 kHz. */
export function parseWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new OnboardingError("audio is not a WAV file", 400);
  let offset = 12;
  let fmt: Omit<WavInfo, "durationMs"> | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      if (view.getUint16(offset + 8, true) !== 1) throw new OnboardingError("WAV must be integer PCM", 400);
      fmt = { channels: view.getUint16(offset + 10, true), sampleRate: view.getUint32(offset + 12, true), bitsPerSample: view.getUint16(offset + 22, true) };
    } else if (id === "data" && fmt) {
      if (fmt.channels !== 1) throw new OnboardingError("WAV must be mono", 400);
      if (fmt.sampleRate !== 16_000 && fmt.sampleRate !== 24_000) throw new OnboardingError("WAV must be 16 or 24 kHz", 400);
      if (fmt.bitsPerSample !== 16) throw new OnboardingError("WAV must be 16-bit", 400);
      const dataBytes = Math.min(size, bytes.byteLength - offset - 8);
      return { ...fmt, durationMs: Math.round((dataBytes / (fmt.sampleRate * 2)) * 1000) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new OnboardingError("WAV has no fmt and data chunks", 400);
}

/** Saves the voice note under audioDir, transcribes it, returns the transcript and the stored path. */
export async function transcribeVoiceNote(
  deps: EngineDeps,
  input: { businessId: string; wav: Uint8Array; audioDir: string },
): Promise<{ transcript: string; audioPath: string; durationMs: number }> {
  const info = parseWav(input.wav);
  if (!deps.gateway) throw new OnboardingError(`model unavailable: ${deps.gatewayError ?? "no gateway"}`, 503);
  mkdirSync(input.audioDir, { recursive: true });
  const audioPath = resolve(join(input.audioDir, `${deps.now().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.wav`));
  writeFileSync(audioPath, input.wav);
  const r = await deps.gateway.call({
    kind: "transcribe",
    model: TRANSCRIBE_MODEL,
    audio: input.wav,
    languageBias: ["English", "Hebrew"],
    businessId: input.businessId,
  });
  if (r.outcome === "denied") throw new OnboardingError(`transcription refused: ${r.reason}: ${r.detail}`, 503, { audioPath });
  if (r.outcome === "failed" || !r.output?.trim()) {
    throw new OnboardingError(`transcription failed (status ${r.status})`, 502, { audioPath, errorBody: r.outcome === "failed" ? r.errorBody : undefined });
  }
  return { transcript: r.output.trim(), audioPath, durationMs: info.durationMs };
}

// ---- extraction ------------------------------------------------------------

const DAY_ENUM = { type: "string", enum: WEEKDAY_KEYS };

/** Spark's output contract: the brain schema in snake_case, as the owner would describe it. */
export const EXTRACTION_SCHEMA = {
  name: "business_brain",
  strict: false,
  schema: {
    type: "object",
    properties: {
      business_name: { type: "string" },
      timezone: { type: "string", description: "IANA time zone, e.g. Asia/Jerusalem" },
      languages: { type: "array", items: { type: "string" } },
      tone: {
        type: "object",
        properties: {
          adjectives: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 5 },
          example_sentence: { type: "string" },
        },
        required: ["adjectives", "example_sentence"],
      },
      services: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            price: { type: "number" },
            currency: { type: "string" },
            duration_min: { type: "integer" },
          },
          required: ["id", "name", "price", "currency", "duration_min"],
        },
      },
      weekly_hours: {
        type: "object",
        properties: Object.fromEntries(
          WEEKDAY_KEYS.map((d) => [
            d,
            { type: "array", items: { type: "object", properties: { open: { type: "string" }, close: { type: "string" } }, required: ["open", "close"] } },
          ]),
        ),
        required: WEEKDAY_KEYS,
      },
      discount_rules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            pct_or_amount: {
              type: "object",
              properties: { kind: { type: "string", enum: ["pct", "amount"] }, value: { type: "number" } },
              required: ["kind", "value"],
            },
            conditions: {
              type: "object",
              properties: {
                service_ids: { type: "array", items: { type: "string" } },
                weekdays: { type: "array", items: DAY_ENUM },
                note: { type: "string" },
              },
              required: ["service_ids", "weekdays", "note"],
            },
          },
          required: ["description", "pct_or_amount", "conditions"],
        },
      },
      booking_policy: { type: "object", properties: { approval_required: { type: "boolean" } }, required: ["approval_required"] },
      do_not_say: { type: "array", items: { type: "string" } },
    },
    required: ["business_name", "timezone", "languages", "tone", "services", "weekly_hours", "discount_rules", "booking_policy", "do_not_say"],
  },
};

function extractionPrompt(defaults: { timezone: string; currency: string }): string {
  return [
    "Extract the business owner's operating rules into the JSON schema. Use only facts the owner stated; never invent services, prices, hours or discounts.",
    "Prices are numbers in major units (35 means 35.00). Durations are whole minutes. Times are 24-hour HH:MM.",
    "Service ids are the lowercase snake_case of the service name. A day the owner did not say is open is closed: an empty list.",
    `If the time zone is not stated, use ${defaults.timezone}. If the currency is not stated, use ${defaults.currency}.`,
    "For each discount: pct_or_amount is the percent or the fixed amount off; conditions.service_ids use your service ids (empty for every service), conditions.weekdays use mon..sun (empty for every day), anything else goes in conditions.note.",
    "booking_policy.approval_required is always true.",
    "tone: 3 to 5 adjectives for how the business talks, and one short example sentence in that voice.",
    "do_not_say: anything the owner said never to say or promise; empty if none.",
  ].join("\n");
}

function slug(name: string): string {
  return name.toLowerCase().replace(/\+/g, " and ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "service";
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Checks a brain against the Tier 1 rules. Empty list = valid. */
export function validateBrain(b: BusinessBrain): string[] {
  const errors: string[] = [];
  if (!b.name.trim()) errors.push("business name is empty");
  if (!validTimezone(b.timezone)) errors.push(`unknown time zone "${b.timezone}"`);
  if (!/^[A-Z]{3}$/.test(b.currency)) errors.push(`currency "${b.currency}" is not a 3-letter code`);
  if (b.services.length === 0) errors.push("no services");
  const ids = new Set<string>();
  for (const s of b.services) {
    if (!s.name.trim()) errors.push("a service has no name");
    if (!/^[a-z0-9_]+$/.test(s.id)) errors.push(`service id "${s.id}" must be lowercase snake_case`);
    if (ids.has(s.id)) errors.push(`duplicate service id "${s.id}"`);
    ids.add(s.id);
    if (!Number.isInteger(s.priceCents) || s.priceCents < 0) errors.push(`${s.name}: price must be zero or more`);
    if (!Number.isInteger(s.durationMin) || s.durationMin < 5 || s.durationMin > 480) errors.push(`${s.name}: duration must be 5-480 minutes`);
    if (!/^[A-Z]{3}$/.test(s.currency)) errors.push(`${s.name}: currency "${s.currency}" is not a 3-letter code`);
  }
  for (const d of WEEKDAY_KEYS) {
    for (const [open, close] of b.hours[d] ?? []) {
      if (!HHMM.test(open) || !HHMM.test(close) || open >= close) errors.push(`${d}: window ${open}-${close} is not a valid HH:MM range`);
    }
  }
  for (const d of b.discounts) {
    const hasPct = d.percentOff !== null;
    const hasAmount = d.amountOffCents !== null;
    if (hasPct === hasAmount) errors.push(`discount "${d.description}" needs exactly one of a percent or an amount`);
    if (hasPct && !(d.percentOff! > 0 && d.percentOff! < 100)) errors.push(`discount "${d.description}": percent must be between 0 and 100`);
    if (hasAmount && !(Number.isInteger(d.amountOffCents) && d.amountOffCents! > 0)) errors.push(`discount "${d.description}": amount must be positive`);
    for (const id of d.serviceIds) if (!ids.has(id)) errors.push(`discount "${d.description}" names unknown service "${id}"`);
    for (const w of d.weekdays) if (!WEEKDAY_KEYS.includes(w)) errors.push(`discount "${d.description}" names unknown day "${w}"`);
  }
  if (b.bookingPolicy.approvalRequired !== true) errors.push("booking policy must require owner approval");
  return errors;
}

/** Converts Spark's snake_case output to a brain, fixing what is safe to fix; returns errors for the rest. */
export function brainFromExtraction(raw: any, defaults: { timezone: string; currency: string }): { brain: BusinessBrain; errors: string[] } {
  const currency = String(raw?.services?.[0]?.currency || defaults.currency).toUpperCase();
  const used = new Set<string>();
  const services: Service[] = (Array.isArray(raw?.services) ? raw.services : []).map((s: any) => {
    let id = /^[a-z0-9_]+$/.test(String(s?.id ?? "")) ? String(s.id) : slug(String(s?.name ?? ""));
    for (let n = 2; used.has(id); n++) id = `${id}_${n}`;
    used.add(id);
    return {
      id,
      name: String(s?.name ?? "").trim(),
      priceCents: Math.round(Number(s?.price) * 100),
      currency: String(s?.currency || currency).toUpperCase(),
      durationMin: Math.round(Number(s?.duration_min)),
    };
  });
  const hours = Object.fromEntries(
    WEEKDAY_KEYS.map((d) => [
      d,
      (Array.isArray(raw?.weekly_hours?.[d]) ? raw.weekly_hours[d] : []).map((w: any) => [String(w?.open ?? ""), String(w?.close ?? "")]),
    ]),
  ) as BusinessBrain["hours"];
  const discounts: DiscountRule[] = (Array.isArray(raw?.discount_rules) ? raw.discount_rules : []).map((d: any, i: number) => {
    const kind = d?.pct_or_amount?.kind;
    const value = Number(d?.pct_or_amount?.value);
    return {
      id: `discount_${i + 1}`,
      description: String(d?.description ?? "").trim(),
      percentOff: kind === "pct" ? value : null,
      amountOffCents: kind === "amount" ? Math.round(value * 100) : null,
      serviceIds: (Array.isArray(d?.conditions?.service_ids) ? d.conditions.service_ids : []).map(String),
      weekdays: (Array.isArray(d?.conditions?.weekdays) ? d.conditions.weekdays : []).map((w: unknown) => String(w).toLowerCase().slice(0, 3) as Weekday),
      conditions: String(d?.conditions?.note ?? "").trim(),
    };
  });
  const adjectives = (Array.isArray(raw?.tone?.adjectives) ? raw.tone.adjectives : []).map(String).slice(0, 5);
  const brain: BusinessBrain = {
    name: String(raw?.business_name ?? "").trim(),
    timezone: String(raw?.timezone || defaults.timezone).trim(),
    languages: (Array.isArray(raw?.languages) && raw.languages.length ? raw.languages : ["English"]).map(String),
    tone: { adjectives, example: String(raw?.tone?.example_sentence ?? "").trim() },
    currency,
    services,
    hours,
    discounts,
    bookingPolicy: { approvalRequired: true },
    doNotSay: (Array.isArray(raw?.do_not_say) ? raw.do_not_say : []).map(String).filter((x: string) => x.trim()),
  };
  return { brain, errors: validateBrain(brain) };
}

/** Typed text or a transcript -> Spark extraction -> a new DRAFT brain version. */
export async function extractBrainDraft(
  deps: EngineDeps,
  input: { businessId: string; text: string; source: Omit<BrainSource, "text"> },
): Promise<BrainVersion> {
  const text = input.text.trim();
  if (!text) throw new OnboardingError("nothing to extract: the text is empty", 400);
  if (!deps.gateway) throw new OnboardingError(`model unavailable: ${deps.gatewayError ?? "no gateway"}`, 503);
  const current = await deps.store.getBrain(input.businessId, { approvedOnly: true });
  const defaults = { timezone: current?.brain.timezone ?? "Asia/Jerusalem", currency: current?.brain.currency ?? "ILS" };
  const r = await deps.gateway.call({
    kind: "chat",
    model: deps.model,
    maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    reasoningEffort: ENGINE_REASONING_EFFORT,
    jsonSchema: EXTRACTION_SCHEMA,
    messages: [
      { role: "system", content: extractionPrompt(defaults) },
      { role: "user", content: text },
    ],
    businessId: input.businessId,
  });
  if (r.outcome === "denied") throw new OnboardingError(`extraction refused: ${r.reason}: ${r.detail}`, 503);
  if (r.outcome === "failed") throw new OnboardingError(`extraction failed (status ${r.status})`, 502, { errorBody: r.errorBody });
  const parsed = parseJsonObject(r.output);
  if (!parsed.ok) throw new OnboardingError(`extraction returned no usable JSON: ${parsed.error}`, 422, { raw: r.output ?? null });
  const { brain, errors } = brainFromExtraction(parsed.value, defaults);
  if (errors.length) throw new OnboardingError("extracted brain is invalid", 422, { errors, raw: r.output ?? null });
  return deps.store.addBrainVersion(input.businessId, brain, { ...input.source, text });
}

/** Strips code fences and surrounding prose and parses one JSON object. */
function parseJsonObject(raw: string | undefined): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!raw?.trim()) return { ok: false, error: "empty reply" };
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    try {
      const value = JSON.parse(candidate);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return { ok: true, value };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: "reply is not a JSON object" };
}

// ---- owner review ----------------------------------------------------------

async function draft(store: Storage, businessId: string, version: number): Promise<BrainVersion> {
  const v = (await store.listBrainVersions(businessId)).find((x) => x.version === version);
  if (!v) throw new OnboardingError(`brain version ${version} not found`, 404);
  if (v.approved) throw new OnboardingError(`brain version ${version} is already approved`, 409);
  return v;
}

/** Saves owner edits to a draft after the same validation as extraction. */
export async function saveDraftEdits(store: Storage, businessId: string, version: number, brain: BusinessBrain): Promise<BrainVersion> {
  await draft(store, businessId, version);
  const fixed: BusinessBrain = { ...brain, bookingPolicy: { approvalRequired: true } };
  const errors = validateBrain(fixed);
  if (errors.length) throw new OnboardingError("brain is invalid", 400, { errors });
  return store.updateBrainDraft(businessId, version, fixed);
}

/** Approves a draft (saving final edits first); the engine uses it from the next message. */
export async function approveDraft(store: Storage, businessId: string, version: number, brain?: BusinessBrain): Promise<BrainVersion> {
  if (brain) await saveDraftEdits(store, businessId, version, brain);
  else await draft(store, businessId, version);
  return store.approveBrainVersion(businessId, version);
}

export async function discardDraft(store: Storage, businessId: string, version: number): Promise<void> {
  await draft(store, businessId, version);
  await store.deleteBrainDraft(businessId, version);
}
