import type { Storage } from "../storage/types";
import { loadSpendConfig } from "./config";
import { SpendGateway, type GatewayOptions } from "./gateway";
import { StoreSpendLedger } from "./ledger";
import { MetaDispatcher } from "./meta-dispatcher";
import type { Env } from "./types";

export { SpendGateway } from "./gateway";
export { StoreSpendLedger } from "./ledger";
export type { SpendLedger, SpendLedgerStore, LedgerLimits, LedgerSnapshot, SpendUsage } from "./ledger";
export {
  loadSpendConfig,
  loadHardCapNano,
  loadMaxToolIterations,
  CREDIT_BUFFER_USD,
  MAX_HARD_CAP_USD,
  DEFAULT_BOUNDS,
  DEFAULT_TOOL_LOOP_MAX_ITERATIONS,
} from "./config";
export { usdToNano, nanoToUsd, formatUsd } from "./money";
export { estimateMaxCost, actualCost, PRICES } from "./pricing";
export { runToolLoop } from "./tool-loop";
export type { ToolLoopInput, ToolLoopResult, OwnerHelpReason } from "./tool-loop";
export { DEFAULT_TOOLS, listServicesTool, requestBookingTool, permittedToolNames } from "./tools";
export type { ToolSpec, ToolContext } from "./tools";
export type * from "./types";

/**
 * Gateway wired to the real Meta Model API, with the spend ledger in store.
 * The dispatcher stays blocked unless, at call time, LIVE_CREDITS_VERIFIED=true,
 * STORAGE_BACKEND=supabase, store is the Supabase store and its ledger table
 * answers.
 */
export function createLiveGateway(opts: { store: Storage; run?: GatewayOptions["run"]; env?: Env }): SpendGateway {
  const env = opts.env ?? process.env;
  const ledger = new StoreSpendLedger(opts.store, loadSpendConfig(env));
  return new SpendGateway({ ledger, dispatcher: new MetaDispatcher(env, fetch, opts.store), run: opts.run });
}
