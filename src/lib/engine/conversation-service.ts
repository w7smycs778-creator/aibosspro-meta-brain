// The shared conversation engine. The customer panel and WhatsApp both enter
// here: load or create the conversation, record the customer turn, run the
// tool loop behind the verifier, persist every step, return the reply.
import { runToolLoop, type ProposedStep, type ToolLoopResult } from "../gateway/tool-loop";
import type { ChatMessage } from "../gateway/types";
import { SEED_BUSINESS_ID } from "../storage/seed";
import type { BusinessBrain, Channel, ConversationMode, ConversationState, Storage, Turn } from "../storage/types";
import { AI_DISCLOSURE, ENGINE_MAX_OUTPUT_TOKENS, ENGINE_REASONING_EFFORT, OWNER_HELP_REPLY, engineDeps, type EngineDeps } from "./deps";
import { brainFacts } from "./brain-prompt";
import { localDate, weekdayOf } from "./time";
import { ENGINE_TOOLS } from "./tools";
import { latestAvailability, verifyText, verifyToolCall, type Facts } from "./verifier";

export type InboundInput = {
  businessId: string;
  channel: Channel;
  externalConversationId: string;
  senderId: string;
  text: string;
  /** Channel event id (WhatsApp message id, panel message id); repeats are ignored. */
  externalEventId: string;
};

export type InboundResult = {
  duplicate: boolean;
  conversationId: string | null;
  replyText: string | null;
  state: ConversationState | null;
  mode: ConversationMode | null;
  outcome: ToolLoopResult["status"] | "duplicate" | "model_unavailable";
  pendingApprovalId?: string;
  /** Every turn recorded for this message, customer turn first. */
  trace: Turn[];
};

const HISTORY_TURNS = 20;
const REPLY_KINDS = new Set(["final", "owner_help_reply", "owner_decision"]);

/** Panel conversations on the seeded demo business start in AUTO; everything else uses the store default. */
function initialMode(input: InboundInput): ConversationMode | undefined {
  return input.channel === "panel" && input.businessId === SEED_BUSINESS_ID ? "AUTO" : undefined;
}

export async function handleInbound(input: InboundInput, deps?: EngineDeps): Promise<InboundResult> {
  const d = deps ?? (await engineDeps());
  const { store } = d;

  if (!(await store.claimEvent(`engine:${input.channel}`, input.externalEventId))) {
    return { duplicate: true, conversationId: null, replyText: null, state: null, mode: null, outcome: "duplicate", trace: [] };
  }
  const brainVersion = await store.getBrain(input.businessId, { approvedOnly: true });
  if (!brainVersion) throw new Error(`business ${input.businessId} has no approved brain; run store:reset`);

  const conversation =
    (await store.findConversation(input.businessId, input.channel, input.externalConversationId)) ??
    (await store.createConversation({
      businessId: input.businessId,
      channel: input.channel,
      externalId: input.externalConversationId,
      customerRef: input.senderId,
      mode: initialMode(input),
    }));
  const history = await store.listTurns(conversation.id);
  const customerTurn = await store.appendTurn({
    conversationId: conversation.id,
    role: "customer",
    content: input.text,
    checkpoint: { kind: "customer", channel: input.channel, eventId: input.externalEventId },
  });
  await store.updateConversation(conversation.id, {});

  let outcome: InboundResult["outcome"];
  let replyText: string | null = null;
  if (!d.gateway) {
    await store.appendTurn({
      conversationId: conversation.id,
      role: "system",
      content: "Handed to the owner.",
      checkpoint: { turnId: customerTurn.id, kind: "owner_help", reason: "model_unavailable", detail: d.gatewayError ?? "" },
    });
    await store.updateConversation(conversation.id, { state: "owner_help" });
    outcome = "model_unavailable";
  } else {
    const result = await runToolLoop({
      gateway: d.gateway,
      store,
      registry: ENGINE_TOOLS,
      conversationId: conversation.id,
      turnId: customerTurn.id,
      model: d.model,
      messages: buildMessages(brainVersion.brain, brainVersion.version, history, input.text, d.now()),
      maxOutputTokens: ENGINE_MAX_OUTPUT_TOKENS,
      reasoningEffort: ENGINE_REASONING_EFFORT,
      verify: (step) => verifyStep(store, conversation.id, brainVersion.brain, step),
      now: d.now,
    });
    outcome = result.status;
    if (result.status === "final") replyText = AI_DISCLOSURE + result.text;
  }
  if (outcome === "owner_help" || outcome === "model_unavailable") {
    replyText = AI_DISCLOSURE + OWNER_HELP_REPLY;
    await store.appendTurn({
      conversationId: conversation.id,
      role: "assistant",
      content: OWNER_HELP_REPLY,
      checkpoint: { turnId: customerTurn.id, kind: "owner_help_reply" },
    });
  }

  const after = (await store.getConversation(conversation.id))!;
  const trace = (await store.listTurns(conversation.id)).filter((t) => t.seq >= customerTurn.seq);
  return {
    duplicate: false,
    conversationId: conversation.id,
    replyText,
    state: after.state,
    mode: after.mode,
    outcome,
    pendingApprovalId: pendingApprovalFrom(trace),
    trace,
  };
}

async function verifyStep(store: Storage, conversationId: string, brain: BusinessBrain, step: ProposedStep) {
  const conversation = (await store.getConversation(conversationId))!;
  const facts: Facts = {
    brain,
    availability: latestAvailability(await store.listTurns(conversationId)),
    bookings: (await store.listBookings(conversation.businessId)).filter((b) => b.conversationId === conversationId),
  };
  return step.kind === "final" ? verifyText(step.text, facts) : verifyToolCall(step.call, facts);
}

function pendingApprovalFrom(trace: Turn[]): string | undefined {
  for (const t of trace) {
    const cp = t.checkpoint;
    const result = cp?.result as { ok: boolean; name: string; output?: { approvalId?: string } } | undefined;
    if (cp?.kind === "tool_result" && result?.ok && result.name === "request_booking") return result.output?.approvalId;
  }
  return undefined;
}

export function buildMessages(brain: BusinessBrain, version: number, history: Turn[], text: string, now: Date): ChatMessage[] {
  const today = localDate(now, brain.timezone);
  const availability = latestAvailability(history);
  const system = [
    `You are the AI booking assistant for ${brain.name}. Customers know they are talking to an AI.`,
    `Today is ${today} (${weekdayOf(today)}), time zone ${brain.timezone}.`,
    brainFacts(brain, version),
    "Never invent a service, price, discount or opening hour that is not listed above. Use check_availability for open times.",
    "Offer only start times returned by check_availability. Request a booking only for a slot it returned.",
    "A booking is never confirmed by you: request_booking creates a pending request that the owner approves.",
    "If the customer needs anything the tools cannot do, call request_owner_help.",
    "Call the tool directly; never say you will check something.",
    "Keep replies short and plain.",
    ...(availability ? [`Latest availability result: ${JSON.stringify(availability)}`] : []),
  ].join("\n");
  const past: ChatMessage[] = history
    .filter((t) => t.role === "customer" || (t.role === "assistant" && REPLY_KINDS.has(String(t.checkpoint?.kind))))
    .slice(-HISTORY_TURNS)
    .map((t) => (t.role === "customer" ? { role: "user", content: t.content } : { role: "assistant", content: t.content }));
  return [{ role: "system", content: system }, ...past, { role: "user", content: text }];
}
