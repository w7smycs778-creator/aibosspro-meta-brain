import { liveInferenceStatus } from "@/lib/gateway";
import { getStore } from "@/lib/storage";
import { ownerState } from "@/lib/engine/owner";
import { json, ownerOnly, resolveBusiness } from "@/lib/engine/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ?business=<id> selects the business (default: the original demo business). */
export async function GET(req: Request): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const store = await getStore();
  const businessId = await resolveBusiness(store, new URL(req.url).searchParams.get("business"));
  if (businessId instanceof Response) return businessId;
  const businesses = (await store.listBusinesses()).map((b) => ({ id: b.id, name: b.name }));
  return json({ ...(await ownerState(store, businessId)), businesses, inference: await liveInferenceStatus(process.env, store) });
}
