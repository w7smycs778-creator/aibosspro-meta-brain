import type { DenyReason } from "./types";

/**
 * Thrown by a dispatcher before any network request is made. The gateway
 * releases the attempt's reservation instead of settling it.
 */
export class PreDispatchError extends Error {
  constructor(
    readonly reason: DenyReason,
    message: string,
  ) {
    super(message);
  }
}

export class LiveCreditsNotVerifiedError extends PreDispatchError {
  constructor() {
    super("live_credits_not_verified", "LIVE_CREDITS_VERIFIED is not 'true'; the Meta dispatcher is blocked");
  }
}
