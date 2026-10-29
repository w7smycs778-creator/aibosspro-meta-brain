// Scripted stand-in for the model, for tests. It plugs in where MetaDispatcher
// does, so every scripted call still passes the gateway and writes the ledger.
// It never touches the network.
import { PreDispatchError } from "./errors";
import type { ChatCall, DispatchResult, Dispatcher, ModelCall } from "./types";

export type ScriptedUsage = { promptTokens: number; completionTokens: number };

export type ScriptedStep =
  | { text: string; usage?: ScriptedUsage }
  | { toolCall: { name: string; arguments: Record<string, unknown> }; usage?: ScriptedUsage };

export class MockModelClient implements Dispatcher {
  readonly calls: ChatCall[] = [];
  private next = 0;

  constructor(
    private readonly script: ScriptedStep[],
    private readonly defaultUsage: ScriptedUsage = { promptTokens: 10, completionTokens: 10 },
  ) {}

  async dispatch(call: ModelCall): Promise<DispatchResult> {
    if (call.kind !== "chat") throw new PreDispatchError("dispatcher_not_configured", "MockModelClient answers chat calls only");
    this.calls.push(call);
    const step = this.script[this.next++];
    const usage = step?.usage ?? this.defaultUsage;
    const units = { kind: "chat" as const, promptTokens: usage.promptTokens, cachedTokens: 0, completionTokens: usage.completionTokens };
    if (!step) return { ok: false, status: 500, retryable: false, units, errorBody: "mock script exhausted" };
    if ("toolCall" in step) {
      return { ok: true, status: 200, retryable: false, units, toolCalls: [{ id: `call_${this.next}`, ...step.toolCall }] };
    }
    return { ok: true, status: 200, retryable: false, units, output: step.text };
  }
}
