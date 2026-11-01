import type { NanoUsd } from "./money";
import type { BillingUnits, ChatMessage, ModelCall } from "./types";

// Standard-mode prices from https://dev.meta.ai/docs/pricing-rate-limits,
// fetched 2026-10-27 (research/MODEL-PRICES-2026-10-27.md). Nano-USD per unit.
export type ChatPrice = { kind: "chat"; inputPerToken: NanoUsd; cachedPerToken: NanoUsd; outputPerToken: NanoUsd };
type TranscribePrice = { kind: "transcribe"; perSecond: NanoUsd };
type PerImagePrice = { kind: "image" | "segment"; perImage: NanoUsd };
/** Token-priced like chat; the image's input tokens are not documented, so the reservation assumes VISION_IMAGE_TOKENS. */
export type VisionPrice = { kind: "vision"; inputPerToken: NanoUsd; cachedPerToken: NanoUsd; outputPerToken: NanoUsd };
export type Price = ChatPrice | TranscribePrice | PerImagePrice | VisionPrice;

/**
 * Input tokens reserved for one image. Meta does not document how image input
 * is counted (pricing page fetched 2026-11-01); this is an assumption for the
 * reservation only. Settlement uses the provider-reported prompt tokens.
 */
export const VISION_IMAGE_TOKENS = 8_192;

const SPARK: ChatPrice = { kind: "chat", inputPerToken: 1_250, cachedPerToken: 150, outputPerToken: 4_250 };

export const PRICES: PriceTable = {
  "muse-spark-1.3": SPARK,
  "muse-spark-1.1": SPARK,
  // $0.18 per hour, billed in whole seconds.
  "muse-voice-transcribe-1.0": { kind: "transcribe", perSecond: 50_000 },
  // $0.01 per generated image.
  "muse-image-1.0": { kind: "image", perImage: 10_000_000 },
  // $2.50 per 1,000 images.
  "sam-3.1": { kind: "segment", perImage: 2_500_000 },
  // $4.00 input / $0.20 cached / $20.00 output per 1M tokens (pricing page, fetched 2026-11-01).
  "muse-wonder-1.0": { kind: "vision", inputPerToken: 4_000, cachedPerToken: 200, outputPerToken: 20_000 },
};

/** Per-message framing allowance on top of content bytes. */
const MESSAGE_OVERHEAD_TOKENS = 16;
/** Tool-protocol instructions the dispatcher adds when tools are present. */
const TOOL_PROTOCOL_OVERHEAD_TOKENS = 1_024;
/** Lowest-bitrate WAV we accept: 8-bit mono 16 kHz = 16,000 bytes/s. */
const MIN_WAV_BYTES_PER_SECOND = 16_000;

const utf8 = new TextEncoder();

export type PriceTable = Readonly<Record<string, Price>>;

function messageBytes(m: ChatMessage): number {
  let n = utf8.encode(m.content).length;
  if (m.role === "assistant" && m.toolCalls) n += utf8.encode(JSON.stringify(m.toolCalls)).length;
  return n;
}

function priceFor(call: ModelCall, prices: PriceTable): Price | null {
  const price = prices[call.model];
  return price && price.kind === call.kind ? price : null;
}

/**
 * Upper bound on what one attempt can cost, or null when the cost cannot be
 * bounded (unknown model, or model/kind mismatch). Callers must deny on null.
 */
export function estimateMaxCost(call: ModelCall, prices: PriceTable = PRICES): NanoUsd | null {
  const price = priceFor(call, prices);
  if (!price) return null;
  switch (call.kind) {
    case "chat": {
      const p = price as ChatPrice;
      // A byte-level tokenizer never emits more tokens than UTF-8 bytes.
      let inputTokens = 0;
      for (const m of call.messages) {
        inputTokens += messageBytes(m) + MESSAGE_OVERHEAD_TOKENS;
      }
      if (call.tools?.length) {
        inputTokens += utf8.encode(JSON.stringify(call.tools)).length + TOOL_PROTOCOL_OVERHEAD_TOKENS;
      }
      if (call.jsonSchema) {
        inputTokens += utf8.encode(JSON.stringify(call.jsonSchema)).length + MESSAGE_OVERHEAD_TOKENS;
      }
      return inputTokens * p.inputPerToken + call.maxOutputTokens * p.outputPerToken;
    }
    case "transcribe": {
      const seconds = Math.ceil(call.audio.byteLength / MIN_WAV_BYTES_PER_SECOND) + 1;
      return seconds * (price as TranscribePrice).perSecond;
    }
    case "image":
      return call.n * (price as PerImagePrice).perImage;
    case "segment":
      return (price as PerImagePrice).perImage;
    case "vision": {
      const p = price as VisionPrice;
      let inputTokens = utf8.encode(call.prompt).length + MESSAGE_OVERHEAD_TOKENS + VISION_IMAGE_TOKENS;
      if (call.jsonSchema) inputTokens += utf8.encode(JSON.stringify(call.jsonSchema)).length + MESSAGE_OVERHEAD_TOKENS;
      return inputTokens * p.inputPerToken + call.maxOutputTokens * p.outputPerToken;
    }
  }
}

/** Actual cost from provider-reported units, or null when units are missing. */
export function actualCost(call: ModelCall, units: BillingUnits | null, prices: PriceTable = PRICES): NanoUsd | null {
  const price = priceFor(call, prices);
  if (!price || !units || units.kind !== call.kind) return null;
  switch (units.kind) {
    case "chat":
    case "vision": {
      const p = price as ChatPrice | VisionPrice;
      const cached = Math.min(units.cachedTokens, units.promptTokens);
      return (
        (units.promptTokens - cached) * p.inputPerToken +
        cached * p.cachedPerToken +
        units.completionTokens * p.outputPerToken
      );
    }
    case "transcribe":
      return Math.ceil(units.audioMs / 1000) * (price as TranscribePrice).perSecond;
    case "image":
    case "segment":
      return units.images * (price as PerImagePrice).perImage;
  }
}
