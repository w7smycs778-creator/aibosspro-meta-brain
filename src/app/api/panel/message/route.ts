import { handleInbound } from "@/lib/engine/conversation-service";
import { json, ownerOnly, readJson } from "@/lib/engine/http";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 2_000;

/** Customer panel message: { sessionId, eventId, text }. */
export async function POST(req: Request): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const body = await readJson(req);
  const { sessionId, eventId, text } = body ?? {};
  if (typeof sessionId !== "string" || typeof eventId !== "string" || typeof text !== "string" || !text.trim()) {
    return json({ error: "sessionId, eventId and text are required" }, 400);
  }
  if (text.length > MAX_TEXT) return json({ error: `text is longer than ${MAX_TEXT} characters` }, 400);
  const result = await handleInbound({
    businessId: SEED_BUSINESS_ID,
    channel: "panel",
    externalConversationId: sessionId,
    senderId: sessionId,
    text: text.trim(),
    externalEventId: eventId,
  });
  return json(result);
}
