import { createLiveGateway, SpendGateway, StoreSpendLedger, loadSpendConfig } from "../gateway";
import { MOCK_MODEL, MOCK_PRICES, MockModelClient } from "../gateway/mock-client";
import type { Env } from "../gateway/types";
import { getStore } from "../storage";
import type { Storage } from "../storage/types";
import { DEMO_SCRIPT } from "./demo-script";

export const AI_DISCLOSURE = "[AI assistant] ";
export const OWNER_HELP_REPLY = "Thanks, I've passed this to the team and someone will get back to you shortly.";
export const ENGINE_MAX_OUTPUT_TOKENS = 1_024;

export type EngineDeps = {
  store: Storage;
  /** null when the live gateway cannot be configured; the turn then goes to the owner. */
  gateway: SpendGateway | null;
  gatewayError?: string;
  model: string;
  now: () => Date;
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
    return { store, gateway: createLiveGateway({ store, env }), model, now };
  } catch (err) {
    return { store, gateway: null, gatewayError: (err as Error).message, model, now };
  }
}

/** The owner screen and its APIs have no auth yet, so they run locally only. */
export function ownerScreenAllowed(env: Env = process.env): boolean {
  return !env.VERCEL;
}
