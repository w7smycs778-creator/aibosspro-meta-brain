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

/**
 * Spend ledger. reserve() must check every limit and record the reservation
 * atomically: no two concurrent reservations may both pass a check that only
 * one of them fits. The Supabase implementation does this under a row lock
 * (supabase/migrations/20261027120000_model_spend_ledger.sql).
 */
export interface SpendLedger {
  reserve(req: ReserveRequest): Promise<ReserveResult>;
  /** Replace a reservation with its actual cost (may exceed the reservation). */
  settle(reservationId: string, actualNano: NanoUsd): Promise<void>;
  /** Drop a reservation for an attempt that never reached the provider. */
  release(reservationId: string): Promise<void>;
  snapshot(runId?: string): Promise<LedgerSnapshot>;
}

type Entry = { runId?: string; model: string; reservedNano: NanoUsd; state: "reserved" | "settled" | "released"; settledNano: NanoUsd };

export class InMemorySpendLedger implements SpendLedger {
  private readonly entries = new Map<string, Entry>();
  private settled = 0;
  private reserved = 0;
  private nextId = 1;

  constructor(private readonly limits: LedgerLimits) {}

  // The body runs synchronously with no await between check and write, so on
  // the single JS event loop each reservation is atomic.
  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const amount = req.amountNano;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new RangeError(`reservation must be a positive integer nano-USD amount: ${amount}`);
    }
    const committed = this.settled + this.reserved;
    if (committed + amount > this.limits.hardCapNano) {
      return { granted: false, reason: "hard_cap_reached", detail: `committed ${committed} + ${amount} > cap ${this.limits.hardCapNano}` };
    }
    const spendable = this.limits.creditBalanceNano - this.limits.bufferNano - committed;
    if (amount > spendable) {
      return { granted: false, reason: "insufficient_credit", detail: `spendable ${spendable} after buffer < ${amount}` };
    }
    if (req.runCapNano !== undefined) {
      const run = this.runTotals(req.runId);
      const runCommitted = run.runSettledNano + run.runReservedNano;
      if (runCommitted + amount > req.runCapNano) {
        return { granted: false, reason: "run_cap_reached", detail: `run ${runCommitted} + ${amount} > run cap ${req.runCapNano}` };
      }
    }
    const reservationId = `r${this.nextId++}`;
    this.entries.set(reservationId, { runId: req.runId, model: req.model, reservedNano: amount, state: "reserved", settledNano: 0 });
    this.reserved += amount;
    return { granted: true, reservationId };
  }

  async settle(reservationId: string, actualNano: NanoUsd): Promise<void> {
    if (!Number.isSafeInteger(actualNano) || actualNano < 0) {
      throw new RangeError(`settlement must be a non-negative integer nano-USD amount: ${actualNano}`);
    }
    const e = this.open(reservationId);
    this.reserved -= e.reservedNano;
    this.settled += actualNano;
    e.state = "settled";
    e.settledNano = actualNano;
  }

  async release(reservationId: string): Promise<void> {
    const e = this.open(reservationId);
    this.reserved -= e.reservedNano;
    e.state = "released";
  }

  async snapshot(runId?: string): Promise<LedgerSnapshot> {
    return { settledNano: this.settled, reservedNano: this.reserved, ...this.runTotals(runId) };
  }

  private open(reservationId: string): Entry {
    const e = this.entries.get(reservationId);
    if (!e || e.state !== "reserved") {
      throw new Error(`reservation ${reservationId} is not open`);
    }
    return e;
  }

  private runTotals(runId?: string): { runSettledNano: NanoUsd; runReservedNano: NanoUsd } {
    let runSettledNano = 0;
    let runReservedNano = 0;
    if (runId === undefined) return { runSettledNano, runReservedNano };
    for (const e of this.entries.values()) {
      if (e.runId !== runId) continue;
      if (e.state === "reserved") runReservedNano += e.reservedNano;
      if (e.state === "settled") runSettledNano += e.settledNano;
    }
    return { runSettledNano, runReservedNano };
  }
}
