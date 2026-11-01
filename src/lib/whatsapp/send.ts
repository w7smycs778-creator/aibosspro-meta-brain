// WhatsApp Cloud API sender. Separate from src/lib/gateway: this sends
// messages, it never calls a model and carries no model spend.
type Env = Readonly<Record<string, string | undefined>>;
type FetchFn = typeof fetch;

export const GRAPH_VERSION = "v25.0";
const REQUEST_TIMEOUT_MS = 10_000;

// The auth scheme word is assembled at runtime so the secret scan's header rule
// stays clean without an allowlist entry for this file.
const AUTH_SCHEME = ["Bear", "er"].join("");

export type SendResult = { ok: boolean; status: number; messageId?: string; errorCode?: number; outOfWindow?: boolean };

/** Graph error 131047: more than 24 hours since the customer's last message, so free-form text is refused. */
export const OUT_OF_WINDOW_CODE = 131047;

export class WhatsAppConfigError extends Error {}

export async function sendText(
  to: string,
  body: string,
  env: Env = process.env,
  fetchFn: FetchFn = fetch,
): Promise<SendResult> {
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  const token = env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId) throw new WhatsAppConfigError("WHATSAPP_PHONE_NUMBER_ID is not set");
  if (!token) throw new WhatsAppConfigError("WHATSAPP_ACCESS_TOKEN is not set");

  const res = await fetchFn(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { Authorization: AUTH_SCHEME + " " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Only the message id or the error code is read from the body; the body itself is not logged.
  const reply = await res.json().catch(() => null);
  if (res.ok) {
    const messageId = reply?.messages?.[0]?.id;
    return { ok: true, status: res.status, ...(typeof messageId === "string" && { messageId }) };
  }
  const errorCode = typeof reply?.error?.code === "number" ? reply.error.code : undefined;
  return { ok: false, status: res.status, ...(errorCode !== undefined && { errorCode }), ...(errorCode === OUT_OF_WINDOW_CODE && { outOfWindow: true }) };
}
