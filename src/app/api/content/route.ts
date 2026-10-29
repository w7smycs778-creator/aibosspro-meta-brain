import { engineDeps } from "@/lib/engine/deps";
import { errorResponse, json, ownerOnly } from "@/lib/engine/http";
import { generateCreative } from "@/lib/content/creative";
import { listOffers } from "@/lib/content/offers";
import { getStore } from "@/lib/storage";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** Offers from the current approved brain, and every creative, newest first. */
export async function GET(): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const store = await getStore();
  const brain = await store.getBrain(SEED_BUSINESS_ID, { approvedOnly: true });
  return json({ brainVersion: brain?.version ?? null, offers: brain ? listOffers(brain.brain) : [], creatives: await store.listCreatives(SEED_BUSINESS_ID) });
}

/** Multipart: photo (jpg/png), offerId, object (what to cut out). */
export async function POST(req: Request): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const form = await req.formData().catch(() => null);
  const photo = form?.get("photo");
  const offerId = form?.get("offerId");
  const object = form?.get("object");
  if (!(photo instanceof Blob) || typeof offerId !== "string") return json({ error: "photo and offerId are required" }, 400);
  if (!/^image\/(jpeg|png)$/.test(photo.type)) return json({ error: "photo must be a JPG or PNG" }, 400);
  if (photo.size > MAX_PHOTO_BYTES) return json({ error: "photo is larger than 15 MB" }, 413);
  try {
    const creative = await generateCreative(await engineDeps(), {
      businessId: SEED_BUSINESS_ID,
      photo: Buffer.from(await photo.arrayBuffer()),
      offerId,
      object: typeof object === "string" ? object : undefined,
    });
    return json({ creative });
  } catch (err) {
    return errorResponse(err);
  }
}
