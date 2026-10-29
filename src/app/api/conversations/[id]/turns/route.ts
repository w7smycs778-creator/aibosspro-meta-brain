import { getStore } from "@/lib/storage";
import { json, ownerOnly } from "@/lib/engine/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const { id } = await params;
  const store = await getStore();
  if (!(await store.getConversation(id))) return json({ error: "conversation not found" }, 404);
  return json({ turns: await store.listTurns(id) });
}
