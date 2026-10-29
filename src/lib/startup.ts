import { loadHardCapNano } from "./gateway/config";
import type { Env } from "./gateway/types";
import { resolveBackend } from "./storage";

/**
 * Server start check. Throws when MODEL_SPEND_HARD_CAP_USD is missing or
 * invalid or the storage backend is invalid for this host.
 */
export function assertStartupConfig(env: Env = process.env): void {
  loadHardCapNano(env);
  resolveBackend(env);
}

/**
 * Exits the process on a bad config. A thrown error alone leaves the Next.js
 * server listening and failing every request.
 */
export function refuseStartOnBadConfig(env: Env = process.env): void {
  try {
    assertStartupConfig(env);
  } catch (err) {
    console.error(`startup refused: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
