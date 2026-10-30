// Owner actions and the owner screen's view of the store.
import type { Booking, BrainVersion, Conversation, ConversationMode, PendingApproval, Storage, Turn } from "../storage/types";
import { channelDeliver, deliverAndRecord, type Deliver, type DeliveryResult } from "./delivery";
import { formatWithZone } from "./display";
import { brainLangs, detectLanguage, serviceName, STRINGS } from "./i18n";

export type Decision = "approved" | "rejected";

export type DecisionResult = {
  approval: PendingApproval;
  changed: boolean;
  booking: Booking | null;
  /** Customer reply sent for the decision; null on a no-op. */
  replyText: string | null;
  delivery: DeliveryResult | null;
};

/**
 * Approve: booking becomes CONFIRMED and a confirmation goes to the customer.
 * Reject: booking becomes REJECTED and the customer is offered another time.
 * Either reply goes out on the conversation's own channel and names the time
 * with the business zone. A second decision on the same approval changes nothing.
 */
export async function decideBooking(store: Storage, approvalId: string, decision: Decision, deliver: Deliver = channelDeliver): Promise<DecisionResult> {
  const { approval, changed } = await store.decideApproval(approvalId, decision);
  const booking = (await store.listBookings(approval.businessId)).find((b) => b.approvalId === approvalId) ?? null;
  const conversation = approval.conversationId ? await store.getConversation(approval.conversationId) : null;
  if (!changed || !booking || !conversation) return { approval, changed, booking, replyText: null, delivery: null };

  const versions = await store.listBrainVersions(approval.businessId);
  const current = versions.find((v) => v.approved)!.brain;
  const booked = brainAt(versions, booking.createdAt)?.brain.services.find((s) => s.id === booking.serviceId);
  // The reply follows the customer's language (their last message), else the business's first language.
  const lastCustomer = (await store.listTurns(conversation.id)).filter((t) => t.role === "customer").at(-1);
  const lang = detectLanguage(lastCustomer?.content ?? "", brainLangs(current)[0]);
  const service = booked ? serviceName(booked, lang) : booking.serviceId;
  const when = formatWithZone(booking.startsAt, current.timezone, lang);
  const replyText = decision === "approved" ? STRINGS[lang].approved(service, when) : STRINGS[lang].rejected(service, when);
  const turn = await store.appendTurn({
    conversationId: conversation.id,
    role: "assistant",
    content: replyText,
    checkpoint: { kind: "owner_decision", decision, approvalId, bookingId: booking.id, text: replyText, delivery: "pending" },
  });
  const delivery = await deliverAndRecord(store, deliver, conversation, turn, replyText);
  return { approval, changed, booking, replyText, delivery };
}

/**
 * The owner writes to the customer: the conversation switches to HUMAN (the
 * engine stops, including mid-turn), the message is recorded as an owner turn
 * and sent on the conversation's channel.
 */
export async function sendOwnerMessage(
  store: Storage,
  conversationId: string,
  text: string,
  deliver: Deliver = channelDeliver,
): Promise<{ turn: Turn; delivery: DeliveryResult; conversation: Conversation }> {
  const body = text.trim();
  if (!body) throw new Error("message is empty");
  const conversation = await store.updateConversation(conversationId, { mode: "HUMAN", state: "active" });
  const turn = await store.appendTurn({ conversationId, role: "owner", content: body, checkpoint: { kind: "owner_message", text: body, delivery: "pending" } });
  const delivery = await deliverAndRecord(store, deliver, conversation, turn, body);
  return { turn, delivery, conversation };
}

/** Owner switch per conversation; switching also returns it to the engine (state active). */
export async function setMode(store: Storage, conversationId: string, mode: ConversationMode): Promise<Conversation> {
  return store.updateConversation(conversationId, { mode, state: "active" });
}

/** The approved version in force at an instant: the latest one approved at or before it (else the first approved). */
function brainAt(versions: BrainVersion[], at: string): BrainVersion | undefined {
  const approved = versions.filter((v) => v.approved && v.approvedAt).sort((a, b) => a.approvedAt!.localeCompare(b.approvedAt!));
  return [...approved].reverse().find((v) => v.approvedAt! <= at) ?? approved[0];
}

export async function ownerState(store: Storage, businessId: string) {
  const business = await store.getBusiness(businessId);
  if (!business) return { business: null };
  const versions = await store.listBrainVersions(businessId);
  const brain = versions[0] ?? null;
  const approvedBrain = versions.find((v) => v.approved) ?? null;
  const tz = (approvedBrain ?? brain)?.brain.timezone ?? "UTC";
  // A booking shows the service name from the brain in force when it was made; storage keeps only the id.
  const serviceName = (id: string, at: string) =>
    brainAt(versions, at)?.brain.services.find((s) => s.id === id)?.name ??
    versions.map((v) => v.brain.services.find((s) => s.id === id)?.name).find(Boolean) ??
    id;
  const show = (b: Booking) => ({ ...b, serviceName: serviceName(b.serviceId, b.createdAt), when: formatWithZone(b.startsAt, tz) });
  const bookings = await store.listBookings(businessId);
  const approvals = (await store.listPendingApprovals(businessId)).map((a) => {
    const booking = bookings.find((b) => b.approvalId === a.id) ?? null;
    return { ...a, booking: booking && show(booking) };
  });
  const conversations = await Promise.all(
    (await store.listConversations(businessId)).map(async (c) => {
      const turns = await store.listTurns(c.id);
      const last = [...turns].reverse().find((t) => t.role === "customer");
      return { ...c, lastCustomerMessage: last?.content ?? null, turnCount: turns.length };
    }),
  );
  return {
    business,
    /** Header name: the current approved brain's, not the seeded registry name. */
    businessName: approvedBrain?.brain.name || business.name,
    brain: brain && { version: brain.version, approved: brain.approved, name: brain.brain.name },
    approvedVersion: approvedBrain?.version ?? null,
    conversations,
    approvals,
    bookings: bookings.map(show),
  };
}
