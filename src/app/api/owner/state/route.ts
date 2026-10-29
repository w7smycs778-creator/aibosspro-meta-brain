import { getStore } from "@/lib/storage";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";
import { ownerState } from "@/lib/engine/owner";
import { json, ownerOnly } from "@/lib/engine/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  return json(await ownerState(await getStore(), SEED_BUSINESS_ID));
}
