import { engineDeps } from "@/lib/engine/deps";
import { errorResponse, json, ownerOnly, requireBusiness } from "@/lib/engine/http";
import { transcribeVoiceNote } from "@/lib/engine/onboarding";
import { getStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/**
 * Multipart field "audio": a mono 16-bit 16 kHz WAV (the page converts recordings and uploads).
 * The business comes from ?business= or the form field "businessId". The note is stored in the
 * private bucket when hosted (./data/audio locally) and its ref returned as audioPath.
 */
export async function POST(req: Request): Promise<Response> {
  const blocked = ownerOnly(req);
  if (blocked) return blocked;
  const form = await req.formData().catch(() => null);
  const businessId = await requireBusiness(await getStore(), req, form?.get("businessId"));
  if (businessId instanceof Response) return businessId;
  const file = form?.get("audio");
  if (!(file instanceof Blob)) return json({ error: 'multipart field "audio" is required' }, 400);
  if (file.size > MAX_AUDIO_BYTES) return json({ error: "audio is larger than 10 MB" }, 413);
  try {
    const wav = new Uint8Array(await file.arrayBuffer());
    return json(await transcribeVoiceNote(await engineDeps(), { businessId, wav }));
  } catch (err) {
    return errorResponse(err);
  }
}
