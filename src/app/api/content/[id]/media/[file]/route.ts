import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ownerOnly } from "@/lib/engine/http";
import { mediaRoot } from "@/lib/content/creative";
import { getStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILES = { "original.jpg": "original", "cutout.png": "cutout", "scene.png": "scene", "feed.png": "feed", "story.png": "story" } as const;

/** Serves a creative's images from the paths recorded on it, only inside ./data/media/. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const { id, file } = await params;
  const key = FILES[file as keyof typeof FILES];
  const creative = key ? await (await getStore()).getCreative(id) : null;
  const path = creative?.media[key!] ? resolve(creative.media[key!]!) : null;
  if (!path || !path.startsWith(mediaRoot() + sep)) return new Response("Not Found", { status: 404 });
  try {
    const body = await readFile(path);
    return new Response(new Uint8Array(body), { headers: { "Content-Type": file.endsWith(".png") ? "image/png" : "image/jpeg", "Cache-Control": "no-store" } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}
