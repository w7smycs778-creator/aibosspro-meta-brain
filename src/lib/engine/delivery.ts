// Outbound messages on a conversation's own channel. The panel has nothing to
// push (its page reads the reply from the HTTP response or the turns); WhatsApp
// goes through the existing Cloud API sender.
import type { Conversation, Storage, Turn } from "../storage/types";
import { sendText } from "../whatsapp/send";

export type DeliveryResult = {
  ok: boolean;
  status: number | null;
  channel: Conversation["channel"];
  /** WhatsApp message id (wamid) of a sent message. */
  messageId?: string;
  errorCode?: number;
  /** The customer's 24-hour window is closed; the message is queued until they write again. */
  outOfWindow?: boolean;
};
export type Deliver = (conversation: Conversation, text: string) => Promise<DeliveryResult>;

export const channelDeliver: Deliver = async (conversation, text) => {
  if (conversation.channel === "panel") return { ok: true, status: null, channel: "panel" };
  const res = await sendText(conversation.externalId, text);
  return { ok: res.ok, status: res.status, channel: "whatsapp", ...(res.messageId && { messageId: res.messageId }), ...(res.errorCode !== undefined && { errorCode: res.errorCode }), ...(res.outOfWindow && { outOfWindow: true }) };
};

/**
 * Delivers an outbound turn (engine reply, owner message or owner decision)
 * and records the outcome as an outbound_result turn. Outbound turns carry
 * checkpoint.delivery = "pending" until a result exists; resume delivers those once.
 */
export async function deliverAndRecord(
  store: Storage,
  deliver: Deliver,
  conversation: Conversation,
  outbound: Turn,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<DeliveryResult> {
  let result: DeliveryResult;
  try {
    result = await deliver(conversation, text);
  } catch (err) {
    result = { ok: false, status: null, channel: conversation.channel };
    extra = { ...extra, error: (err as Error).name };
  }
  const status = result.ok ? "sent" : result.outOfWindow ? "queued" : "failed";
  await store.appendTurn({
    conversationId: conversation.id,
    role: "system",
    content: result.ok
      ? `Delivered on ${result.channel}.`
      : result.outOfWindow
        ? "Queued: the customer's 24-hour WhatsApp window is closed. It is sent when they write again."
        : `Delivery on ${result.channel} failed.`,
    checkpoint: {
      kind: "outbound_result",
      outboundTurnId: outbound.id,
      status,
      httpStatus: result.status,
      ...(result.messageId && { messageId: result.messageId }),
      ...(result.errorCode !== undefined && { errorCode: result.errorCode }),
      ...(result.outOfWindow && { reason: "outside_24h_window" }),
      ...extra,
    },
  });
  if (result.channel === "whatsapp") console.log("whatsapp outbound", { outboundTurnId: outbound.id, status, httpStatus: result.status, wamid: result.messageId ?? null, errorCode: result.errorCode ?? null });
  return result;
}

/** Outbound turns whose latest result is "queued" (window closed), oldest first. */
export function queuedOutbound(turns: Turn[]): Turn[] {
  const latest = new Map<string, string>();
  for (const t of turns) if (t.checkpoint?.kind === "outbound_result") latest.set(String(t.checkpoint.outboundTurnId), String(t.checkpoint.status));
  return turns.filter((t) => latest.get(t.id) === "queued");
}

/** Sends every queued outbound turn once; called when the customer writes again, which reopens the window. */
export async function deliverQueued(store: Storage, deliver: Deliver, conversation: Conversation): Promise<number> {
  const queued = queuedOutbound(await store.listTurns(conversation.id));
  for (const outbound of queued) {
    await deliverAndRecord(store, deliver, conversation, outbound, String(outbound.checkpoint?.text ?? outbound.content), { retriedAfterInbound: true });
  }
  return queued.length;
}
