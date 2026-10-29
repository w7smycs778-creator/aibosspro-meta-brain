// Owner actions and the owner screen's view of the store.
import type { Booking, Conversation, ConversationMode, PendingApproval, Storage } from "../storage/types";
import { formatLocal } from "./time";

export type Decision = "approved" | "rejected";

export type DecisionResult = {
  approval: PendingApproval;
  changed: boolean;
  booking: Booking | null;
  /** Customer reply recorded for the decision; null on a no-op. */
  replyText: string | null;
};

/**
 * Approve: booking becomes CONFIRMED and a confirmation reply is recorded.
 * Reject: booking becomes REJECTED and a reply offering another time is drafted.
 * A second decision on the same approval changes nothing.
 */
export async function decideBooking(store: Storage, approvalId: string, decision: Decision): Promise<DecisionResult> {
  const { approval, changed } = await store.decideApproval(approvalId, decision);
  const booking = (await store.listBookings(approval.businessId)).find((b) => b.approvalId === approvalId) ?? null;
  if (!changed || !booking || !approval.conversationId) return { approval, changed, booking, replyText: null };

  const brain = (await store.getBrain(approval.businessId, { approvedOnly: true }))!.brain;
  const service = brain.services.find((s) => s.id === booking.serviceId)?.name ?? booking.serviceId;
  const when = formatLocal(booking.startsAt, brain.timezone);
  const replyText =
    decision === "approved"
      ? `Good news: your ${service} on ${when} is confirmed. See you then.`
      : `Sorry, the ${service} on ${when} isn't available after all. Would you like me to check another time?`;
  await store.appendTurn({
    conversationId: approval.conversationId,
    role: "assistant",
    content: replyText,
    checkpoint: { kind: "owner_decision", decision, approvalId, bookingId: booking.id, draft: decision === "rejected" },
  });
  return { approval, changed, booking, replyText };
}

/** Owner switch per conversation; switching also returns it to the engine (state active). */
export async function setMode(store: Storage, conversationId: string, mode: ConversationMode): Promise<Conversation> {
  return store.updateConversation(conversationId, { mode, state: "active" });
}

export async function ownerState(store: Storage, businessId: string) {
  const business = await store.getBusiness(businessId);
  if (!business) return { business: null };
  const brain = await store.getBrain(businessId);
  const approvedBrain = await store.getBrain(businessId, { approvedOnly: true });
  const tz = (approvedBrain ?? brain)?.brain.timezone ?? "UTC";
  const serviceName = (id: string) => (approvedBrain ?? brain)?.brain.services.find((s) => s.id === id)?.name ?? id;
  const bookings = await store.listBookings(businessId);
  const approvals = (await store.listPendingApprovals(businessId)).map((a) => {
    const booking = bookings.find((b) => b.approvalId === a.id) ?? null;
    return {
      ...a,
      booking: booking && { ...booking, serviceName: serviceName(booking.serviceId), when: formatLocal(booking.startsAt, tz) },
    };
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
    brain: brain && { version: brain.version, approved: brain.approved, name: brain.brain.name },
    approvedVersion: approvedBrain?.version ?? null,
    conversations,
    approvals,
    bookings: bookings.map((b) => ({ ...b, serviceName: serviceName(b.serviceId), when: formatLocal(b.startsAt, tz) })),
  };
}
