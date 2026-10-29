import { errorResponse, json, ownerOnly, readJson } from "@/lib/engine/http";
import { editCaption } from "@/lib/content/creative";
import { getStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner edits the caption: { caption }. Saved as written; the verifier's result is recorded alongside. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const caption = (await readJson(req))?.caption;
  if (typeof caption !== "string") return json({ error: "caption is required" }, 400);
  try {
    return json({ creative: await editCaption(await getStore(), (await params).id, caption) });
  } catch (err) {
    return errorResponse(err);
  }
}
