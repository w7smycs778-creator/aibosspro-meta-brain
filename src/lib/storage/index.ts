import type { Env } from "../gateway/types";
import { StorageConfigError } from "./errors";
import type { Storage, StorageBackend } from "./types";

export { StorageConfigError } from "./errors";
export { SEED_BRAIN, SEED_BUSINESS_ID } from "./seed";
export type * from "./types";

export const DEFAULT_LOCAL_DIR = "./data";

/**
 * STORAGE_BACKEND=local|supabase, default local. A hosted deploy (Vercel sets
 * VERCEL) has no durable local disk, so local is refused there.
 */
export function resolveBackend(env: Env = process.env): StorageBackend {
  const raw = env.STORAGE_BACKEND?.trim() || "local";
  if (raw !== "local" && raw !== "supabase") {
    throw new StorageConfigError(`STORAGE_BACKEND must be "local" or "supabase", got "${raw}"`);
  }
  if (raw === "local" && env.VERCEL) {
    throw new StorageConfigError("STORAGE_BACKEND=local is not allowed on a hosted deploy; set STORAGE_BACKEND=supabase");
  }
  return raw;
}

/** Opens a new store. Backends load lazily so the SQLite driver never loads with supabase. */
export async function createStore(env: Env = process.env): Promise<Storage> {
  if (resolveBackend(env) === "supabase") {
    const { SupabaseStore } = await import("./supabase-store");
    return SupabaseStore.fromEnv(env);
  }
  const { LocalStore } = await import("./local-store");
  return LocalStore.open(env.STORAGE_DIR?.trim() || DEFAULT_LOCAL_DIR);
}

let shared: Promise<Storage> | undefined;

/** Process-wide store; a failed open is retried on the next call. */
export function getStore(): Promise<Storage> {
  shared ??= createStore().catch((err) => {
    shared = undefined;
    throw err;
  });
  return shared;
}
