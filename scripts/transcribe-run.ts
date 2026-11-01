// Live Voice Transcribe check: transcribes the given WAV clips through the
// gateway (each attempt reserved in the ledger before dispatch) with an
// explicit languageBias per clip, and prints transcripts and the ledger delta.
// Needs a bounded run: MODEL_RUN_ID, MODEL_RUN_CAP_USD, MODEL_RUN_MAX_CALLS.
// Run: STORAGE_BACKEND=local MODEL_RUN_ID=<id> MODEL_RUN_CAP_USD=0.05 MODEL_RUN_MAX_CALLS=4 \
//      npx tsx --env-file=.env scripts/transcribe-run.ts <clip.wav>:<Language>[:<businessId>] ...
import { readFileSync } from "node:fs";
import { formatUsd } from "../src/lib/gateway";
import { engineDeps } from "../src/lib/engine/deps";
import { parseWav, TRANSCRIBE_MODEL } from "../src/lib/engine/onboarding";

async function main() {
  const runId = process.env.MODEL_RUN_ID?.trim();
  if (!runId) throw new Error("MODEL_RUN_ID is required (bounded run)");
  const clips = process.argv.slice(2).map((a) => {
    const [path, language, businessId] = a.split(":");
    if (!path || !language) throw new Error(`expected <clip.wav>:<Language>, got "${a}"`);
    return { path, language, businessId };
  });
  if (!clips.length) throw new Error("no clips given");
  const deps = await engineDeps();
  if (!deps.gateway) throw new Error(`gateway unavailable: ${deps.gatewayError}`);
  const before = await deps.store.listSpend();
  for (const c of clips) {
    const wav = new Uint8Array(readFileSync(c.path));
    const info = parseWav(wav);
    const r = await deps.gateway.call({ kind: "transcribe", model: TRANSCRIBE_MODEL, audio: wav, languageBias: [c.language], businessId: c.businessId });
    console.log(`${c.path} (${c.language}, ${info.durationMs} ms): ${r.outcome}${r.outcome === "denied" ? ` ${r.reason}: ${r.detail}` : ` status ${r.status}`}`);
    if (r.outcome === "ok") console.log(`  transcript: ${JSON.stringify(r.output)}`);
  }
  const added = (await deps.store.listSpend()).filter((r) => !before.some((b) => b.id === r.id));
  for (const r of added) console.log(`  ledger +1: ${r.createdAt} ${r.model} ${r.state} run=${r.runId} ${formatUsd(r.settledNano ?? 0)} (reserved ${formatUsd(r.reservedNano)})`);
  console.log(`ledger delta: ${added.length} rows, settled ${formatUsd(added.reduce((n, r) => n + (r.settledNano ?? 0), 0))}`);
  await deps.store.close();
}

main().catch((err) => {
  console.error(`transcribe-run failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
