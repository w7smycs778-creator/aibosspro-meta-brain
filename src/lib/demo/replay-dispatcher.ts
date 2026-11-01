// REPLAY's dispatcher: MetaDispatcher's own request building and parsing over
// a fetch that only answers from recorded exchanges. It builds that fetch
// itself and takes no other, so no request can leave the process; the
// live-credit guard (MetaDispatcher.dispatch) is therefore not involved.
import { MetaDispatcher } from "../gateway/meta-dispatcher";
import type { DispatchResult, ModelCall } from "../gateway/types";
import { replayFetch, type Exchange } from "./recorder";

export const REPLAY_BASE_URL = "https://replay.invalid/v1";

export class ReplayDispatcher extends MetaDispatcher {
  private readonly replay: ReturnType<typeof replayFetch>;
  private lastFailure: string | null = null;

  constructor(exchanges: Exchange[], toolMode: string, onExchange?: (e: Exchange) => void) {
    const replay = replayFetch(exchanges, onExchange);
    super({ MODEL_TOOL_MODE: toolMode }, replay);
    this.replay = replay;
  }

  /** Nothing to check: nothing is sent. */
  override async preflight(): Promise<void> {}

  override async dispatch(call: ModelCall): Promise<DispatchResult> {
    try {
      return await this.request(call, REPLAY_BASE_URL, {});
    } catch (err) {
      this.lastFailure = (err as Error).message;
      throw err;
    }
  }

  remaining(): number {
    return this.replay.remaining();
  }

  lastError(): string | null {
    return this.lastFailure;
  }
}
