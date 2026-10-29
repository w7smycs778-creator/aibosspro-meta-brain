// Rebuilds one pending creative in place with the live gateway and run caps:
// SAM cutout from the stored original (downscaled copy only), composites on
// the existing scene, caption. Prints ledger rows, paths and logs, never image bytes.
// Run: MODEL_RUN_ID=... MODEL_RUN_CAP_USD=... MODEL_RUN_MAX_CALLS=... \
//      STORAGE_BACKEND=local npx tsx --env-file=.env scripts/content-regenerate.ts <creativeId> <object> <captionAttempts>
import { regenerateCreative } from "../src/lib/content/creative";
import { createLiveGateway, usdToNano } from "../src/lib/gateway";
import { createStore } from "../src/lib/storage";

async function main() {
  const [creativeId, object, attempts] = process.argv.slice(2);
  const runId = process.env.MODEL_RUN_ID!;
  const store = await createStore();
  const gateway = createLiveGateway({ store, run: { id: runId, capNano: usdToNano(Number(process.env.MODEL_RUN_CAP_USD)) }, maxCalls: Number(process.env.MODEL_RUN_MAX_CALLS) });
  const model = process.env.MODEL_CHAT_MODEL?.trim() || "muse-spark-1.3";
  const c = await regenerateCreative({ store, gateway, model, now: () => new Date() }, creativeId, { object, segment: true, caption: true, captionAttempts: Number(attempts) });
  console.log("LEDGER (run " + runId + "):");
  for (const r of (await store.listSpend()).filter((x) => x.runId === runId)) {
    console.log(`  ${r.createdAt} ${r.model} in=${r.tokensIn} out=${r.tokensOut} reasoning=${r.reasoningTokens} finish=${r.finishReason} est=$${(r.reservedNano / 1e9).toFixed(6)} settled=$${((r.settledNano ?? 0) / 1e9).toFixed(6)} ${r.state}`);
  }
  console.log("CREATIVE:", JSON.stringify({ id: c.id, status: c.status, offerId: c.offerId, brainVersion: c.brainVersion, cutoutKind: c.cutoutKind, sceneKind: c.sceneKind }));
  console.log("SEGMENTATION:", JSON.stringify(c.diagnostics.segmentation, null, 1));
  console.log("CUTOUT:", JSON.stringify(c.diagnostics.cutout, null, 1));
  console.log("MEDIA:", JSON.stringify(c.media, null, 1));
  console.log("CAPTION:", JSON.stringify(c.caption));
  console.log("CAPTION LOG:", JSON.stringify(c.captionLog, null, 1));
  await store.close();
}

main().catch((err) => {
  console.error("regenerate failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
