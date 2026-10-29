// Hard cap on billable attempts within one run, counted from the durable
// ledger so it holds across requests, retries and gateway instances.
import type { Storage } from "../storage/types";
import { PreDispatchError } from "./errors";
import type { DispatchResult, Dispatcher, ModelCall } from "./types";

export class CallLimitDispatcher implements Dispatcher {
  constructor(
    private readonly inner: Dispatcher,
    private readonly store: Pick<Storage, "listSpend">,
    private readonly runId: string,
    private readonly maxCalls: number,
  ) {}

  async preflight(): Promise<void> {
    await this.inner.preflight?.();
  }

  // The gateway reserves this attempt's row before dispatch, so the count includes it.
  async dispatch(call: ModelCall): Promise<DispatchResult> {
    const used = (await this.store.listSpend()).filter((r) => r.runId === this.runId && r.state !== "released").length;
    if (used > this.maxCalls) {
      throw new PreDispatchError("run_cap_reached", `call limit ${this.maxCalls} reached for run ${this.runId}`);
    }
    return this.inner.dispatch(call);
  }
}
