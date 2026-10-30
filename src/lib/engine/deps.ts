import { createLiveGateway, SpendGateway, StoreSpendLedger, loadSpendConfig, usdToNano } from "../gateway";
import { MOCK_MODEL, MOCK_PRICES, MockModelClient } from "../gateway/mock-client";
import type { Env } from "../gateway/types";
import { getStore } from "../storage";
import type { Storage } from "../storage/types";
import { DEMO_SCRIPT } from "./demo-script";
import type { Deliver } from "./delivery";
import { detectLanguage, STRINGS, type Lang } from "./i18n";

export const AI_DISCLOSURE = STRINGS.en.disclosure;
export const OWNER_HELP_REPLY = STRINGS.en.ownerHelp;

/**
 * The AI disclosure in the reply's language (fallback: the business's first
 * language). A Latin-script prefix on a Hebrew reply would make the whole
 * message render left to right in the panel and on WhatsApp.
 */
export function disclosureFor(reply: string, fallback: Lang = "en"): string {
  return STRINGS[detectLanguage(reply, fallback)].disclosure;
}
/** Spark counts reasoning inside max_completion_tokens; 1,024 ran out before the JSON on 2026-10-29. */
export const ENGINE_MAX_OUTPUT_TOKENS = 2_048;
export const ENGINE_REASONING_EFFORT = "low" as const;

export type EngineDeps = {
  store: Storage;
  /** null when the live gateway cannot be configured; the turn then goes to the owner. */
  gateway: SpendGateway | null;
  gatewayError?: string;
  model: string;
  now: () => Date;
  /** Outbound sender per channel; defaults to channelDeliver (panel: no push, WhatsApp: Cloud API). */
  deliver?: Deliver;
};

let mockGateway: SpendGateway | undefined;

/**
 * Store plus gateway for the running server. MODEL_CLIENT=mock (local only)
 * answers from the demo script at about $0.000001 per call; otherwise the
 * live gateway, which stays behind the inference gate.
 */
export async function engineDeps(env: Env = process.env): Promise<EngineDeps> {
  const store = await getStore();
  const now = () => new Date();
  if (env.MODEL_CLIENT === "mock") {
    if (env.VERCEL) throw new Error("MODEL_CLIENT=mock is local only");
    mockGateway ??= new SpendGateway({
      ledger: new StoreSpendLedger(store, loadSpendConfig({ MODEL_SPEND_HARD_CAP_USD: "130", MODEL_CREDIT_BALANCE_USD: "150" })),
      dispatcher: new MockModelClient(DEMO_SCRIPT),
      prices: MOCK_PRICES,
    });
    return { store, gateway: mockGateway, model: MOCK_MODEL, now };
  }
  const model = env.MODEL_CHAT_MODEL?.trim() || "muse-spark-1.3";
  try {
    return { store, gateway: createLiveGateway({ store, env, ...liveRun(env) }), model, now };
  } catch (err) {
    return { store, gateway: null, gatewayError: (err as Error).message, model, now };
  }
}

/**
 * Optional bounded live run: MODEL_RUN_ID with MODEL_RUN_CAP_USD (spend cap for
 * the run) and MODEL_RUN_MAX_CALLS (billable attempts, retries included).
 */
function liveRun(env: Env): { run?: { id: string; capNano: number }; maxCalls?: number } {
  const id = env.MODEL_RUN_ID?.trim();
  if (!id) return {};
  const capUsd = Number(env.MODEL_RUN_CAP_USD);
  const maxCalls = Number(env.MODEL_RUN_MAX_CALLS);
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error("MODEL_RUN_ID needs a positive MODEL_RUN_CAP_USD");
  if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new Error("MODEL_RUN_ID needs MODEL_RUN_MAX_CALLS >= 1");
  return { run: { id, capNano: usdToNano(capUsd) }, maxCalls };
}

/** The owner screen and its APIs have no auth yet, so they run locally only. */
export function ownerScreenAllowed(env: Env = process.env): boolean {
  return !env.VERCEL;
}
