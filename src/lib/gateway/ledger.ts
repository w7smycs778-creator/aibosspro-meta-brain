import type { NanoUsd } from "./money";

export type LedgerLimits = {
  /** Application hard cap on settled + reserved spend. */
  hardCapNano: NanoUsd;
  /** Account credit remaining when this ledger started counting. */
  creditBalanceNano: NanoUsd;
  /** Credit that is never spent. */
  bufferNano: NanoUsd;
};

export type ReserveRequest = {
  amountNano: NanoUsd;
  model: string;
  runId?: string;
  /** Optional cap on settled + reserved spend within runId. */
  runCapNano?: NanoUsd;
  businessId?: string;
  turnId?: string;
};

export type ReserveResult =
  | { granted: true; reservationId: string }
  | { granted: false; reason: "hard_cap_reached" | "run_cap_reached" | "insufficient_credit"; detail: string };

export type LedgerSnapshot = {
  settledNano: NanoUsd;
  reservedNano: NanoUsd;
  runSettledNano: NanoUsd;
  runReservedNano: NanoUsd;
};

/** Provider-reported tokens for one settled attempt; zero for non-chat models. */
export type SpendUsage = { tokensIn: number; tokensOut: number };

/**
 * Spend ledger. reserve() must check every limit and record the reservation
 * atomically: no two concurrent reservations may both pass a check that only
 * one of them fits.
 */
export interface SpendLedger {
  reserve(req: ReserveRequest): Promise<ReserveResult>;
  /** Replace a reservation with its actual cost (may exceed the reservation). */
  settle(reservationId: string, actualNano: NanoUsd, usage?: SpendUsage): Promise<void>;
  /** Drop a reservation for an attempt that never reached the provider. */
  release(reservationId: string): Promise<void>;
  snapshot(runId?: string): Promise<LedgerSnapshot>;
}

/**
 * Durable ledger rows. Every limit check sums the stored rows inside one
 * transaction (LocalStore: SQLite immediate transaction; SupabaseStore: row
 * lock in reserve_model_spend), never a counter held in memory.
 */
export interface SpendLedgerStore {
  reserveSpend(req: ReserveRequest, limits: LedgerLimits): Promise<ReserveResult>;
  settleSpend(reservationId: string, actualNano: NanoUsd, usage: SpendUsage): Promise<void>;
  releaseSpend(reservationId: string): Promise<void>;
  spendTotals(runId?: string): Promise<LedgerSnapshot>;
}

const NO_USAGE: SpendUsage = { tokensIn: 0, tokensOut: 0 };

export class StoreSpendLedger implements SpendLedger {
  constructor(
    private readonly store: SpendLedgerStore,
    private readonly limits: LedgerLimits,
  ) {}

  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    if (!Number.isSafeInteger(req.amountNano) || req.amountNano <= 0) {
      throw new RangeError(`reservation must be a positive integer nano-USD amount: ${req.amountNano}`);
    }
    return this.store.reserveSpend(req, this.limits);
  }

  async settle(reservationId: string, actualNano: NanoUsd, usage: SpendUsage = NO_USAGE): Promise<void> {
    if (!Number.isSafeInteger(actualNano) || actualNano < 0) {
      throw new RangeError(`settlement must be a non-negative integer nano-USD amount: ${actualNano}`);
    }
    await this.store.settleSpend(reservationId, actualNano, usage);
  }

  async release(reservationId: string): Promise<void> {
    await this.store.releaseSpend(reservationId);
  }

  async snapshot(runId?: string): Promise<LedgerSnapshot> {
    return this.store.spendTotals(runId);
  }
}
