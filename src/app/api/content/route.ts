import { engineDeps } from "@/lib/engine/deps";
import { errorResponse, json, ownerOnly, resolveBusiness } from "@/lib/engine/http";
import { generateCreative } from "@/lib/content/creative";
import { listOffers } from "@/lib/content/offers";
import { getStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** Offers from the business's current approved brain, and its creatives, newest first. ?business=<id>. */
export async function GET(req: Request): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const store = await getStore();
  const businessId = await resolveBusiness(store, new URL(req.url).searchParams.get("business"));
  if (businessId instanceof Response) return businessId;
  const brain = await store.getBrain(businessId, { approvedOnly: true });
  return json({ brainVersion: brain?.version ?? null, offers: brain ? listOffers(brain.brain) : [], creatives: await store.listCreatives(businessId) });
}

/** Multipart: photo (jpg/png), offerId, object (what to cut out), businessId (optional). */
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
  const businessId = await resolveBusiness(await getStore(), form?.get("businessId"));
  if (businessId instanceof Response) return businessId;
  try {
    const creative = await generateCreative(await engineDeps(), {
      businessId,
      photo: Buffer.from(await photo.arrayBuffer()),
      offerId,
      object: typeof object === "string" ? object : undefined,
    });
    return json({ creative });
  } catch (err) {
    return errorResponse(err);
  }
}
