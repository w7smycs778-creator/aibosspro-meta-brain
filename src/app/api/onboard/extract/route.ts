import { engineDeps } from "@/lib/engine/deps";
import { errorResponse, json, ownerOnly, readJson, requireBusiness } from "@/lib/engine/http";
import { extractBrainDraft } from "@/lib/engine/onboarding";
import { getStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 8_000;

/** ?business=<id> (or body businessId); { text, sourceKind: "voice" | "text", audioPath? } -> a new DRAFT brain version of that business. */
export async function POST(req: Request): Promise<Response> {
  const blocked = ownerOnly(req);
  if (blocked) return blocked;
  const body = await readJson(req);
  const businessId = await requireBusiness(await getStore(), req, body?.businessId);
  if (businessId instanceof Response) return businessId;
  const text = body?.text;
  const kind = body?.sourceKind === "voice" ? "voice" : "text";
  if (typeof text !== "string" || !text.trim()) return json({ error: "text is required" }, 400);
  if (text.length > MAX_TEXT) return json({ error: `text is longer than ${MAX_TEXT} characters` }, 400);
  const audioPath = kind === "voice" && typeof body?.audioPath === "string" ? body.audioPath : null;
  try {
    const version = await extractBrainDraft(await engineDeps(), { businessId, text, source: { kind, audioPath } });
    return json({ version });
  } catch (err) {
    return errorResponse(err);
  }
}
