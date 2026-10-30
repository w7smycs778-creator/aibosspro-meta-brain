// Sends customer messages through the engine as one panel conversation and
// prints each reply, tool call, verifier verdict and the run's ledger rows.
// Live unless MODEL_CLIENT=mock; bound it with MODEL_RUN_ID, MODEL_RUN_CAP_USD
// and MODEL_RUN_MAX_CALLS.
// Run: STORAGE_BACKEND=local MODEL_RUN_ID=... MODEL_RUN_CAP_USD=0.30 MODEL_RUN_MAX_CALLS=6 \
//      npx tsx --env-file=.env scripts/panel-run.ts [--business=<id>] "message 1" "message 2"
import { formatUsd } from "../src/lib/gateway";
import { handleInbound } from "../src/lib/engine/conversation-service";
import { engineDeps } from "../src/lib/engine/deps";
import { SEED_BUSINESS_ID } from "../src/lib/storage";

async function main() {
  const args = process.argv.slice(2);
  const businessId = args.find((a) => a.startsWith("--business="))?.slice("--business=".length) || SEED_BUSINESS_ID;
  const messages = args.filter((a) => !a.startsWith("--business="));
  if (!messages.length) throw new Error("pass at least one customer message");
  const deps = await engineDeps();
  if (!deps.gateway) throw new Error(`no gateway: ${deps.gatewayError}`);
  const conversation = `panel-run-${Date.now()}`;
  console.log(`business ${businessId}`);
  for (const [i, text] of messages.entries()) {
    console.log(`\nCUSTOMER: ${text}`);
    const r = await handleInbound(
      { businessId, channel: "panel", externalConversationId: conversation, senderId: conversation, text, externalEventId: `${conversation}-${i}` },
      deps,
    );
    for (const t of r.trace) {
      const cp = t.checkpoint ?? {};
      if (cp.kind === "tool_call") console.log(`  tool_call ${JSON.stringify(cp.toolCalls)}`);
      if (cp.kind === "tool_result") console.log(`  tool_result ${JSON.stringify(cp.result).slice(0, 400)}`);
      if (cp.kind === "verifier") console.log(`  verifier ${cp.pass ? "PASS" : "BLOCK"} ${JSON.stringify(cp.checks)}`);
      if (cp.kind === "owner_help") console.log(`  owner_help ${JSON.stringify(cp)}`);
    }
    console.log(`REPLY (${r.outcome}): ${r.replyText}`);
    if (r.outcome !== "final") break;
  }
  const runId = process.env.MODEL_RUN_ID;
  const rows = (await deps.store.listSpend()).filter((r) => !runId || r.runId === runId);
  console.log(`\nledger rows${runId ? ` for run ${runId}` : ""}: ${rows.length}`);
  for (const r of rows) console.log(`  ${r.createdAt} ${r.model} ${r.state} in=${r.tokensIn} out=${r.tokensOut} reasoning=${r.reasoningTokens ?? "-"} finish=${r.finishReason ?? "-"} ${formatUsd(r.settledNano ?? 0)}`);
  console.log(`run total ${formatUsd(rows.reduce((n, r) => n + (r.settledNano ?? 0), 0))}`);
  await deps.store.close();
}

main().catch((err) => {
  console.error(`panel-run failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
