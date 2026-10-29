// One customer turn: call the model through the gateway, run permitted tool
// calls, checkpoint every step in storage, repeat until a final message, a
// refusal, or the iteration limit. Anything but a final message hands the
// conversation to the owner.
import type { Checkpoint, Storage } from "../storage/types";
import { loadMaxToolIterations } from "./config";
import type { SpendGateway } from "./gateway";
import { argumentError, permittedToolNames, toDefinition, type ToolSpec } from "./tools";
import type { ChatMessage, ToolCallResult } from "./types";

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
};

export type OwnerHelpReason = "tool_not_permitted" | "max_iterations" | "model_denied" | "model_failed";

export type ToolLoopResult =
  | { status: "final"; text: string; iterations: number }
  | { status: "owner_help"; reason: OwnerHelpReason; detail: string; iterations: number }
  | { status: "not_active"; detail: string };

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
  const ctx = { store, businessId: conversation.businessId, conversationId, customerRef: conversation.customerRef };

  const checkpoint = (role: "assistant" | "tool" | "system", content: string, cp: Checkpoint) =>
    store.appendTurn({ conversationId, role, content, checkpoint: { turnId, ...cp } });

  const ownerHelp = async (reason: OwnerHelpReason, detail: string, iterations: number): Promise<ToolLoopResult> => {
    await checkpoint("system", "Handed to the owner.", { kind: "owner_help", reason, detail, iteration: iterations });
    await store.updateConversation(conversationId, { state: "owner_help" });
    return { status: "owner_help", reason, detail, iterations };
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

    const calls = r.toolCalls ?? [];
    if (calls.length === 0) {
      const text = r.output ?? "";
      await checkpoint("assistant", text, { kind: "final", iteration, settledNano: r.settledNano });
      return { status: "final", text, iterations: iteration };
    }

    await checkpoint("assistant", r.output ?? "", { kind: "tool_call", iteration, toolCalls: calls, settledNano: r.settledNano });
    messages.push({ role: "assistant", content: r.output ?? "", toolCalls: calls });

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
      const result = await execute(tool, call.id, call.arguments, ctx);
      await checkpoint("tool", JSON.stringify(result), { kind: "tool_result", iteration, toolCall: call, result });
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
    }
  }
  return ownerHelp("max_iterations", `no final message after ${maxIterations} iterations`, maxIterations);
}

async function execute(
  tool: ToolSpec,
  callId: string,
  args: Record<string, unknown>,
  ctx: Parameters<ToolSpec["execute"]>[1],
): Promise<ToolCallResult> {
  const invalid = argumentError(tool.parameters, args);
  if (invalid) return { callId, name: tool.name, ok: false, error: invalid };
  try {
    return { callId, name: tool.name, ok: true, output: await tool.execute(args, ctx) };
  } catch (err) {
    return { callId, name: tool.name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
