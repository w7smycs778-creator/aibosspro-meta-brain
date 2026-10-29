// Step 7a: the demo path through the real engine with the mock model client,
// in a throwaway local store. No network. Run: npm run mock:run
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemo, traceLines } from "../src/lib/engine/demo-run";
import { formatUsd } from "../src/lib/gateway/money";
import { LocalStore } from "../src/lib/storage/local-store";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "meta-brain-mock-run-"));
  const store = LocalStore.open(dir);
  try {
    const { results, client } = await runDemo(store);
    const conversationId = results[0].conversationId!;
    console.log(traceLines(await store.listTurns(conversationId)).join("\n"));
    console.log("\nOutcomes:", results.map((r) => r.outcome).join(", "));
    const conversation = (await store.getConversation(conversationId))!;
    const [booking] = await store.listBookings(conversation.businessId);
    console.log("Booking:", JSON.stringify({ id: booking?.id, service: booking?.serviceId, startsAt: booking?.startsAt, status: booking?.status, name: booking?.customerName }));
    const approval = booking?.approvalId ? await store.getApproval(booking.approvalId) : null;
    console.log("Approval:", JSON.stringify({ id: approval?.id, kind: approval?.kind, status: approval?.status }));
    const spend = await store.listSpend();
    console.log(`Ledger: ${spend.length} rows, model ${[...new Set(spend.map((s) => s.model))].join(",")}, total ${formatUsd(spend.reduce((n, s) => n + (s.settledNano ?? 0), 0))}; mock calls ${client.calls.length}, script left ${client.remaining}`);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
