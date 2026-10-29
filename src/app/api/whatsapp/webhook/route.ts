import { after } from "next/server";
import { handleInbound } from "@/lib/engine/conversation-service";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";
import { sendText } from "@/lib/whatsapp/send";
import { safeEqual, verifySignature } from "@/lib/whatsapp/signature";
import { getStore } from "@/lib/storage";
import { extractTextMessages, last4, type InboundText } from "@/lib/whatsapp/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Meta verification handshake. */
export function GET(req: Request): Response {
  const q = new URL(req.url).searchParams;
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  const token = q.get("hub.verify_token");
  const challenge = q.get("hub.challenge");
  if (expected && token && challenge && q.get("hub.mode") === "subscribe" && safeEqual(token, expected)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

/** One WhatsApp number serves one business; the seeded demo business until onboarding exists. */
const businessId = () => process.env.WHATSAPP_BUSINESS_ID || SEED_BUSINESS_ID;

/** Signed event delivery. Responds first; the engine runs and replies after the response. */
export async function POST(req: Request): Promise<Response> {
  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), process.env.META_APP_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return new Response("OK", { status: 200 });
  }

  // Durable dedupe: an id is claimed once in the store, across instances and restarts.
  const fresh: InboundText[] = [];
  let storeError: unknown = null;
  const inbound = extractTextMessages(payload);
  if (inbound.length) {
    try {
      const store = await getStore();
      for (const m of inbound) {
        if (await store.claimEvent("whatsapp", m.id)) fresh.push(m);
      }
    } catch (err) {
      storeError = err;
    }
  }
  if (fresh.length) {
    after(async () => {
      for (const m of fresh) {
        console.log("whatsapp inbound", { id: m.id, from4: last4(m.from) });
        try {
          const result = await handleInbound({
            businessId: businessId(),
            channel: "whatsapp",
            externalConversationId: m.from,
            senderId: m.from,
            text: m.text,
            externalEventId: m.id,
          });
          console.log("whatsapp engine", { id: m.id, from4: last4(m.from), outcome: result.outcome });
          if (!result.replyText) continue;
          const res = await sendText(m.from, result.replyText);
          console.log("whatsapp reply", { id: m.id, from4: last4(m.from), status: res.status });
        } catch (err) {
          console.error("whatsapp reply failed", { id: m.id, from4: last4(m.from), error: (err as Error).name });
        }
      }
    });
  }
  if (storeError) {
    // Claimed messages are answered above; the rest were never claimed, so a
    // non-2xx makes Meta redeliver them.
    console.error("whatsapp dedupe store unavailable", { error: (storeError as Error).name });
    return new Response("Service Unavailable", { status: 503 });
  }
  return new Response("OK", { status: 200 });
}
