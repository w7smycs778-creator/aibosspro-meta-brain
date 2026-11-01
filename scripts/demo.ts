// npm run demo: the judge demo on the local store (./data/demo by default).
//   npm run demo                      LIVE if MODEL_API_KEY is set, else REPLAY of the golden scenario
//   npm run demo -- --golden          run the golden scenario (LIVE or REPLAY as above)
//   npm run demo -- --replay          force REPLAY even when MODEL_API_KEY is set
//   npm run demo -- --golden --record LIVE golden run, saved as fixtures/replay/golden.json
//   npm run demo -- --golden --time 11:00   LIVE golden with a changed input (invariants, not wording)
// LIVE spend is capped per run: DEMO_CAP_USD (default 0.30) and DEMO_MAX_CALLS (default 40).
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DEFAULT_DEMO_DIR, GOLDEN_CLOCK, GOLDEN_FIXTURE, LiveError, approve, demoContext, loadFixture, nameOf, openDemoStore, saveFixture, say } from "../src/lib/demo/demo";
import { runGolden } from "../src/lib/demo/golden";
import { formatUsd } from "../src/lib/gateway";
import { toolMode } from "../src/lib/gateway/tool-protocol";
import { DEMO_BUSINESSES } from "../src/lib/storage/seed-demo";

// These modules read the environment only when called, so loading .env here is in time.
if (existsSync(".env")) process.loadEnvFile(".env");
process.env.STORAGE_BACKEND = "local";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const value = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const mode = flag("--replay") || !process.env.MODEL_API_KEY ? "REPLAY" : "LIVE";
const golden = flag("--golden") || mode === "REPLAY";
const record = flag("--record");
const time = value("--time");
const dir = process.env.DEMO_DIR?.trim() || DEFAULT_DEMO_DIR;
const print = (s: string) => console.log(s);
const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
})();

async function main() {
  if (record && mode !== "LIVE") throw new Error("--record needs LIVE (MODEL_API_KEY set, no --replay)");
  if (time && mode !== "LIVE") throw new Error("--time changes the input, so it needs LIVE; REPLAY only reproduces the recording");
  const fixture = mode === "REPLAY" ? loadFixture() : null;
  if (mode === "REPLAY" && !fixture) throw new Error(`REPLAY needs ${GOLDEN_FIXTURE}; record it with: npm run demo -- --golden --record`);

  const store = await openDemoStore(dir);
  const ctx = demoContext({
    mode,
    store,
    env: process.env,
    fixture: fixture ?? undefined,
    runCapUsd: Number(process.env.DEMO_CAP_USD || 0.3),
    maxCalls: Number(process.env.DEMO_MAX_CALLS || 40),
    clock: golden ? GOLDEN_CLOCK : undefined,
  });
  print(`MODE: ${mode}${mode === "REPLAY" ? ` (recorded ${fixture!.recordedAt} at ${fixture!.commit}; no network)` : " (Meta Model API through the spend gateway)"}`);
  print(`store: ${dir}/meta-brain.sqlite (the spend ledger lives here)   trace: ${ctx.tracePath}`);
  ctx.trace({ type: "run", mode, commit, golden, record, time: time ?? null, store: `${dir}/meta-brain.sqlite`, model: ctx.deps.model, clock: golden ? GOLDEN_CLOCK.toISOString() : "now", fixture: fixture ? { recordedAt: fixture.recordedAt, commit: fixture.commit, calls: fixture.exchanges.length } : null });

  try {
    if (golden) {
      const inv = await runGolden(ctx, { time }, print);
      print(`\n[${mode}] invariants:`);
      for (const i of inv) print(`[${mode}]   ${i.pass ? "PASS" : "FAIL"} ${i.name} (${i.detail})`);
      ctx.trace({ type: "invariants", mode, invariants: inv });
      await finish(ctx);
      if (record) {
        saveFixture({ scenario: "golden", recordedAt: new Date().toISOString(), commit, model: ctx.deps.model, toolMode: toolMode(process.env), clock: GOLDEN_CLOCK.toISOString(), exchanges: ctx.exchanges });
        print(`[${mode}] saved ${ctx.exchanges.length} recorded calls to ${GOLDEN_FIXTURE}`);
      }
      if (inv.some((i) => !i.pass)) process.exitCode = 1;
    } else {
      await chat(ctx);
      await finish(ctx);
    }
  } finally {
    await store.close();
  }
}

async function finish(ctx: Awaited<ReturnType<typeof demoContext>>) {
  const rows = (await ctx.store.listSpend()).filter((r) => r.runId === ctx.runId);
  const settled = rows.reduce((n, r) => n + (r.settledNano ?? 0), 0);
  print(`[${ctx.mode}] ledger: ${rows.length} rows for run ${ctx.runId}, ${formatUsd(settled)}${ctx.mode === "REPLAY" ? " (recorded cost replayed into the local demo ledger; nothing billed)" : ""}`);
  ctx.trace({ type: "ledger", mode: ctx.mode, runId: ctx.runId, rows: rows.length, settledUsd: settled / 1e9 });
}

/** Interactive LIVE chat. /biz <1-4>, /approve, /new, /quit. */
async function chat(ctx: Awaited<ReturnType<typeof demoContext>>) {
  const rl = createInterface({ input: stdin, output: stdout });
  let biz = 0;
  let session = `chat-${Date.now()}`;
  let n = 0;
  print(`[${ctx.mode}] businesses: ${DEMO_BUSINESSES.map((b, i) => `${i + 1}=${b.brain.name}`).join(", ")}. Commands: /biz <n>, /approve, /new, /quit`);
  for (;;) {
    const line = (await rl.question(`[${ctx.mode}] you -> ${nameOf(DEMO_BUSINESSES[biz].id)}: `)).trim();
    if (!line) continue;
    if (line === "/quit") break;
    if (line === "/new") {
      session = `chat-${Date.now()}`;
      continue;
    }
    if (line.startsWith("/biz")) {
      biz = Math.min(DEMO_BUSINESSES.length, Math.max(1, Number(line.split(/\s+/)[1]) || 1)) - 1;
      session = `chat-${Date.now()}`;
      continue;
    }
    if (line === "/approve") {
      const [a] = await ctx.store.listPendingApprovals(DEMO_BUSINESSES[biz].id);
      if (!a) print(`[${ctx.mode}] no pending booking for ${nameOf(DEMO_BUSINESSES[biz].id)}`);
      else await approve(ctx, ++n, a.id, print);
      continue;
    }
    await say(ctx, { n: ++n, businessId: DEMO_BUSINESSES[biz].id, session, text: line }, print);
  }
  rl.close();
}

main().catch((err) => {
  const live = err instanceof LiveError || mode === "LIVE";
  console.error(`\n${mode} ERROR${live ? " (no fallback to REPLAY)" : ""}: ${(err as Error).message}`);
  process.exitCode = 1;
});
