import { getStore } from "@/lib/storage";
import { errorResponse, json, ownerOnly, readJson } from "@/lib/engine/http";
import { sendOwnerMessage } from "@/lib/engine/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 2_000;

/** The owner writes to the customer: { text }. Switches the conversation to HUMAN. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const { id } = await params;
  const text = (await readJson(req))?.text;
  if (typeof text !== "string" || !text.trim()) return json({ error: "text is required" }, 400);
  if (text.length > MAX_TEXT) return json({ error: `text is longer than ${MAX_TEXT} characters` }, 400);
  const store = await getStore();
  if (!(await store.getConversation(id))) return json({ error: "conversation not found" }, 404);
  try {
    return json(await sendOwnerMessage(store, id, text));
  } catch (err) {
    return errorResponse(err);
  }
}
