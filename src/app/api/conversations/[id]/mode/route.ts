import { getStore } from "@/lib/storage";
import { setMode } from "@/lib/engine/owner";
import { json, ownerOnly, readJson } from "@/lib/engine/http";
import type { ConversationMode } from "@/lib/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES: ConversationMode[] = ["AUTO", "HUMAN", "PAUSED"];

/** Owner switch: { mode: "AUTO" | "HUMAN" | "PAUSED" }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const { id } = await params;
  const mode = (await readJson(req))?.mode;
  if (!MODES.includes(mode as ConversationMode)) return json({ error: "mode must be AUTO, HUMAN or PAUSED" }, 400);
  const store = await getStore();
  if (!(await store.getConversation(id))) return json({ error: "conversation not found" }, 404);
  return json(await setMode(store, id, mode as ConversationMode));
}
