import { handleInbound } from "@/lib/engine/conversation-service";
import { json, ownerOnly, readJson, resolveBusiness } from "@/lib/engine/http";
import { getStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 2_000;

/** Customer panel message: { sessionId, eventId, text, businessId? } (default: the original demo business). */
export async function POST(req: Request): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const body = await readJson(req);
  const { sessionId, eventId, text } = body ?? {};
  if (typeof sessionId !== "string" || typeof eventId !== "string" || typeof text !== "string" || !text.trim()) {
    return json({ error: "sessionId, eventId and text are required" }, 400);
  }
  if (text.length > MAX_TEXT) return json({ error: `text is longer than ${MAX_TEXT} characters` }, 400);
  const businessId = await resolveBusiness(await getStore(), body?.businessId);
  if (businessId instanceof Response) return businessId;
  const result = await handleInbound({
    businessId,
    channel: "panel",
    externalConversationId: sessionId,
    senderId: sessionId,
    text: text.trim(),
    externalEventId: eventId,
  });
  return json(result);
}
