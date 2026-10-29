import { errorResponse, json, ownerOnly } from "@/lib/engine/http";
import { decideCreative } from "@/lib/content/creative";
import { getStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  try {
    return json(await decideCreative(await getStore(), (await params).id, "approved"));
  } catch (err) {
    return errorResponse(err);
  }
}
