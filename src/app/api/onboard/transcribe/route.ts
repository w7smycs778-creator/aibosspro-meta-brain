import { resolve } from "node:path";
import { engineDeps } from "@/lib/engine/deps";
import { errorResponse, json, ownerOnly } from "@/lib/engine/http";
import { transcribeVoiceNote } from "@/lib/engine/onboarding";
import { DEFAULT_LOCAL_DIR } from "@/lib/storage";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** Multipart field "audio": a mono 16-bit 16 kHz WAV (the page converts recordings and uploads). */
export async function POST(req: Request): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const form = await req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof Blob)) return json({ error: 'multipart field "audio" is required' }, 400);
  if (file.size > MAX_AUDIO_BYTES) return json({ error: "audio is larger than 10 MB" }, 413);
  try {
    const audioDir = resolve(process.env.STORAGE_DIR?.trim() || DEFAULT_LOCAL_DIR, "audio");
    const wav = new Uint8Array(await file.arrayBuffer());
    return json(await transcribeVoiceNote(await engineDeps(), { businessId: SEED_BUSINESS_ID, wav, audioDir }));
  } catch (err) {
    return errorResponse(err);
  }
}
