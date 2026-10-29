import { liveInferenceStatus } from "@/lib/gateway";
import { getStore } from "@/lib/storage";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";
import { ownerState } from "@/lib/engine/owner";
import { json, ownerOnly } from "@/lib/engine/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const store = await getStore();
  return json({ ...(await ownerState(store, SEED_BUSINESS_ID)), inference: await liveInferenceStatus(process.env, store) });
}
