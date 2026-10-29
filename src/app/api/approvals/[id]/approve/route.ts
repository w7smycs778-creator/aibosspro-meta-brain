import { getStore } from "@/lib/storage";
import { decideBooking } from "@/lib/engine/owner";
import { json, ownerOnly } from "@/lib/engine/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const { id } = await params;
  const store = await getStore();
  if (!(await store.getApproval(id))) return json({ error: "approval not found" }, 404);
  return json(await decideBooking(store, id, "approved"));
}
