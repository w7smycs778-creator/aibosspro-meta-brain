// One customer turn: call the model through the gateway, run permitted tool
// calls, checkpoint every step in storage, repeat until a final message, a
// refusal, or the iteration limit. Anything but a verified final message hands
// the conversation to the owner.
import type { Checkpoint, Storage } from "../storage/types";
import { loadMaxToolIterations } from "./config";
import type { SpendGateway } from "./gateway";
import { argumentError, permittedToolNames, toDefinition, type ToolContext, type ToolSpec } from "./tools";
import type { ChatMessage, ToolCallRequest, ToolCallResult } from "./types";

/** What a verifier returns for one proposed step. */
export type StepVerdict = { pass: boolean; checks: Array<{ rule: string; claim: string; pass: boolean; detail?: string }> };
export type ProposedStep = { kind: "final"; text: string } | { kind: "tool_call"; call: ToolCallRequest };

export type ToolLoopInput = {
  gateway: SpendGateway;
  store: Storage;
  registry: readonly ToolSpec[];
  conversationId: string;
  /** The customer turn being answered; every ledger row carries it. */
  turnId: string;
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** Defaults to TOOL_LOOP_MAX_ITERATIONS, else 6. */
  maxIterations?: number;
  /** Deterministic check run before a final message or tool call is accepted. */
  verify?: (step: ProposedStep) => Promise<StepVerdict>;
  now?: () => Date;
};

export type OwnerHelpReason =
  | "tool_not_permitted"
  | "max_iterations"
  | "model_denied"
  | "model_failed"
  | "invalid_model_output"
  | "verifier_blocked"
  | "requested_by_model";

export type ToolLoopResult =
  | { status: "final"; text: string; iterations: number }
  | { status: "owner_help"; reason: OwnerHelpReason; detail: string; iterations: number }
  | { status: "not_active"; detail: string };

/** One correction each per turn: for output outside the protocol, and for a verifier block. */
const MAX_PROTOCOL_RETRIES = 1;
const MAX_VERIFIER_CORRECTIONS = 1;

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const { gateway, store, registry, conversationId, turnId } = input;
  const maxIterations = input.maxIterations ?? loadMaxToolIterations();
  const conversation = await store.getConversation(conversationId);
  if (!conversation) throw new Error(`conversation ${conversationId} not found`);
  if (conversation.mode === "PAUSED" || conversation.state !== "active") {
    return { status: "not_active", detail: `mode ${conversation.mode}, state ${conversation.state}` };
  }

  const permitted = permittedToolNames(conversation, registry);
  const tools = registry.filter((t) => permitted.includes(t.name));
  const messages = [...input.messages];
  const ctx: ToolContext = {
    store,
    businessId: conversation.businessId,
    conversationId,
    customerRef: conversation.customerRef,
    now: input.now ?? (() => new Date()),
  };
  let protocolRetries = 0;
  let verifierCorrections = 0;

  const checkpoint = (role: "assistant" | "tool" | "system", content: string, cp: Checkpoint) =>
    store.appendTurn({ conversationId, role, content, checkpoint: { turnId, ...cp } });

  const ownerHelp = async (reason: OwnerHelpReason, detail: string, iterations: number, extra: Checkpoint = {}): Promise<ToolLoopResult> => {
    await checkpoint("system", "Handed to the owner.", { kind: "owner_help", reason, detail, iteration: iterations, ...extra });
    await store.updateConversation(conversationId, { state: "owner_help" });
    return { status: "owner_help", reason, detail, iterations };
  };

  /** Feeds a correction back to the model, or reports that the budget is spent. */
  const invalidOutput = async (raw: string, error: string, iteration: number): Promise<ToolLoopResult | null> => {
    await checkpoint("system", `Invalid model output: ${error}`, { kind: "invalid_output", iteration, error, raw: raw.slice(0, 2_000) });
    if (protocolRetries >= MAX_PROTOCOL_RETRIES) return ownerHelp("invalid_model_output", error, iteration);
    protocolRetries++;
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: `Your last reply could not be used: ${error}. Reply again exactly as instructed.` });
    return null;
  };

  /** Logs the verdict; on a block, corrects once, then hands to the owner. */
  const verified = async (step: ProposedStep, raw: string, iteration: number): Promise<ToolLoopResult | "pass" | "retry"> => {
    if (!input.verify) return "pass";
    const verdict = await input.verify(step);
    const failed = verdict.checks.filter((c) => !c.pass);
    await checkpoint("system", verdict.pass ? "Verifier passed." : `Verifier blocked: ${failed.map((c) => c.claim).join("; ")}`, {
      kind: "verifier",
      iteration,
      target: step.kind === "final" ? "final" : step.call.name,
      pass: verdict.pass,
      checks: verdict.checks,
    });
    if (verdict.pass) return "pass";
    const claims = failed.map((c) => `${c.claim} (${c.detail ?? c.rule})`).join("; ");
    if (verifierCorrections >= MAX_VERIFIER_CORRECTIONS) {
      const reason = `fact check failed twice: ${claims}`;
      await checkpoint("tool", JSON.stringify({ handedToOwner: true, reason }), {
        kind: "tool_result",
        iteration,
        toolCall: { id: "engine", name: "request_owner_help", arguments: { reason } },
        result: { callId: "engine", name: "request_owner_help", ok: true, output: { handedToOwner: true, reason } },
        forcedBy: "verifier",
      });
      return ownerHelp("verifier_blocked", claims, iteration, { failedChecks: failed });
    }
    verifierCorrections++;
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content: `Your reply was blocked by the fact check and was not sent: ${claims}. Use only facts returned by the tools; do not repeat the blocked claims.`,
    });
    return "retry";
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const r = await gateway.call({
      kind: "chat",
      model: input.model,
      messages,
      maxOutputTokens: input.maxOutputTokens,
      ...(tools.length && { tools: tools.map(toDefinition) }),
      round: iteration,
      businessId: conversation.businessId,
      turnId,
    });
    if (r.outcome === "denied") return ownerHelp("model_denied", `${r.reason}: ${r.detail}`, iteration);
    if (r.outcome === "failed") return ownerHelp("model_failed", `status ${r.status}`, iteration);

    const raw = r.output ?? "";
    if (r.protocolError) {
      const stop = await invalidOutput(raw, r.protocolError, iteration);
      if (stop) return stop;
      continue;
    }

    const calls = r.toolCalls ?? [];
    if (calls.length === 0) {
      const v = await verified({ kind: "final", text: raw }, JSON.stringify({ type: "final", text: raw }), iteration);
      if (v === "retry") continue;
      if (v !== "pass") return v;
      await checkpoint("assistant", raw, { kind: "final", iteration, settledNano: r.settledNano });
      return { status: "final", text: raw, iterations: iteration };
    }

    await checkpoint("assistant", raw, { kind: "tool_call", iteration, toolCalls: calls, settledNano: r.settledNano });

    let retry = false;
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        await checkpoint("tool", `Refused tool "${call.name}".`, {
          kind: "tool_refused",
          iteration,
          toolCall: call,
          reason: "not_permitted",
          permitted,
        });
        return ownerHelp("tool_not_permitted", `model asked for "${call.name}", permitted: [${permitted.join(", ")}]`, iteration);
      }
      const asSent = JSON.stringify({ type: "tool_call", name: call.name, args: call.arguments });
      const badArgs = argumentError(tool.parameters, call.arguments);
      if (badArgs) {
        const stop = await invalidOutput(asSent, `${call.name}: ${badArgs}`, iteration);
        if (stop) return stop;
        retry = true;
        break;
      }
      const v = await verified({ kind: "tool_call", call }, asSent, iteration);
      if (v === "retry") {
        retry = true;
        break;
      }
      if (v !== "pass") return v;

      const result = await execute(tool, call, ctx);
      await checkpoint("tool", JSON.stringify(result), { kind: "tool_result", iteration, toolCall: call, result });
      if (tool.endsTurn && result.ok) {
        return ownerHelp("requested_by_model", String(call.arguments.reason ?? ""), iteration);
      }
      messages.push({ role: "assistant", content: raw, toolCalls: [call] });
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
    }
    if (retry) continue;
  }
  return ownerHelp("max_iterations", `no final message after ${maxIterations} iterations`, maxIterations);
}

async function execute(tool: ToolSpec, call: ToolCallRequest, ctx: ToolContext): Promise<ToolCallResult> {
  try {
    return { callId: call.id, name: tool.name, ok: true, output: await tool.execute(call.arguments, ctx) };
  } catch (err) {
    return { callId: call.id, name: tool.name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
