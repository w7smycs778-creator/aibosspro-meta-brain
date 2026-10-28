import { after } from "next/server";
import { sendText } from "@/lib/whatsapp/send";
import { safeEqual, verifySignature } from "@/lib/whatsapp/signature";
import { MessageDedupe, extractTextMessages, last4, replyText } from "@/lib/whatsapp/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dedupe = new MessageDedupe();

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

/** Signed event delivery. Responds first; replies are sent after the response. */
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

  const fresh = extractTextMessages(payload).filter((m) => dedupe.claim(m.id));
  if (fresh.length) {
    after(async () => {
      for (const m of fresh) {
        console.log("whatsapp inbound", { id: m.id, from4: last4(m.from) });
        try {
          const res = await sendText(m.from, replyText(m.text));
          console.log("whatsapp reply", { id: m.id, from4: last4(m.from), status: res.status });
        } catch (err) {
          console.error("whatsapp reply failed", { id: m.id, from4: last4(m.from), error: (err as Error).name });
        }
      }
    });
  }
  return new Response("OK", { status: 200 });
}
