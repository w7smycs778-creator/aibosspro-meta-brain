// How tool calls travel over a chat endpoint. MODEL_TOOL_MODE=json (default)
// describes the tools in the system prompt and reads one JSON object back;
// it needs nothing from the endpoint beyond chat. MODEL_TOOL_MODE=native sends
// OpenAI-style "tools" and reads "tool_calls"; research/ holds no evidence the
// Meta Model API supports that, so it is opt-in only.
import { randomUUID } from "node:crypto";
import { PreDispatchError } from "./errors";
import type { ChatMessage, Env, ToolCallRequest, ToolDefinition } from "./types";

export type ToolMode = "json" | "native";

export function toolMode(env: Env): ToolMode {
  const raw = env.MODEL_TOOL_MODE?.trim() || "json";
  if (raw !== "json" && raw !== "native") {
    throw new PreDispatchError("dispatcher_not_configured", `MODEL_TOOL_MODE must be "json" or "native", got "${raw}"`);
  }
  return raw;
}

export type DecodedStep =
  | { ok: true; text: string; toolCalls: ToolCallRequest[] }
  | { ok: false; error: string };

// ---- json mode -------------------------------------------------------------

export const TOOL_RESULT_PREFIX = "Tool result:";

export function jsonModeInstructions(tools: ToolDefinition[]): string {
  return [
    "You can call these tools:",
    JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))),
    "Reply with exactly one JSON object and nothing else, in one of two forms:",
    '{"type":"tool_call","name":"<tool name>","args":{...}} to call one tool, or',
    '{"type":"final","text":"<your reply to the customer>"} to answer the customer.',
    `Tool results arrive as user messages starting with "${TOOL_RESULT_PREFIX}".`,
  ].join("\n");
}

/** Messages for an endpoint with no tool support: tools in the system prompt, calls and results as text. */
export function encodeJsonMode(messages: ChatMessage[], tools: ToolDefinition[]): Array<{ role: string; content: string }> {
  const instructions = jsonModeInstructions(tools);
  const out: Array<{ role: string; content: string }> = [];
  let systemDone = false;
  for (const m of messages) {
    if (m.role === "system" && !systemDone) {
      out.push({ role: "system", content: `${m.content}\n\n${instructions}` });
      systemDone = true;
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const c = m.toolCalls[0];
      out.push({ role: "assistant", content: JSON.stringify({ type: "tool_call", name: c.name, args: c.arguments }) });
    } else if (m.role === "tool") {
      out.push({ role: "user", content: `${TOOL_RESULT_PREFIX} ${m.content}` });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  if (!systemDone) out.unshift({ role: "system", content: instructions });
  return out;
}

/** Strips code fences and surrounding prose, parses one object, checks its shape. */
export function decodeJsonMode(raw: string | undefined): DecodedStep {
  if (raw === undefined || raw.trim() === "") return { ok: false, error: "empty reply" };
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first < 0 || last <= first) return { ok: false, error: "reply is not a JSON object" };
    try {
      value = JSON.parse(text.slice(first, last + 1));
    } catch {
      return { ok: false, error: "reply is not valid JSON" };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "reply is not a JSON object" };
  const v = value as Record<string, unknown>;
  if (v.type === "final") {
    if (typeof v.text !== "string" || v.text.trim() === "") return { ok: false, error: 'a "final" reply needs a non-empty "text"' };
    return { ok: true, text: v.text, toolCalls: [] };
  }
  if (v.type === "tool_call") {
    if (typeof v.name !== "string" || v.name === "") return { ok: false, error: 'a "tool_call" needs a "name"' };
    const args = v.args ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) return { ok: false, error: '"args" must be an object' };
    return { ok: true, text: "", toolCalls: [{ id: `call_${randomUUID()}`, name: v.name, arguments: args as Record<string, unknown> }] };
  }
  return { ok: false, error: '"type" must be "tool_call" or "final"' };
}

// ---- native mode -----------------------------------------------------------

export function encodeNative(messages: ChatMessage[], tools: ToolDefinition[]) {
  return {
    messages: messages.map((m) => {
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
        };
      }
      if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      return { role: m.role, content: m.content };
    }),
    tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
  };
}

export function decodeNative(message: any): DecodedStep {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const toolCalls: ToolCallRequest[] = [];
  for (const c of calls) {
    const name = c?.function?.name;
    if (typeof name !== "string") return { ok: false, error: "tool call without a function name" };
    let args: unknown = {};
    try {
      args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
    } catch {
      return { ok: false, error: `arguments for "${name}" are not valid JSON` };
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) return { ok: false, error: `arguments for "${name}" are not an object` };
    toolCalls.push({ id: typeof c.id === "string" ? c.id : `call_${randomUUID()}`, name, arguments: args as Record<string, unknown> });
  }
  const text = typeof message?.content === "string" ? message.content : "";
  if (toolCalls.length === 0 && text.trim() === "") return { ok: false, error: "empty reply" };
  return { ok: true, text, toolCalls };
}
