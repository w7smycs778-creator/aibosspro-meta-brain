import { usdToNano, type NanoUsd } from "./money";
import type { Env } from "./types";

/** Application ceiling from BUILD-PLAN.md; the env value may lower it, never raise it. */
export const MAX_HARD_CAP_USD = 130;
export const CREDIT_BUFFER_USD = 20;

export type GatewayBounds = {
  maxOutputTokens: number;
  maxInputBytes: number;
  maxMediaBytes: number;
  maxImagesPerCall: number;
  maxRetries: number;
  maxRounds: number;
};

export const DEFAULT_BOUNDS: GatewayBounds = {
  maxOutputTokens: 4_096,
  maxInputBytes: 200_000,
  maxMediaBytes: 10 * 1024 * 1024,
  maxImagesPerCall: 4,
  maxRetries: 2,
  maxRounds: 8,
};

export type SpendConfig = {
  hardCapNano: NanoUsd;
  creditBalanceNano: NanoUsd;
  bufferNano: NanoUsd;
};

export class GatewayConfigError extends Error {}

function readUsd(env: Env, name: string): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new GatewayConfigError(`${name} is not set`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new GatewayConfigError(`${name} is not a non-negative number`);
  }
  return value;
}

/** MODEL_SPEND_HARD_CAP_USD, required with no default; checked at server start. */
export function loadHardCapNano(env: Env = process.env): NanoUsd {
  const capUsd = readUsd(env, "MODEL_SPEND_HARD_CAP_USD");
  if (capUsd > MAX_HARD_CAP_USD) {
    throw new GatewayConfigError(`MODEL_SPEND_HARD_CAP_USD exceeds the $${MAX_HARD_CAP_USD} ceiling`);
  }
  return usdToNano(capUsd);
}

export const DEFAULT_TOOL_LOOP_MAX_ITERATIONS = 6;

/** TOOL_LOOP_MAX_ITERATIONS: model rounds per customer turn, 1..maxRounds, default 6. */
export function loadMaxToolIterations(env: Env = process.env): number {
  const raw = env.TOOL_LOOP_MAX_ITERATIONS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TOOL_LOOP_MAX_ITERATIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > DEFAULT_BOUNDS.maxRounds) {
    throw new GatewayConfigError(`TOOL_LOOP_MAX_ITERATIONS must be an integer in 1..${DEFAULT_BOUNDS.maxRounds}`);
  }
  return n;
}

/**
 * MODEL_SPEND_HARD_CAP_USD: application cap, at most $130.
 * MODEL_CREDIT_BALANCE_USD: credit remaining in Billing when the ledger starts.
 * A missing balance is an unknown balance, so configuration fails closed.
 */
export function loadSpendConfig(env: Env = process.env): SpendConfig {
  return {
    hardCapNano: loadHardCapNano(env),
    creditBalanceNano: usdToNano(readUsd(env, "MODEL_CREDIT_BALANCE_USD")),
    bufferNano: usdToNano(CREDIT_BUFFER_USD),
  };
}
