// The judge demo: a local chat simulator over the SAME engine, tools,
// verifier, ledger and owner approval as the WhatsApp path, on the local
// store. LIVE (a model API key in .env) calls the Meta Model API through the
// spend gateway and records every exchange; REPLAY answers from those
// recordings with no network. A LIVE error fails the run; it never falls
// back to REPLAY. Every run writes provenance/traces/<timestamp>.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createLiveGateway, SpendGateway, StoreSpendLedger, loadSpendConfig, usdToNano } from "../gateway";
import type { Env } from "../gateway/types";
import { handleInbound, type InboundResult } from "../engine/conversation-service";
import { DEMO_CLOCK } from "../engine/demo-script";
import type { EngineDeps } from "../engine/deps";
import { decideBooking } from "../engine/owner";
import { LocalStore } from "../storage/local-store";
import { CEDAR_BRAIN } from "../storage/seed-cedar";
import { DEMO_BUSINESSES, seedDemoBusinesses } from "../storage/seed-demo";
import type { Booking, Turn } from "../storage/types";
import { recordingFetch, type Exchange } from "./recorder";
import { ReplayDispatcher } from "./replay-dispatcher";

export type Mode = "LIVE" | "REPLAY";
export const DEFAULT_DEMO_DIR = "./data/demo";
export const GOLDEN_FIXTURE = "fixtures/replay/golden.json";
/** Fixed clock for the golden scenario, so a replay sends byte-identical requests. */
export const GOLDEN_CLOCK = DEMO_CLOCK;

export type Fixture = {
  scenario: "golden";
  recordedAt: string;
  commit: string;
  model: string;
  toolMode: string;
  clock: string;
  exchanges: Exchange[];
};

/** The local store, seeded with the four demo businesses on first run. */
export async function openDemoStore(dir = DEFAULT_DEMO_DIR): Promise<LocalStore> {
  const store = LocalStore.open(dir);
  if (!(await store.listBusinesses()).length) await reseed(store);
  return store;
}

/** Fresh business data (the ledger is kept): Cedar Street Barbers plus the three other demo businesses. */
export async function reseed(store: LocalStore): Promise<void> {
  await store.reset(CEDAR_BRAIN);
  await seedDemoBusinesses(store);
}

export type DemoContext = {
  mode: Mode;
  deps: EngineDeps;
  store: LocalStore;
  runId: string;
  exchanges: Exchange[];
  trace: (line: Record<string, unknown>) => void;
  tracePath: string;
  /** REPLAY: recorded calls not yet used; must be 0 at the end. */
  remaining?: () => number;
  /** The last error thrown below the dispatcher (network, timeout, replay mismatch). */
  lastError: () => string | null;
};

/**
 * LIVE: the real dispatcher behind the gateway's live gate, with a run cap.
 * REPLAY: the same dispatcher (same parsing) over a fetch that only replays the
 * fixture; its preflight is not used because no request can leave the process.
 */
export function demoContext(opts: {
  mode: Mode;
  store: LocalStore;
  env: Env;
  fixture?: Fixture;
  runCapUsd: number;
  maxCalls: number;
  clock?: Date;
  traceDir?: string;
}): DemoContext {
  const started = new Date();
  const runId = `demo-${opts.mode.toLowerCase()}-${started.toISOString().replace(/[:.]/g, "-")}`;
  const tracePath = resolve(opts.traceDir ?? "provenance/traces", `${started.toISOString().replace(/[:.]/g, "-")}.jsonl`);
  mkdirSync(dirname(tracePath), { recursive: true });
  const trace = (line: Record<string, unknown>) => appendFileSync(tracePath, JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n");
  const exchanges: Exchange[] = [];
  const onExchange = (e: Exchange) => {
    exchanges.push(e);
    trace({ type: "model_call", mode: opts.mode, ...callSummary(e) });
  };
  const now = () => opts.clock ?? new Date();
  let lastError: string | null = null;
  const watch = <F extends typeof fetch>(f: F): F =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        return await f(input, init);
      } catch (err) {
        lastError = (err as Error).message;
        throw err;
      }
    }) as F;
  const run = { id: runId, capNano: usdToNano(opts.runCapUsd) };

  if (opts.mode === "LIVE") {
    const gateway = createLiveGateway({ store: opts.store, env: opts.env, run, maxCalls: opts.maxCalls, fetchFn: watch(recordingFetch(fetch, onExchange)) });
    const model = opts.env.MODEL_CHAT_MODEL?.trim() || "muse-spark-1.3";
    return { mode: "LIVE", deps: { store: opts.store, gateway, model, now }, store: opts.store, runId, exchanges, trace, tracePath, lastError: () => lastError };
  }

  if (!opts.fixture) throw new Error(`REPLAY needs ${GOLDEN_FIXTURE}`);
  const dispatcher = new ReplayDispatcher(opts.fixture.exchanges, opts.fixture.toolMode, onExchange);
  const gateway = new SpendGateway({
    ledger: new StoreSpendLedger(opts.store, loadSpendConfig({ MODEL_SPEND_HARD_CAP_USD: opts.env.MODEL_SPEND_HARD_CAP_USD || "5", MODEL_CREDIT_BALANCE_USD: "150" })),
    dispatcher,
    run,
  });
  return {
    mode: "REPLAY",
    deps: { store: opts.store, gateway, model: opts.fixture.model, now },
    store: opts.store,
    runId,
    exchanges,
    trace,
    tracePath,
    remaining: () => dispatcher.remaining(),
    lastError: () => dispatcher.lastError(),
  };
}

function callSummary(e: Exchange) {
  let usage: Record<string, unknown> | null = null;
  let finish: string | null = null;
  try {
    const body = JSON.parse(e.response?.body ?? "null");
    usage = body?.usage ?? null;
    finish = body?.choices?.[0]?.finish_reason ?? null;
  } catch {
    // non-JSON response: no usage
  }
  const req = e.request as { model?: string } | null;
  return {
    seq: e.seq,
    path: e.path,
    model: req?.model ?? null,
    providerRequestId: e.providerRequestId,
    status: e.response?.status ?? null,
    latencyMs: e.latencyMs,
    finishReason: finish,
    promptTokens: (usage?.prompt_tokens as number) ?? null,
    completionTokens: (usage?.completion_tokens as number) ?? null,
    error: e.error,
  };
}

export class LiveError extends Error {}

/** One customer message through the engine; records the step in the trace and prints it. */
export async function say(ctx: DemoContext, step: { n: number; businessId: string; session: string; text: string }, print: (s: string) => void) {
  const before = ctx.exchanges.length;
  print(`[${ctx.mode}] customer (${nameOf(step.businessId)}): ${step.text}`);
  const r = await handleInbound(
    { businessId: step.businessId, channel: "panel", externalConversationId: step.session, senderId: step.session, text: step.text, externalEventId: `${ctx.runId}-${step.n}` },
    ctx.deps,
  );
  const summary = await stepSummary(ctx, r, step.businessId);
  for (const v of summary.verifier) print(`[${ctx.mode}]   verifier ${v.pass ? "PASS" : "BLOCK"} ${v.target}${v.pass ? "" : `: ${v.failed.join("; ")}`}`);
  for (const t of summary.toolCalls) print(`[${ctx.mode}]   tool ${t.name} ${JSON.stringify(t.arguments)}`);
  print(`[${ctx.mode}] assistant (${r.outcome}): ${r.replyText ?? "(no reply)"}`);
  ctx.trace({ type: "step", mode: ctx.mode, n: step.n, kind: "customer", businessId: step.businessId, session: step.session, input: step.text, modelCalls: ctx.exchanges.slice(before).map((e) => e.seq), ...summary });
  // A model failure ends the run in both modes: LIVE never falls back, REPLAY never papers over a mismatch.
  if (summary.ownerHelp && /model_(failed|denied)/.test(summary.ownerHelp.reason)) {
    throw new LiveError(`${ctx.mode} model call failed at step ${step.n}: ${summary.ownerHelp.reason}: ${summary.ownerHelp.detail}${ctx.lastError() ? ` (${ctx.lastError()})` : ""}`);
  }
  return { result: r, summary };
}

/** The owner approves the conversation's pending booking; the reply goes to the panel (no WhatsApp). */
export async function approve(ctx: DemoContext, n: number, approvalId: string, print: (s: string) => void) {
  const d = await decideBooking(ctx.store, approvalId, "approved", async () => ({ ok: true, status: null, channel: "panel" }));
  print(`[${ctx.mode}] owner approves ${approvalId.slice(0, 8)}: booking ${d.booking?.status}`);
  print(`[${ctx.mode}] reply to customer: ${d.replyText}`);
  ctx.trace({ type: "step", mode: ctx.mode, n, kind: "owner_approve", approvalId, changed: d.changed, booking: d.booking && bookingView(d.booking), reply: d.replyText });
  return d;
}

type StepSummary = {
  outcome: string;
  reply: string | null;
  toolCalls: Array<{ name: string; arguments: unknown }>;
  toolResults: Array<{ name: string; ok: boolean; output?: unknown; error?: string }>;
  verifier: Array<{ target: string; pass: boolean; failed: string[]; checks: unknown }>;
  ownerHelp: { reason: string; detail: string } | null;
  pendingApprovalId: string | null;
  ledger: Array<Record<string, unknown>>;
  bookings: Array<ReturnType<typeof bookingView>>;
};

async function stepSummary(ctx: DemoContext, r: InboundResult, businessId: string): Promise<StepSummary> {
  const turns: Turn[] = r.trace;
  const cps = turns.map((t) => t.checkpoint ?? {}) as Array<Record<string, any>>;
  const customerTurnId = turns.find((t) => t.role === "customer")?.id;
  const rows = (await ctx.store.listSpend()).filter((x) => x.runId === ctx.runId && x.turnId === customerTurnId);
  return {
    outcome: r.outcome,
    reply: r.replyText,
    toolCalls: cps.filter((c) => c.kind === "tool_call").flatMap((c) => c.toolCalls ?? []).map((c: any) => ({ name: c.name, arguments: c.arguments })),
    toolResults: cps.filter((c) => c.kind === "tool_result").map((c) => ({ name: c.result?.name, ok: c.result?.ok, ...(c.result?.ok ? { output: c.result.output } : { error: c.result?.error }) })),
    verifier: cps
      .filter((c) => c.kind === "verifier")
      .map((c) => ({ target: c.target, pass: c.pass, failed: (c.checks ?? []).filter((k: any) => !k.pass).map((k: any) => `${k.rule}: ${k.claim}`), checks: c.checks })),
    ownerHelp: cps.find((c) => c.kind === "owner_help") ? { reason: cps.find((c) => c.kind === "owner_help")!.reason, detail: cps.find((c) => c.kind === "owner_help")!.detail ?? "" } : null,
    pendingApprovalId: r.pendingApprovalId ?? null,
    ledger: rows.map((x) => ({
      id: x.id,
      model: x.model,
      state: x.state,
      reservedUsd: x.reservedNano / 1e9,
      settledUsd: x.settledNano === null ? null : x.settledNano / 1e9,
      tokensIn: x.tokensIn,
      tokensOut: x.tokensOut,
      reasoningTokens: x.reasoningTokens,
      finishReason: x.finishReason,
      createdAt: x.createdAt,
    })),
    bookings: (await ctx.store.listBookings(businessId)).map(bookingView),
  };
}

function bookingView(b: Booking) {
  return { id: b.id, status: b.status, serviceId: b.serviceId, startsAt: b.startsAt, priceCents: b.priceCents, currency: b.currency, discountId: b.discountId };
}

export function nameOf(businessId: string): string {
  return DEMO_BUSINESSES.find((b) => b.id === businessId)?.brain.name ?? businessId;
}

export function loadFixture(path = GOLDEN_FIXTURE): Fixture | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Fixture) : null;
}

export function saveFixture(fixture: Fixture, path = GOLDEN_FIXTURE): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 1) + "\n");
}

