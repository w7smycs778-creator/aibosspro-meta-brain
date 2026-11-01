import { getStore } from "@/lib/storage";
import { json, ownerOnly, requireBusiness } from "@/lib/engine/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ?business=<id>: every brain version of that business, newest first, with its source (transcript or typed text). */
export async function GET(req: Request): Promise<Response> {
  const blocked = ownerOnly(req);
  if (blocked) return blocked;
  const store = await getStore();
  const businessId = await requireBusiness(store, req);
  if (businessId instanceof Response) return businessId;
  const business = await store.getBusiness(businessId);
  return json({ businessId, businessName: business?.name ?? businessId, versions: await store.listBrainVersions(businessId) });
}
