import { loadHardCapNano } from "./gateway/config";
import type { Env } from "./gateway/types";
import { resolveBackend } from "./storage";
import type { Storage } from "./storage/types";

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
 * Warning text when the business inbound WhatsApp messages go to
 * (WHATSAPP_BUSINESS_ID, else the seed business) has no approved brain: every
 * inbound message would then fail. Never includes the value, only its length.
 */
export async function whatsappBusinessWarning(store: Storage, env: Env = process.env): Promise<string | null> {
  const { SEED_BUSINESS_ID } = await import("./storage/seed");
  const raw = env.WHATSAPP_BUSINESS_ID;
  const id = raw || SEED_BUSINESS_ID;
  if (await store.getBrain(id, { approvedOnly: true })) return null;
  const value = raw ? `value length ${raw.length}` : "unset, seed default used";
  return `WHATSAPP_BUSINESS_ID does not resolve to a business with an approved brain (${value}); inbound WhatsApp messages will fail`;
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
    const store = await getStore();
    const warning = await whatsappBusinessWarning(store, env);
    if (warning) console.warn(`startup warning: ${warning}`);
    const report = await resumeBusiness({ store, deliver: channelDeliver, now: () => new Date() }, env.WHATSAPP_BUSINESS_ID || SEED_BUSINESS_ID);
    console.log("resume at startup", report);
  } catch (err) {
    console.error("resume at startup failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
