import { ownerOnly } from "@/lib/engine/http";
import { contentTypeOf, FsMediaStore, mediaRoot, SupabaseMediaStore } from "@/lib/content/media-store";
import { getStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILES = {
  "original.jpg": "original",
  "cutout.png": "cutout",
  "scene.png": "scene",
  "feed.png": "feed",
  "story.png": "story",
  "scene-original": "sceneOriginal",
  "manifest.json": "manifest",
} as const;

/**
 * Serves a creative's files by the refs recorded on it. Local refs are read
 * from ./data/media/ only; hosted refs redirect to a short-lived signed URL
 * of the private bucket.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; file: string }> }): Promise<Response> {
  const blocked = ownerOnly(req);
  if (blocked) return blocked;
  const { id, file } = await params;
  const key = FILES[file as keyof typeof FILES];
  const creative = key ? await (await getStore()).getCreative(id) : null;
  const ref = creative?.media[key!] ?? null;
  if (!ref) return new Response("Not Found", { status: 404 });
  if (ref.startsWith("supabase://")) {
    const media = SupabaseMediaStore.fromEnv();
    const url = media.owns(ref) ? await media.signedUrl(ref) : null;
    return url ? Response.redirect(url, 302) : new Response("Not Found", { status: 404 });
  }
  const media = new FsMediaStore(mediaRoot());
  const body = media.owns(ref) ? await media.get(ref) : null;
  if (!body) return new Response("Not Found", { status: 404 });
  return new Response(new Uint8Array(body), { headers: { "Content-Type": contentTypeOf(ref), "Cache-Control": "no-store" } });
}
