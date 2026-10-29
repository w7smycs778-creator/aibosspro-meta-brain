import { DEFAULT_BOUNDS, type GatewayBounds } from "./config";
import { PreDispatchError } from "./errors";
import type { SpendLedger, SpendUsage } from "./ledger";
import type { NanoUsd } from "./money";
import { actualCost, estimateMaxCost, PRICES, type PriceTable } from "./pricing";
import type { AttemptRecord, DenyReason, DispatchResult, Dispatcher, GatewayResult, ModelCall } from "./types";

export type GatewayOptions = {
  ledger: SpendLedger;
  dispatcher: Dispatcher;
  bounds?: Partial<GatewayBounds>;
  /** Scope every call to one run with its own cap (e.g. a $10 smoke run). */
  run?: { id: string; capNano: NanoUsd };
  /** Price table; tests pass one for a mock model. Defaults to PRICES. */
  prices?: PriceTable;
  now?: () => number;
};

const ERROR_BODY_LIMIT = 2_000;

export function boundsViolation(call: ModelCall, b: GatewayBounds): string | null {
  if (call.round !== undefined && (!Number.isInteger(call.round) || call.round < 1 || call.round > b.maxRounds)) {
    return `round ${call.round} outside 1..${b.maxRounds}`;
  }
  switch (call.kind) {
    case "chat": {
      if (!Number.isInteger(call.maxOutputTokens) || call.maxOutputTokens < 1 || call.maxOutputTokens > b.maxOutputTokens) {
        return `maxOutputTokens ${call.maxOutputTokens} outside 1..${b.maxOutputTokens}`;
      }
      const bytes = call.messages.reduce((n, m) => n + Buffer.byteLength(m.content, "utf8"), 0);
      if (bytes > b.maxInputBytes) return `input ${bytes} bytes > ${b.maxInputBytes}`;
      return null;
    }
    case "transcribe":
      return call.audio.byteLength > b.maxMediaBytes ? `audio ${call.audio.byteLength} bytes > ${b.maxMediaBytes}` : null;
    case "image":
      if (!Number.isInteger(call.n) || call.n < 1 || call.n > b.maxImagesPerCall) {
        return `n ${call.n} outside 1..${b.maxImagesPerCall}`;
      }
      return Buffer.byteLength(call.prompt, "utf8") > b.maxInputBytes ? "prompt too long" : null;
    case "segment":
      return call.image.byteLength > b.maxMediaBytes ? `image ${call.image.byteLength} bytes > ${b.maxMediaBytes}` : null;
  }
}

/**
 * The only path to a billable model call. Each attempt (first try and every
 * retry) reserves its conservative maximum cost before dispatch and settles to
 * the provider-reported cost afterward; when the provider reports no units the
 * attempt settles at the full reservation. The ledger row is written at
 * reserve and settled before the result is returned to the caller.
 */
export class SpendGateway {
  private readonly bounds: GatewayBounds;
  private readonly now: () => number;
  private readonly prices: PriceTable;

  constructor(private readonly opts: GatewayOptions) {
    this.bounds = { ...DEFAULT_BOUNDS, ...opts.bounds };
    this.prices = opts.prices ?? PRICES;
    this.now = opts.now ?? (() => performance.now());
  }

  async call(call: ModelCall): Promise<GatewayResult> {
    const attempts: AttemptRecord[] = [];
    const deny = (reason: DenyReason, detail: string): GatewayResult => ({
      outcome: "denied",
      model: call.model,
      reason,
      detail,
      attempts,
      reservedNano: sum(attempts, "reservedNano"),
      settledNano: sum(attempts, "settledNano"),
    });

    const violation = boundsViolation(call, this.bounds);
    if (violation) return deny("bounds_exceeded", violation);

    const estimate = estimateMaxCost(call, this.prices);
    if (estimate === null || !Number.isSafeInteger(estimate) || estimate <= 0) {
      return deny("unknown_cost", `no bounded price for ${call.kind} on ${call.model}`);
    }

    const { ledger, dispatcher, run } = this.opts;
    try {
      await dispatcher.preflight?.();
    } catch (err) {
      if (err instanceof PreDispatchError) return deny(err.reason, err.message);
      throw err;
    }

    const maxAttempts = 1 + this.bounds.maxRetries;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const r = await ledger.reserve({
        amountNano: estimate,
        model: call.model,
        runId: run?.id,
        runCapNano: run?.capNano,
        businessId: call.businessId,
        turnId: call.turnId,
      });
      if (!r.granted) return deny(r.reason, r.detail);

      const started = this.now();
      let result: DispatchResult;
      try {
        result = await dispatcher.dispatch(call);
      } catch (err) {
        if (err instanceof PreDispatchError) {
          await ledger.release(r.reservationId);
          return deny(err.reason, err.message);
        }
        // The request may have reached the provider; treat it as billed.
        result = { ok: false, status: 0, retryable: true, units: null, errorBody: errorText(err) };
      }
      const latencyMs = Math.round(this.now() - started);
      const settledNano = actualCost(call, result.units, this.prices) ?? estimate;
      await ledger.settle(r.reservationId, settledNano, usageOf(result));
      attempts.push({ attempt, status: result.status, reservedNano: estimate, settledNano, latencyMs });

      if (result.ok || !result.retryable || attempt === maxAttempts) {
        return {
          outcome: result.ok ? "ok" : "failed",
          model: call.model,
          status: result.status,
          output: result.output,
          toolCalls: result.toolCalls,
          protocolError: result.protocolError,
          errorBody: result.errorBody?.slice(0, ERROR_BODY_LIMIT),
          attempts,
          reservedNano: sum(attempts, "reservedNano"),
          settledNano: sum(attempts, "settledNano"),
          latencyMs: sum(attempts, "latencyMs"),
        };
      }
    }
    throw new Error("unreachable");
  }
}

function sum(attempts: AttemptRecord[], key: "reservedNano" | "settledNano" | "latencyMs"): number {
  return attempts.reduce((n, a) => n + a[key], 0);
}

function usageOf(result: DispatchResult): SpendUsage {
  const units = result.units;
  const tokens: Pick<SpendUsage, "tokensIn" | "tokensOut" | "reasoningTokens"> =
    units?.kind === "chat"
      ? { tokensIn: units.promptTokens, tokensOut: units.completionTokens, reasoningTokens: units.reasoningTokens ?? null }
      : { tokensIn: 0, tokensOut: 0, reasoningTokens: null };
  return {
    ...tokens,
    finishReason: result.finishReason ?? null,
    usageRaw: result.usageRaw === undefined ? null : JSON.stringify(result.usageRaw).slice(0, 2_000),
  };
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.slice(0, ERROR_BODY_LIMIT);
}
