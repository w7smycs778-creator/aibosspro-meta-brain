import type { Storage } from "../storage/types";
import { loadHardCapNano } from "./config";
import { HostedInferenceBlockedError, LiveCreditsNotVerifiedError } from "./errors";
import type { Env } from "./types";

/** The store holding the spend ledger the gateway writes to. */
export type LedgerProbe = Pick<Storage, "backend" | "ping" | "isDurable">;

/**
 * Live inference is allowed iff all hold, checked in this order:
 *   1. LIVE_CREDITS_VERIFIED === "true" (read from env, never set by code)
 *   2. MODEL_SPEND_HARD_CAP_USD is set and <= 130
 *   3. store.isDurable()
 *   4. on a hosted deploy (VERCEL set): STORAGE_BACKEND === "supabase", the
 *      store is the Supabase store, and its ledger table answers
 * Throws a PreDispatchError naming the first failed condition.
 */
export async function assertLiveInferenceAllowed(env: Env, store: LedgerProbe | undefined): Promise<void> {
  if (env.LIVE_CREDITS_VERIFIED !== "true") throw new LiveCreditsNotVerifiedError();
  try {
    loadHardCapNano(env);
  } catch (err) {
    throw new HostedInferenceBlockedError((err as Error).message);
  }
  if (!store) throw new HostedInferenceBlockedError("no spend ledger store is attached");
  if (!(await store.isDurable())) {
    throw new HostedInferenceBlockedError(`the ${store.backend} spend ledger is not durable`);
  }
  if (env.VERCEL) {
    if (env.STORAGE_BACKEND !== "supabase" || store.backend !== "supabase") {
      throw new HostedInferenceBlockedError("a hosted deploy requires STORAGE_BACKEND=supabase");
    }
    try {
      await store.ping();
    } catch {
      throw new HostedInferenceBlockedError("the Supabase spend ledger table is unreachable");
    }
  }
}
