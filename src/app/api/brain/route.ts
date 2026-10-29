import { getStore } from "@/lib/storage";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";
import { json, ownerOnly } from "@/lib/engine/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every brain version, newest first, with its source (transcript or typed text). */
export async function GET(): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  return json({ versions: await (await getStore()).listBrainVersions(SEED_BUSINESS_ID) });
}
