// Live content run: one photo, one offer, through the real gateway with run
// caps. Prints ledger rows, file paths, caption and logs (never image bytes).
// Run: MODEL_RUN_ID=... MODEL_RUN_CAP_USD=... MODEL_RUN_MAX_CALLS=... \
//      STORAGE_BACKEND=local npx tsx --env-file=.env scripts/content-run.ts <photo> <offerId> <object>
import { readFileSync } from "node:fs";
import { generateCreative } from "../src/lib/content/creative";
import { createLiveGateway, usdToNano } from "../src/lib/gateway";
import { createStore } from "../src/lib/storage";
import { SEED_BUSINESS_ID } from "../src/lib/storage/seed";

async function main() {
  const [photoPath, offerId, object] = process.argv.slice(2);
  const runId = process.env.MODEL_RUN_ID!;
  const store = await createStore();
  const gateway = createLiveGateway({
    store,
    run: { id: runId, capNano: usdToNano(Number(process.env.MODEL_RUN_CAP_USD)) },
    maxCalls: Number(process.env.MODEL_RUN_MAX_CALLS),
  });
  const model = process.env.MODEL_CHAT_MODEL?.trim() || "muse-spark-1.3";
  const creative = await generateCreative({ store, gateway, model, now: () => new Date() }, {
    businessId: SEED_BUSINESS_ID,
    photo: readFileSync(photoPath),
    offerId,
    object,
  });
  const rows = (await store.listSpend()).filter((r) => r.runId === runId);
  console.log("LEDGER (run " + runId + "):");
  for (const r of rows) {
    console.log(`  ${r.createdAt} ${r.model} in=${r.tokensIn} out=${r.tokensOut} reasoning=${r.reasoningTokens} finish=${r.finishReason} est=$${(r.reservedNano / 1e9).toFixed(6)} settled=$${((r.settledNano ?? 0) / 1e9).toFixed(6)} ${r.state}`);
  }
  console.log("CREATIVE:", JSON.stringify({ id: creative.id, status: creative.status, offerId: creative.offerId, brainVersion: creative.brainVersion, cutoutKind: creative.cutoutKind, sceneKind: creative.sceneKind }));
  console.log("MEDIA:", JSON.stringify(creative.media, null, 1));
  console.log("CAPTION:", JSON.stringify(creative.caption));
  console.log("CAPTION LOG:", JSON.stringify(creative.captionLog, null, 1));
  console.log("DIAGNOSTICS:", JSON.stringify(creative.diagnostics, null, 1));
  await store.close();
}

main().catch((err) => {
  console.error("content run failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
