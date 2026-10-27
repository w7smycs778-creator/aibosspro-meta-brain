import { loadSpendConfig } from "./config";
import { SpendGateway, type GatewayOptions } from "./gateway";
import { InMemorySpendLedger, type SpendLedger } from "./ledger";
import { MetaDispatcher } from "./meta-dispatcher";
import type { Env } from "./types";

export { SpendGateway } from "./gateway";
export { InMemorySpendLedger } from "./ledger";
export type { SpendLedger, LedgerLimits, LedgerSnapshot } from "./ledger";
export { loadSpendConfig, CREDIT_BUFFER_USD, MAX_HARD_CAP_USD, DEFAULT_BOUNDS } from "./config";
export { usdToNano, nanoToUsd, formatUsd } from "./money";
export { estimateMaxCost, actualCost, PRICES } from "./pricing";
export type * from "./types";

/**
 * Gateway wired to the real Meta Model API. The dispatcher stays blocked
 * unless LIVE_CREDITS_VERIFIED=true at call time.
 */
export function createLiveGateway(
  opts: { ledger?: SpendLedger; run?: GatewayOptions["run"]; env?: Env } = {},
): SpendGateway {
  const env = opts.env ?? process.env;
  const ledger = opts.ledger ?? new InMemorySpendLedger(loadSpendConfig(env));
  return new SpendGateway({ ledger, dispatcher: new MetaDispatcher(env), run: opts.run });
}
