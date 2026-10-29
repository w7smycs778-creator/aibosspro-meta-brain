import { loadSpendConfig } from "./config";
import { assertLiveInferenceAllowed, type LedgerProbe } from "./live-gate";
import { MetaDispatcher } from "./meta-dispatcher";
import type { Env } from "./types";

/**
 * Whether a model call would be dispatched now, and if not, why: the first
 * failed condition of the live gate, the spend configuration or the
 * dispatcher configuration. For the owner screen; it makes no model call.
 */
export async function liveInferenceStatus(env: Env, store: LedgerProbe | undefined): Promise<{ live: boolean; reason: string | null }> {
  if (env.MODEL_CLIENT === "mock") return { live: false, reason: "MODEL_CLIENT=mock: scripted demo replies, no model calls" };
  try {
    await assertLiveInferenceAllowed(env, store);
    loadSpendConfig(env);
  } catch (err) {
    return { live: false, reason: (err as Error).message };
  }
  const configError = MetaDispatcher.configError(env);
  return configError ? { live: false, reason: configError } : { live: true, reason: null };
}
