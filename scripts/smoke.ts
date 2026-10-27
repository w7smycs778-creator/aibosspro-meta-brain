// Day 1 smoke test: one call per model, through the spend gateway only.
// Run: LIVE_CREDITS_VERIFIED=true MODEL_CREDIT_BALANCE_USD=<billing balance> \
//      npx tsx --env-file=.env scripts/smoke.ts [outDir]
// Stops at the first non-ok result and prints its full error.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLiveGateway, formatUsd, InMemorySpendLedger, loadSpendConfig, usdToNano } from "../src/lib/gateway";
import type { GatewayResult, ModelCall } from "../src/lib/gateway";

const RUN_CAP_USD = 10;
const outDir = process.argv[2];

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "..", "fixtures", "smoke", name)));

const calls: ModelCall[] = [
  {
    kind: "chat",
    model: "muse-spark-1.3",
    maxOutputTokens: 1_024,
    messages: [
      { role: "system", content: "You extract booking requests into JSON. Reply with JSON only." },
      { role: "user", content: "Synthetic test: Dana wants a haircut on Tuesday at 10:00 at the Demo Salon." },
    ],
    jsonSchema: {
      name: "booking_request",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          customer_name: { type: "string" },
          service: { type: "string" },
          day: { type: "string" },
          time: { type: "string" },
        },
        required: ["customer_name", "service", "day", "time"],
      },
    },
  },
  {
    kind: "transcribe",
    model: "muse-voice-transcribe-1.0",
    audio: fixture("he-en-booking.wav"),
    languageBias: ["Hebrew", "English"],
  },
  {
    kind: "segment",
    model: "sam-3.1",
    prompt: "mug",
    image: fixture("product-mug.png"),
    mimeType: "image/png",
  },
  {
    kind: "image",
    model: "muse-image-1.0",
    prompt: "Simple flat studio background in warm beige with soft light, empty, for a product photo. Synthetic test.",
    n: 1,
    size: "1024x1024",
  },
];

function sample(r: GatewayResult): string {
  if (r.outcome !== "ok") return "";
  const text = (r.output ?? "").replace(/\s+/g, " ");
  return r.model === "muse-image-1.0" ? `[b64 png, ${text.length} chars] ${text.slice(0, 60)}` : text.slice(0, 100);
}

async function main() {
  const ledger = new InMemorySpendLedger(loadSpendConfig());
  const gateway = createLiveGateway({ ledger, run: { id: `smoke-${Date.now()}`, capNano: usdToNano(RUN_CAP_USD) } });

  const rows: string[] = ["| Model | HTTP | Latency ms | Reserved | Settled | Attempts | Output (100 chars) |", "|---|---|---|---|---|---|---|"];
  let failed: GatewayResult | null = null;
  for (const call of calls) {
    const r = await gateway.call(call);
    const status = r.outcome === "denied" ? `denied:${r.reason}` : String(r.status);
    const latency = r.outcome === "denied" ? "-" : String(r.latencyMs);
    rows.push(`| ${r.model} | ${status} | ${latency} | ${formatUsd(r.reservedNano)} | ${formatUsd(r.settledNano)} | ${r.attempts.length} | ${sample(r).replace(/\|/g, "\\|")} |`);
    if (r.outcome === "ok" && call.kind === "image" && outDir && r.output) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "muse-image-smoke.png"), Buffer.from(r.output, "base64"));
    }
    if (r.outcome === "ok" && call.kind === "segment" && outDir && r.output) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "sam-smoke.txt"), r.output);
    }
    if (r.outcome !== "ok") {
      failed = r;
      break;
    }
  }

  console.log(rows.join("\n"));
  const snap = await ledger.snapshot();
  console.log(`\nTotal settled: ${formatUsd(snap.settledNano)}  open reservations: ${formatUsd(snap.reservedNano)}  run cap: $${RUN_CAP_USD}`);
  if (failed) {
    console.log("\nFIRST FAILURE (full error):");
    console.log(JSON.stringify(failed.outcome === "denied" ? { reason: failed.reason, detail: failed.detail } : { status: failed.status, errorBody: failed.errorBody }, null, 2));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});
