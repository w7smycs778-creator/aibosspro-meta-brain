import { engineDeps } from "@/lib/engine/deps";
import { displayStatus } from "@/lib/engine/creative-qc";
import { errorResponse, json, ownerOnly, readJson } from "@/lib/engine/http";
import { regenerateCreative } from "@/lib/content/creative";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** { object }: new cutout for that object, composites redrawn on the existing scene, new caption, Wonder QC again. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = ownerOnly(req);
  if (blocked) return blocked;
  const { id } = await params;
  const body = await readJson(req);
  try {
    const creative = await regenerateCreative(await engineDeps(), id, { object: typeof body?.object === "string" ? body.object : "", segment: true, caption: true });
    return json({ creative: { ...creative, status: displayStatus(creative) } });
  } catch (err) {
    return errorResponse(err);
  }
}
