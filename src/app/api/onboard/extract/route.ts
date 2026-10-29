import { engineDeps } from "@/lib/engine/deps";
import { errorResponse, json, ownerOnly, readJson } from "@/lib/engine/http";
import { extractBrainDraft } from "@/lib/engine/onboarding";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 8_000;

/** { text, sourceKind: "voice" | "text", audioPath? } -> a new DRAFT brain version. */
export async function POST(req: Request): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const body = await readJson(req);
  const text = body?.text;
  const kind = body?.sourceKind === "voice" ? "voice" : "text";
  if (typeof text !== "string" || !text.trim()) return json({ error: "text is required" }, 400);
  if (text.length > MAX_TEXT) return json({ error: `text is longer than ${MAX_TEXT} characters` }, 400);
  const audioPath = kind === "voice" && typeof body?.audioPath === "string" ? body.audioPath : null;
  try {
    const version = await extractBrainDraft(await engineDeps(), { businessId: SEED_BUSINESS_ID, text, source: { kind, audioPath } });
    return json({ version });
  } catch (err) {
    return errorResponse(err);
  }
}
