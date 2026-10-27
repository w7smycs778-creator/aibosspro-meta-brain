import type { NanoUsd } from "./money";
import type { BillingUnits, ModelCall } from "./types";

// Standard-mode prices from https://dev.meta.ai/docs/pricing-rate-limits,
// fetched 2026-10-27 (research/MODEL-PRICES-2026-10-27.md). Nano-USD per unit.
type ChatPrice = { kind: "chat"; inputPerToken: NanoUsd; cachedPerToken: NanoUsd; outputPerToken: NanoUsd };
type TranscribePrice = { kind: "transcribe"; perSecond: NanoUsd };
type PerImagePrice = { kind: "image" | "segment"; perImage: NanoUsd };
type Price = ChatPrice | TranscribePrice | PerImagePrice;

const SPARK: ChatPrice = { kind: "chat", inputPerToken: 1_250, cachedPerToken: 150, outputPerToken: 4_250 };

export const PRICES: Readonly<Record<string, Price>> = {
  "muse-spark-1.3": SPARK,
  "muse-spark-1.1": SPARK,
  // $0.18 per hour, billed in whole seconds.
  "muse-voice-transcribe-1.0": { kind: "transcribe", perSecond: 50_000 },
  // $0.01 per generated image.
  "muse-image-1.0": { kind: "image", perImage: 10_000_000 },
  // $2.50 per 1,000 images.
  "sam-3.1": { kind: "segment", perImage: 2_500_000 },
};

/** Per-message framing allowance on top of content bytes. */
const MESSAGE_OVERHEAD_TOKENS = 16;
/** Lowest-bitrate WAV we accept: 8-bit mono 16 kHz = 16,000 bytes/s. */
const MIN_WAV_BYTES_PER_SECOND = 16_000;

const utf8 = new TextEncoder();

function priceFor(call: ModelCall): Price | null {
  const price = PRICES[call.model];
  return price && price.kind === call.kind ? price : null;
}

/**
 * Upper bound on what one attempt can cost, or null when the cost cannot be
 * bounded (unknown model, or model/kind mismatch). Callers must deny on null.
 */
export function estimateMaxCost(call: ModelCall): NanoUsd | null {
  const price = priceFor(call);
  if (!price) return null;
  switch (call.kind) {
    case "chat": {
      const p = price as ChatPrice;
      // A byte-level tokenizer never emits more tokens than UTF-8 bytes.
      let inputTokens = 0;
      for (const m of call.messages) {
        inputTokens += utf8.encode(m.content).length + MESSAGE_OVERHEAD_TOKENS;
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
  }
}

/** Actual cost from provider-reported units, or null when units are missing. */
export function actualCost(call: ModelCall, units: BillingUnits | null): NanoUsd | null {
  const price = priceFor(call);
  if (!price || !units || units.kind !== call.kind) return null;
  switch (units.kind) {
    case "chat": {
      const p = price as ChatPrice;
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
