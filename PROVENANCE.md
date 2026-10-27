## Pre-existing (before Oct 27, 2026)

Planning documents only (BUILD-PLAN.md). No code. My separate AIBOSSPRO CRM, WhatsApp bots and client systems are not part of this repository and none of their code is reused.

## Built during the hackathon (Oct 27 – Nov 4, 2026)

### 2026-10-27 — Repository baseline

- Baseline commit: `72a4f4148165a728f6ce976257cb84bbbe910888` (empty), 2026-10-27T12:38:53+02:00. Followed by `9d5b76a` adding `.gitignore` and `.nvmrc` (Node 20).
- BUILD-PLAN.md, CLAUDE.md, AGENTS.md, the research folder and all other planning files predate the first commit and are pre-build planning, not implementation.
- Every implementation file in this repository is created on or after Oct 27, 2026 and is logged in this section by date.
- No CRM, WAHA or client code is imported into this repository.

### 2026-10-27 — Day 1: skeleton, spend gateway, smoke tests

Commits: `dc8fce8` provenance log and env template; `cfb0dfc` Next.js TypeScript skeleton; `8a9fc18` spend gateway, tests, smoke harness.

Files created today:

- `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.mts`, `src/app/layout.tsx`, `src/app/page.tsx`: minimal Next.js 16 App Router app (Node 20, TypeScript 5.9, vitest 4).
- `src/lib/gateway/`: the single model-call gateway. `gateway.ts` (reserve before dispatch, settle after, retries billed, bounds on output tokens, media size, images, retries and rounds), `ledger.ts` (ledger interface + in-memory implementation), `pricing.ts` (Standard-mode prices fetched from dev.meta.ai on 2026-10-27), `config.ts` ($130 ceiling, $20 buffer, fails closed without a credit balance), `meta-dispatcher.ts` (real Meta Model API dispatcher, blocked unless `LIVE_CREDITS_VERIFIED=true`), `errors.ts`, `money.ts`, `types.ts`, `index.ts`.
- `src/lib/gateway/gateway.test.ts`: 18 vitest tests (concurrency vs cap, retries billed, unknown cost, hard cap, $20 buffer, settlement release, run cap, bounds, live-credit guard, gateway isolation). All pass.
- `supabase/migrations/20261027120000_model_spend_ledger.sql`: Postgres ledger with row-locked reservation functions. Not applied.
- `scripts/smoke.ts`, `scripts/make-smoke-fixtures.sh`, `scripts/make_product_photo.py`: smoke harness and fixture generators.
- `fixtures/smoke/he-en-booking.wav` (synthetic, macOS `say` voices Carmit + Samantha, 5.7 s), `fixtures/smoke/product-mug.png` (synthetic, drawn with Pillow).

Smoke results (one call per model through the gateway, $10 run cap, synthetic inputs only):

| Model | HTTP | Latency ms | Reserved | Settled |
|---|---|---|---|---|
| muse-spark-1.3 (JSON schema output) | 200 | 2541 | $0.004925 | $0.001822 |
| muse-voice-transcribe-1.0 (Hebrew + English clip) | 200 | 3274 | $0.000650 | $0.000300 |
| sam-3.1 (product photo, "mug") | 200 | 1392 | $0.002500 | $0.002500 |
| muse-image-1.0 (one background) | 200 | 14873 | $0.010000 | $0.010000 |

Total settled: $0.014622. Settled figures are the gateway's computed cost from provider-reported units; reconcile against Billing.

## Third-party
