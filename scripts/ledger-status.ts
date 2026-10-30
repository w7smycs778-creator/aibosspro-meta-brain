// Read-only: the spend ledger totals and the approved brain on the configured
// store. No model calls, no writes.
// Run: STORAGE_BACKEND=local npx tsx scripts/ledger-status.ts [runId]
import { formatUsd } from "../src/lib/gateway";
import { createStore, resolveBackend, SEED_BUSINESS_ID } from "../src/lib/storage";

async function main() {
  const runId = process.argv[2];
  const store = await createStore();
  const rows = await store.listSpend();
  const settled = rows.reduce((n, r) => n + (r.settledNano ?? 0), 0);
  const reserved = rows.filter((r) => r.state === "reserved").reduce((n, r) => n + r.reservedNano, 0);
  console.log(`${resolveBackend()} ledger: ${rows.length} rows, settled ${formatUsd(settled)}, open reservations ${formatUsd(reserved)}`);
  if (runId) {
    const run = rows.filter((r) => r.runId === runId);
    console.log(`run ${runId}: ${run.length} rows, settled ${formatUsd(run.reduce((n, r) => n + (r.settledNano ?? 0), 0))}`);
    for (const r of run) {
      console.log(`  ${r.createdAt} ${r.model} ${r.state} in=${r.tokensIn} out=${r.tokensOut} reasoning=${r.reasoningTokens ?? "-"} finish=${r.finishReason ?? "-"} ${formatUsd(r.settledNano ?? 0)}`);
    }
  }
  const brain = await store.getBrain(SEED_BUSINESS_ID, { approvedOnly: true });
  console.log(brain ? `approved brain v${brain.version}: ${brain.brain.name}, languages ${JSON.stringify(brain.brain.languages)}` : "no approved brain");
  await store.close();
}

main().catch((err) => {
  console.error(`ledger-status failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
