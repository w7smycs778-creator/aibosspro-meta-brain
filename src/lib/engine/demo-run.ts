// Runs the scripted demo path (DEMO_MESSAGES against DEMO_SCRIPT) through the
// real engine with the mock model client. Used by the Step 7a test and
// scripts/mock-run.ts.
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MOCK_MODEL, MOCK_PRICES, MockModelClient } from "../gateway/mock-client";
import { usdToNano } from "../gateway/money";
import type { Storage, Turn } from "../storage/types";
import { handleInbound, type InboundResult } from "./conversation-service";
import { DEMO_CLOCK, DEMO_MESSAGES, DEMO_SCRIPT } from "./demo-script";

export async function runDemo(store: Storage, sessionId = "panel-demo"): Promise<{ results: InboundResult[]; client: MockModelClient }> {
  const { businessId } = await store.reset();
  const client = new MockModelClient(DEMO_SCRIPT);
  const gateway = new SpendGateway({
    ledger: new StoreSpendLedger(store, { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) }),
    dispatcher: client,
    prices: MOCK_PRICES,
  });
  const deps = { store, gateway, model: MOCK_MODEL, now: () => DEMO_CLOCK };
  const results: InboundResult[] = [];
  for (const [i, text] of DEMO_MESSAGES.entries()) {
    results.push(
      await handleInbound(
        { businessId, channel: "panel", externalConversationId: sessionId, senderId: sessionId, text, externalEventId: `demo-${i}` },
        deps,
      ),
    );
  }
  return { results, client };
}

/** One line per recorded turn, for printing a trace. */
export function traceLines(turns: Turn[]): string[] {
  return turns.map((t) => {
    const cp = t.checkpoint ?? {};
    const c = cp as Record<string, any>;
    switch (c.kind) {
      case "customer":
        return `CUSTOMER  ${t.content}`;
      case "tool_call":
        return `  model -> ${c.toolCalls.map((x: any) => `${x.name}(${JSON.stringify(x.arguments)})`).join(", ")}`;
      case "tool_result":
        return `  tool ${c.toolCall.name} -> ${c.result.ok ? "ok" : `ERROR ${c.result.error}`}${
          c.result.ok ? ` ${JSON.stringify(c.result.output).slice(0, 140)}${JSON.stringify(c.result.output).length > 140 ? "..." : ""}` : ""
        }`;
      case "verifier":
        return `  verifier[${c.target}] ${c.pass ? "PASS" : "BLOCK"} ${c.checks
          .map((k: any) => `{${k.rule} "${k.claim}" ${k.inconclusive ? "inconclusive" : k.pass ? "ok" : `FAIL: ${k.detail}`}}`)
          .join(" ")}`;
      case "invalid_output":
        return `  invalid output: ${c.error}`;
      case "owner_help":
        return `  OWNER HELP: ${c.reason} ${c.detail ?? ""}`;
      case "final":
        return `REPLY     ${t.content}`;
      default:
        return `  ${c.kind ?? t.role}: ${t.content}`;
    }
  });
}
