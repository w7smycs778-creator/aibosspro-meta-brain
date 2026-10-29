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

/**
 * Finishes turns a previous process left half done (a recorded tool call with
 * no result, a reply still pending delivery). No model calls. Best effort: a
 * failure is logged and the server keeps starting.
 */
export async function resumeAtStartup(env: Env = process.env): Promise<void> {
  try {
    const { getStore } = await import("./storage");
    const { resumeBusiness } = await import("./engine/resume");
    const { channelDeliver } = await import("./engine/delivery");
    const { SEED_BUSINESS_ID } = await import("./storage/seed");
    const report = await resumeBusiness({ store: await getStore(), deliver: channelDeliver, now: () => new Date() }, env.WHATSAPP_BUSINESS_ID || SEED_BUSINESS_ID);
    console.log("resume at startup", report);
  } catch (err) {
    console.error("resume at startup failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
