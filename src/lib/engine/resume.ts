// Restart-safe resume. A turn whose tool call was recorded (tool_pending) but
// has no result is finished by running the tool again with the same
// idempotency key, so request_booking returns the booking it may already have
// made instead of a second one. An outbound turn still marked
// delivery="pending" is delivered once. Neither calls the model.
import { execute } from "../gateway/tool-loop";
import type { ToolCallRequest } from "../gateway/types";
import type { Storage, Turn } from "../storage/types";
import { deliverAndRecord, type Deliver } from "./delivery";
import { ENGINE_TOOLS } from "./tools";

export type ResumeDeps = { store: Storage; deliver: Deliver; now: () => Date };
export type ResumeReport = { toolsResumed: number; toolsAbandoned: number; sendsResumed: number; sendsSuppressed: number };

const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Engine replies are dropped if the owner has taken over since; owner messages and decisions always go out. */
const OWNER_KINDS = new Set(["owner_message", "owner_decision"]);

export async function resumeConversation(deps: ResumeDeps, conversationId: string): Promise<ResumeReport> {
  const report: ResumeReport = { toolsResumed: 0, toolsAbandoned: 0, sendsResumed: 0, sendsSuppressed: 0 };
  const conversation = await deps.store.getConversation(conversationId);
  if (!conversation) return report;
  const turns = await deps.store.listTurns(conversationId);
  const since = deps.now().getTime() - RESUME_WINDOW_MS;
  const recent = (t: Turn) => new Date(t.createdAt).getTime() >= since;

  const finished = new Set(turns.filter((t) => t.checkpoint?.kind === "tool_result").map((t) => String(t.checkpoint!.idempotencyKey)));
  for (const pending of turns.filter((t) => t.checkpoint?.kind === "tool_pending" && recent(t))) {
    const cp = pending.checkpoint!;
    const key = String(cp.idempotencyKey);
    if (finished.has(key)) continue;
    const call = cp.toolCall as ToolCallRequest;
    const tool = ENGINE_TOOLS.find((t) => t.name === call.name);
    const base = { turnId: cp.turnId, step: Number(cp.step ?? 0) + 1, brainVersion: cp.brainVersion ?? null, iteration: cp.iteration, toolCall: call, idempotencyKey: key };
    if (!tool || conversation.mode !== "AUTO") {
      // No side effects after a takeover.
      const result = { callId: call.id, name: call.name, ok: false, error: tool ? "abandoned: the owner took the conversation over" : "unknown tool" };
      await deps.store.appendTurn({ conversationId, role: "tool", content: JSON.stringify(result), checkpoint: { kind: "tool_result", ...base, result, abandoned: true } });
      report.toolsAbandoned++;
    } else {
      const ctx = { store: deps.store, businessId: conversation.businessId, conversationId, customerRef: conversation.customerRef, now: deps.now };
      const result = await execute(tool, call, ctx);
      await deps.store.appendTurn({ conversationId, role: "tool", content: JSON.stringify(result), checkpoint: { kind: "tool_result", ...base, result, resumed: true } });
      report.toolsResumed++;
    }
    finished.add(key);
  }

  const delivered = new Set(turns.filter((t) => t.checkpoint?.kind === "outbound_result").map((t) => String(t.checkpoint!.outboundTurnId)));
  for (const outbound of turns.filter((t) => t.checkpoint?.delivery === "pending" && recent(t) && !delivered.has(t.id))) {
    const ownerAction = OWNER_KINDS.has(String(outbound.checkpoint!.kind));
    const ownerSince = turns.some((t) => t.role === "owner" && t.seq > outbound.seq);
    if (!ownerAction && (conversation.mode !== "AUTO" || ownerSince)) {
      await deps.store.appendTurn({
        conversationId,
        role: "system",
        content: "Reply not sent: the owner took the conversation over.",
        checkpoint: { kind: "outbound_result", outboundTurnId: outbound.id, status: "suppressed", resumed: true },
      });
      report.sendsSuppressed++;
      continue;
    }
    await deliverAndRecord(deps.store, deps.deliver, conversation, outbound, String(outbound.checkpoint!.text ?? outbound.content), { resumed: true });
    report.sendsResumed++;
  }
  return report;
}

/** Resumes every recently active conversation of a business; used at server start. */
export async function resumeBusiness(deps: ResumeDeps, businessId: string): Promise<ResumeReport> {
  const total: ResumeReport = { toolsResumed: 0, toolsAbandoned: 0, sendsResumed: 0, sendsSuppressed: 0 };
  const since = deps.now().getTime() - RESUME_WINDOW_MS;
  for (const c of await deps.store.listConversations(businessId)) {
    if (new Date(c.updatedAt).getTime() < since) continue;
    const r = await resumeConversation(deps, c.id);
    for (const k of Object.keys(total) as Array<keyof ResumeReport>) total[k] += r[k];
  }
  return total;
}
