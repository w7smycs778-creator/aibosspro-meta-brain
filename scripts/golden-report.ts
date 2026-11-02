// Builds provenance/GOLDEN-RUN.md from a LIVE golden trace, its REPLAY trace and
// fixtures/replay/golden.json. Every cell comes from those records; a field the
// provider did not return is written as "not returned", never filled in.
// Run: npx tsx scripts/golden-report.ts <live-trace.jsonl> <replay-trace.jsonl> [earlier-live-trace.jsonl ...]
// The Wonder section reads provenance/wonder-qc-hosted-*.json (hosted records saved after a content run).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadFixture } from "../src/lib/demo/demo";

type Line = Record<string, any>;
const read = (p: string): Line[] => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cell = (s: unknown, max = 90) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return (t.length > max ? t.slice(0, max - 1) + "…" : t).replace(/\|/g, "\\|") || "–";
};
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `$${n.toFixed(6)}`);

const [livePath, replayPath, ...earlier] = process.argv.slice(2);
if (!livePath || !replayPath) throw new Error("pass the LIVE and REPLAY trace paths");
const live = read(livePath);
const replay = read(replayPath);
const fixture = loadFixture();
if (!fixture) throw new Error("fixtures/replay/golden.json is missing");
const run = live.find((l) => l.type === "run")!;
const calls = live.filter((l) => l.type === "model_call");
const steps = live.filter((l) => l.type === "step");
const inv = live.find((l) => l.type === "invariants")?.invariants ?? [];
const replayInv = replay.find((l) => l.type === "invariants")?.invariants ?? [];
const replayRun = replay.find((l) => l.type === "run")!;
const ledger = live.find((l) => l.type === "ledger")!;
if (run.commit !== fixture.commit) throw new Error(`trace commit ${run.commit} != fixture commit ${fixture.commit}: not the recording run`);

function responseOf(seq: number): { kind: string; text: string } {
  const ex = fixture!.exchanges.find((e) => e.seq === seq);
  if (!ex?.response) return { kind: "no response", text: ex?.error ?? "" };
  const msg = JSON.parse(ex.response.body)?.choices?.[0]?.message;
  if (msg?.tool_calls?.length) return { kind: "tool call", text: msg.tool_calls.map((t: any) => `${t.function?.name}(${t.function?.arguments})`).join("; ") };
  return { kind: "text", text: msg?.content ?? "" };
}

// Where each step's flow is shown in the submission demo video: the hosted run, not this recording.
const VIDEO: Record<number, string> = { 1: "0:04-0:31", 2: "0:04-0:31", 3: "0:04-0:31", 4: "1:01-1:27", 5: "1:01-1:27" };
const video = (n: number) => (VIDEO[n] ? `${VIDEO[n]} (same flow, hosted run)` : "–");

const rows: string[] = [];
for (const s of steps) {
  if (s.kind === "owner_approve") {
    rows.push(`| ${s.n} | owner taps Approve (${cell(s.approvalId, 12)}) | no model call | – | decideBooking | – | – | ${cell(s.booking?.status)} ${s.booking ? `${s.booking.priceCents} ${s.booking.currency}` : ""} | ${video(s.n)} |`);
    rows.push(`| | reply to customer | | | | | | ${cell(s.reply, 120)} | |`);
    continue;
  }
  const verdicts = [...s.verifier];
  const results = [...s.toolResults];
  const ledgerRows = [...s.ledger];
  for (const [i, seq] of (s.modelCalls as number[]).entries()) {
    const c = calls.find((x) => x.seq === seq)!;
    const r = responseOf(seq);
    const v = verdicts.shift();
    const tool = r.kind === "tool call" ? results.shift() : null;
    const l = ledgerRows.shift();
    const booking = i === s.modelCalls.length - 1 ? s.bookings.map((b: any) => `${b.status} ${b.serviceId} ${b.startsAt} ${b.priceCents} ${b.currency}`).join("; ") || "none" : "";
    rows.push(
      `| ${i === 0 ? s.n : ""} | ${i === 0 ? cell(s.input, 70) : ""} | #${seq} \`${c.path}\` ${c.model}, req id \`${c.providerRequestId ?? "not returned"}\`, ${c.latencyMs} ms | ${r.kind}: ${cell(r.text, 110)} (finish ${c.finishReason ?? "not returned"}) | ${tool ? `${tool.ok ? "ok" : "error"}: ${cell(JSON.stringify(tool.ok ? tool.output : tool.error), 90)}` : "–"} | ${v ? `${v.pass ? "PASS" : "**BLOCK**"} ${v.target}${v.pass ? "" : `: ${cell(v.failed.join("; "), 60)}`}` : "–"} | ${l ? `reserved ${usd(l.reservedUsd)}, settled ${usd(l.settledUsd)}; in ${l.tokensIn}, out ${l.tokensOut} (reasoning ${l.reasoningTokens ?? "not returned"})` : "–"} | ${cell(booking, 80)} | ${video(s.n)} |`,
    );
  }
}

const lat = calls.map((c) => c.latencyMs as number).sort((a, b) => a - b);
const median = lat.length % 2 ? lat[(lat.length - 1) / 2] : (lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2;
const customerSteps = steps.filter((s) => s.kind === "customer");
const perTurn = customerSteps.map((s) => s.ledger.reduce((n: number, l: any) => n + (l.settledUsd ?? 0), 0));
const perCall = customerSteps.flatMap((s) => s.ledger.map((l: any) => l.settledUsd ?? 0));

const md = `# Golden run

Anchored to commit \`${fixture.commit}\` (recorded ${fixture.recordedAt}). Model \`${fixture.model}\`, tool mode \`${fixture.toolMode}\`, fixed clock ${fixture.clock} (Thursday). Local store \`${run.store}\`.

Raw records: LIVE trace [\`${livePath}\`](${livePath.replace(/^provenance\//, "")}), REPLAY trace [\`${replayPath}\`](${replayPath.replace(/^provenance\//, "")}), recorded request/response pairs [\`fixtures/replay/golden.json\`](../fixtures/replay/golden.json) (exchange \`seq\` = the # below; request bodies as sent, without request headers; response bodies and headers as received, cookies dropped).

The scenario is fictional: Cedar Street Barbers and Clinique Physio Érable are invented demo businesses; Dana and 000-0000 are made up. Every model reply below was produced live and is replayed, not rewritten; the \`[AI assistant]\` prefix and the owner-approval reply are fixed code strings, not model output.

## Steps

| Step | Input | API request (seq, endpoint, model, provider request id, latency) | Raw response | Tool result | Verifier verdict | Ledger (reservation → settlement, tokens) | Booking state | Video |
|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

The block in step ${customerSteps.find((s) => s.verifier.some((v: any) => !v.pass))?.n ?? "–"}: the customer named 12:45, which is neither an opening boundary nor a slot from check_availability, so the time rule blocked the first reply that repeated it; the model corrected once and the second reply passed. This is a known false positive of a bounded verifier: it allows only times, prices, durations and percentages it can tie to the brain or the latest tool result.

## Measured (LIVE, this run)

- Model calls: ${calls.length} (all \`${fixture.model}\`, all HTTP ${[...new Set(calls.map((c) => c.status))].join("/")}). Latency per call, measured at the HTTP client: min ${lat[0]} ms, median ${median} ms, max ${lat[lat.length - 1]} ms (n=${lat.length}).
- Cost per call (ledger settlement): min ${usd(Math.min(...perCall))}, max ${usd(Math.max(...perCall))} (n=${perCall.length}). Cost per customer turn: ${perTurn.map((c) => usd(c)).join(", ")} (n=${perTurn.length}). Run total ${usd(ledger.settledUsd)} over ${ledger.rows} ledger rows (run \`${ledger.runId}\`).
- The owner approval and the reply it sends make no model call.
- REPLAY latency is not a model measurement (answers come from the file) and is not reported.

## Invariants

| Invariant | LIVE (${run.commit}) | REPLAY (${replayRun.commit}) |
|---|---|---|
${inv.map((i: any) => `| ${i.name} | ${i.pass ? "PASS" : "FAIL"} (${cell(i.detail, 60)}) | ${(() => { const r = replayInv.find((x: any) => x.name === i.name); return r ? `${r.pass ? "PASS" : "FAIL"} (${cell(r.detail, 60)})` : "–"; })()} |`).join("\n")}
${replayInv.filter((r: any) => !inv.some((i: any) => i.name === r.name)).map((r: any) => `| ${r.name} | – | ${r.pass ? "PASS" : "FAIL"} (${cell(r.detail, 60)}) |`).join("\n")}

## Reproduce

- Offline, exactly this run: \`npm run demo -- --replay\` (no API key needed; any request that differs from the recording stops the run) (shown in the demo video at 2:08-2:31).
- Live, with a changed input: \`npm run demo -- --golden --time 11:00\` (needs a model API key; capped by DEMO_CAP_USD, default $0.30). It asserts the invariants above, not the wording: the slot is held pending approval, the booked price equals \`priceOn\` (code-computed), owner approval confirms it, the Hebrew reply is a verified model reply, every final reply has a verifier verdict, and the verifier blocks at least one reply.

## Wonder creative QC (hosted content run)

${(() => {
  const files = readdirSync("provenance").filter((f) => /^wonder-qc-hosted-.*\.json$/.test(f)).sort();
  if (!files.length) return "No hosted Wonder QC record in provenance/.";
  const w = JSON.parse(readFileSync(`provenance/${files.at(-1)}`, "utf8"));
  const row = w.ledger.find((l: any) => l.model === "muse-wonder-1.0");
  const total = w.ledger.reduce((n: number, l: any) => n + l.settledUsd, 0);
  return [
    `Record: [\`provenance/${files.at(-1)}\`](${files.at(-1)}). ${w.note}`,
    "",
    "| Step | Input | API request | Raw response | Tool result | Verifier verdict | Ledger | Booking state | Video |",
    "|---|---|---|---|---|---|---|---|---|",
    `| QC | feed export of creative \`${w.creativeId.slice(0, 8)}\` (${w.qc?.sent ?? "not recorded"}), object "${w.object}" | \`/v1/chat/completions\` muse-wonder-1.0, image_url part, json_schema \`creative_qc\` | ${cell(JSON.stringify(w.qc?.answer ?? null), 140)} | – | QC ${String(w.qc?.status ?? "not recorded").toUpperCase()} (advisory; decided by code from the three checks; the owner approves) | ${row ? `reserved ${usd(row.reservedUsd)}, settled ${usd(row.settledUsd)}; in ${row.tokensIn}, out ${row.tokensOut} (reasoning ${row.reasoningTokens ?? "not returned"})` : "–"} | creative ${w.status} | 1:43-2:08 (same flow, hosted run) |`,
    "",
    `Whole content run: ${w.ledger.length} calls (${w.ledger.map((l: any) => l.model).join(", ")}), ${usd(total)} (n=1). The provider request id for this call was not kept in the hosted record.`,
  ].join("\n");
})()}

## Image and audio outputs

None in this scenario. The hosted content run of 2026-11-01 (creative \`f6066875\`, Supabase bucket \`creative-media\`, not in the repo) kept the Muse Image output byte-identical with its response headers and \`x-request-id\`; its manifest is described in PROVENANCE.md. The Spanish/French Voice Transcribe check is in PROVENANCE.md (local research notes are not committed).
${earlier.length ? `
## Earlier LIVE recordings of this scenario (kept, not used)

${earlier.map((p) => { const t = read(p); const i = t.find((l) => l.type === "invariants")?.invariants ?? []; const f = i.filter((x: any) => !x.pass).map((x: any) => `${x.name}: ${x.detail}`); const l = t.find((x) => x.type === "ledger"); return `- [\`${p}\`](${p.replace(/^provenance\//, "")}) at ${t.find((x) => x.type === "run")?.commit}: ${f.length ? `FAIL ${cell(f.join("; "), 140)}` : "all invariants passed"}; ${usd(l?.settledUsd)}`; }).join("\n")}
` : ""}`;

writeFileSync("provenance/GOLDEN-RUN.md", md);
console.log(`wrote provenance/GOLDEN-RUN.md (${rows.length} table rows)`);
