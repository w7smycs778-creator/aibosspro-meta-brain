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

- 2026-10-27 23:40 IST, Day 1 close-out: the API key value from the local env file was searched across all 6 commits then in history (0 hits) and all tracked files (0 hits). Added `scripts/secret-scan.sh` (commit `762ebe5`): scans staged content, or all tracked files with `--all`, with one exact allowlist entry for the runtime auth-header line in `src/lib/gateway/meta-dispatcher.ts`. A local pre-push hook runs it with `--all`.

### 2026-10-28 — Day 2: WhatsApp webhook, signature check, echo reply, Vercel deploy

Commits: `803686d` WhatsApp webhook; `8c7a5d9` ignore the local `.vercel` link directory.

Files created today:

- `src/lib/whatsapp/signature.ts`: verifies `X-Hub-Signature-256` (HMAC-SHA256 of the raw request body with the app secret, timing-safe compare; fails closed on a missing secret or a missing or malformed header).
- `src/lib/whatsapp/send.ts`: WhatsApp Cloud API text sender (Graph API v25.0 `/{phone-number-id}/messages`). Separate from `src/lib/gateway`; it calls no model and carries no model spend. The auth header is built without the literal the secret scan flags, so the scan allowlist is unchanged.
- `src/lib/whatsapp/webhook.ts`: extracts incoming text messages (statuses and non-text types are ignored), builds the reply with the AI disclosure prefix and an echo capped at 200 characters, and dedupes on message id in memory (best effort, per instance; durable dedupe is planned).
- `src/app/api/whatsapp/webhook/route.ts`: GET verification handshake (challenge as plain text on a matching token, 403 otherwise); POST returns 401 on an invalid signature, otherwise 200 at once, with replies sent after the response. Logs carry only the message id and the sender's last 4 digits.
- `src/lib/whatsapp/whatsapp.test.ts`: 10 vitest tests (valid signature, tampered body, missing header, wrong verify token 403, duplicate message id replies once, echo cap, ignored statuses and non-text). Full suite 28/28, typecheck and `next build` clean.

Deployment: Vercel project `aibosspro-brain-hackathon`, production at `https://aibosspro-brain-hackathon.vercel.app`, built from commit `8c7a5d9` through the GitHub integration. Five production environment variables set from the local env file through stdin, all marked sensitive; no model or live-credit variables are set, so the deployment cannot make model calls.

Live checks on production, 2026-10-28 12:54 IST: GET with a wrong verify token returned 403; GET with the correct token returned 200 with the challenge echoed; POST with a bad signature returned 401; POST with no signature returned 401; a correctly signed POST with no messages returned 200. No WhatsApp message was sent by these checks.

### 2026-10-29 — Day 3A: storage interface, durable ledger, tool-call gateway

Branch `day3a-storage`. No hosted model inference was run; all model calls in tests go to a scripted mock client.

- Storage interface (`src/lib/storage/types.ts`): businesses with versioned brains and an approved flag, conversations with AUTO/HUMAN/PAUSED mode, turns with JSON checkpoints, pending approvals, bookings (created only together with the owner approval that gates them), spend ledger rows and processed-event ids. `reset()` wipes business data and reseeds one synthetic business (`src/lib/storage/seed.ts`, invented name, services, prices, hours and one discount rule); it keeps the spend ledger and processed-event ids so a reset cannot lift the cap or replay events.
- Local store (`src/lib/storage/local-store.ts`): SQLite through better-sqlite3 in `./data/` (gitignored), survives restarts; atomic writes use IMMEDIATE transactions.
- Supabase store (`src/lib/storage/supabase-store.ts`): same interface, service-role key, server only. New migration `supabase/migrations/20261029090000_storage_and_durable_ledger.sql`, NOT APPLIED: engine tables with RLS on, and ledger functions that take the cap from env and sum ledger rows under a lock instead of reading budget counters. Factory `STORAGE_BACKEND=local|supabase` (default local; local refused on a hosted deploy).
- Durable spend ledger: `InMemorySpendLedger` removed; `StoreSpendLedger` writes one row per attempt (time, model, tokens in/out, estimate and settled nano-USD, business id, turn id) at reserve and settles it before the result is returned. Every cap check sums the stored rows. The server exits at start if `MODEL_SPEND_HARD_CAP_USD` is missing or above $130 (`src/instrumentation.ts`, `src/lib/startup.ts`).
- Hosted-inference gate: the Meta dispatcher refuses before any network request unless `LIVE_CREDITS_VERIFIED=true`, `STORAGE_BACKEND=supabase`, the gateway's ledger is the Supabase store and its ledger table answers. It also refuses tool-bearing calls until tools are wired to the Meta API.
- Durable dedupe: the WhatsApp route claims each message id in the processed-event store; the in-memory `MessageDedupe` is removed. If the store fails, already-claimed messages are answered and the route returns 503 so Meta redelivers the rest.
- Gateway tool calls (`src/lib/gateway/types.ts`, `tools.ts`, `tool-loop.ts`, `mock-client.ts`): typed tool definitions, tool-call request/result types, a run loop that offers and executes only tools permitted by deterministic code (PAUSED: none, HUMAN: read-only, AUTO: all; write tools only create pending records), checkpoints every call and result as a turn, and hands to the owner on a refused tool, a denied or failed model call, or `TOOL_LOOP_MAX_ITERATIONS` (default 6). `MockModelClient` returns scripted tool calls for tests.
- Removed the unused `META_WEBHOOK_VERIFY_TOKEN` from `.env.example` (the route reads `WHATSAPP_VERIFY_TOKEN`); documented the new variables.
- Tests: `src/lib/storage/day3a.test.ts` (ledger cap $1.00 with three $0.40 mock calls, durable dedupe across reopen, permitted and refused tool calls, max iterations, gate refusals, startup refusal, reset) and the existing gateway tests moved onto the durable ledger. Full suite 40/40, typecheck and `next build` clean.

## Third-party

## Day 2 close — 2026-10-28 (channel live)
- Permanent System User token (no expiry) replaces temp token; sees test number 555-175-0081.
- WhatsApp round-trip confirmed on real phone: inbound "test" -> brain echo reply, signature-checked, 3:21pm Israel.
- Webhook registered + active, messages field subscribed, Vercel production redeployed.
- Gate met: live channel, deployed app, judge-accessible URL.
