// Outbound messages on a conversation's own channel. The panel has nothing to
// push (its page reads the reply from the HTTP response or the turns); WhatsApp
// goes through the existing Cloud API sender.
import type { Conversation, Storage, Turn } from "../storage/types";
import { sendText } from "../whatsapp/send";

export type DeliveryResult = { ok: boolean; status: number | null; channel: Conversation["channel"] };
export type Deliver = (conversation: Conversation, text: string) => Promise<DeliveryResult>;

export const channelDeliver: Deliver = async (conversation, text) => {
  if (conversation.channel === "panel") return { ok: true, status: null, channel: "panel" };
  const res = await sendText(conversation.externalId, text);
  return { ok: res.ok, status: res.status, channel: "whatsapp" };
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
  await store.appendTurn({
    conversationId: conversation.id,
    role: "system",
    content: result.ok ? `Delivered on ${result.channel}.` : `Delivery on ${result.channel} failed.`,
    checkpoint: { kind: "outbound_result", outboundTurnId: outbound.id, status: result.ok ? "sent" : "failed", httpStatus: result.status, ...extra },
  });
  return result;
}
