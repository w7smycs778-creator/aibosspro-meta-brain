# AIBOSSPRO Meta Brain

An AI front desk for a small service business, built on Meta's models. The owner describes the business once, by voice or text; Muse Spark turns that into a structured "brain" (services, prices, hours, discount rules, tone, languages) that the owner reviews and approves. Customers then chat with an assistant (a customer panel, a terminal simulator, or WhatsApp) that answers in their language (English, Hebrew, Spanish, French), checks real availability, quotes prices computed by code, and requests bookings that only the owner can approve. Every reply passes a deterministic verifier before it is sent. The same brain drives a content engine: SAM 3.1 cuts the product out of a photo, Muse Image paints a scene, code composites the offer and price, Spark writes a verified caption, and the owner approves the post.

Every AI reply is labelled as AI. Nothing is booked or published without the owner's approval. Owner switches per conversation: AUTO, HUMAN, PAUSED.

**Everything you see is fictional.** The four demo businesses, their prices, customers ("Dana, 000-0000") and the bundled product photo are invented. Recorded model outputs are labelled as recorded wherever they appear (REPLAY mode, `fixtures/replay/`, `provenance/`).

## 5-minute setup (clean clone)

You need git and Node 22.12 or newer, or Node 20.19 or newer (some dependencies refuse older versions). macOS or Linux. Check with `node -v`; with nvm, `nvm install && nvm use` inside the repository picks the version in `.nvmrc`.

```bash
cd ~                       # anywhere in your home directory, NOT /tmp (see "Where the ledger lives")
git clone https://github.com/w7smycs778-creator/aibosspro-meta-brain.git meta-brain && cd meta-brain
nvm install && nvm use     # only if `node -v` is older than the versions above
npm ci
cp .env.example .env
npm run demo               # REPLAY: the recorded golden scenario, offline, no API key needed
```

That prints `MODE: REPLAY` and replays a recorded run end to end: an English booking request held for the owner and approved, a Hebrew exchange, and a reply the verifier blocks, then checks the invariants (all must print PASS).

To run it live against the Meta Model API, open `.env`, paste your Meta Model API key after `MODEL_API_KEY` (on the same line, after the `=`), and set the live switches:

```bash
MODEL_CREDIT_BALANCE_USD=<credit left in Meta Model API Billing, e.g. 150>
MODEL_SPEND_HARD_CAP_USD=5
LIVE_CREDITS_VERIFIED=true      # set this yourself after checking the key has credit; code never sets it
```

then:

```bash
npm run demo -- --golden        # LIVE golden scenario (about $0.02 to $0.03; capped per run, default $0.30)
npm run demo                    # LIVE interactive chat: /biz 1-4 to switch business, /approve, /new, /quit
npm run demo -- --replay        # force REPLAY even with a key
```

The web app (owner screen, customer panel, onboarding, content) is `npm run judge`, then http://localhost:3000/owner. See "What to click" below.

## Modes

| | REPLAY | LIVE |
|---|---|---|
| When | no `MODEL_API_KEY` in `.env`, or `--replay` | `MODEL_API_KEY` set |
| Model calls | none: answers come from `fixtures/replay/golden.json` | Meta Model API through the spend gateway |
| What runs for real | everything else: engine, tools, verifier, spend ledger, bookings, owner approval | everything |
| If something differs | a request that differs from the recording stops the run ("REPLAY: call N differs from the recording") | a model error stops the run ("LIVE ERROR (no fallback to REPLAY)") |
| Cost | none billed (the recorded cost is written to the local demo ledger, labelled as replayed) | real, capped by `DEMO_CAP_USD` and `DEMO_MAX_CALLS` |

The mode is printed in capitals at the start and on every line of the run. LIVE never falls back to REPLAY. REPLAY only reproduces the recorded inputs; to try your own input, use LIVE (`npm run demo -- --golden --time 11:00` changes the requested time and still checks the same invariants).

Every run writes `provenance/traces/<timestamp>.jsonl`: each model call (endpoint, model, provider request id when returned, HTTP status, latency, tokens, finish reason), each step's tool calls and results, verifier verdicts, ledger rows (reservation and settlement), and the booking state. [provenance/GOLDEN-RUN.md](provenance/GOLDEN-RUN.md) is the step-by-step evidence table of the recorded run, generated from its trace and fixture.

### Where the ledger lives

The spend ledger is SQLite: `./data/demo/meta-brain.sqlite` for `npm run demo` (override with `DEMO_DIR`), `./data/meta-brain.sqlite` for the web app. Live calls are refused when the ledger file is in a temp directory (`/tmp`, `$TMPDIR`), because a temp file is not durable; clone into your home directory. `./data/` is git-ignored.

## .env names

`cp .env.example .env` gives every name. What each mode needs:

| Name | REPLAY demo | LIVE demo / web app | Hosted (Vercel) |
|---|---|---|---|
| `MODEL_SPEND_HARD_CAP_USD` | optional (default 5) | required, at most 130 | required |
| `MODEL_API_KEY`, `MODEL_API_BASE_URL` | – | required (base URL is pre-filled) | required |
| `MODEL_CREDIT_BALANCE_USD` | – | required (unknown balance fails closed) | required |
| `LIVE_CREDITS_VERIFIED` | – | `true`, set by you | `true` |
| `MODEL_TOOL_MODE` | – | `native` (pre-filled) | `native` |
| `MODEL_CHAT_MODEL` | – | optional (default `muse-spark-1.3`) | optional |
| `DEMO_CAP_USD`, `DEMO_MAX_CALLS`, `DEMO_DIR` | – | optional (0.30, 40, `./data/demo`) | – |
| `STORAGE_BACKEND`, `STORAGE_DIR` | – (the demo is always local) | `local` | `supabase` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | – | – | required |
| `OWNER_ACCESS_TOKEN` | – | – | required for the owner screen hosted |
| `WHATSAPP_*`, `META_APP_SECRET` | – | – | only for the WhatsApp path |

## What to click (web app)

Four demo businesses, one per supported language. Pick one with the business selector at the top of `/owner`.

| Business | Languages | Zone, currency | Discount rule (price computed by code) |
|---|---|---|---|
| Cedar Street Barbers | English, Hebrew | Asia/Jerusalem, ₪ | Cut plus beard 15% off on Tuesdays: ₪102 instead of ₪120 |
| סטודיו אופק פילאטיס (Tel Aviv pilates) | Hebrew, English | Asia/Jerusalem, ₪ | שיעור פרטי 20% off on Mondays: ₪240 instead of ₪300 |
| Bahía Azul Auto Detailing (Miami) | Spanish, English | America/New_York, $ | Detallado completo $30 off on Wednesdays: $145 instead of $175 |
| Clinique Physio Érable (Montreal) | French, English | America/Toronto, $ CA | Massage thérapeutique 15% off on Tuesdays: 85 $ CA instead of 100 $ CA |

1. **Customer panel: `/owner`, right column.** `Do you have Tuesday 10:00 for a cut plus beard?` quotes the Tuesday price computed by code; `Book it, I'm Dana 000-0000` creates a PENDING booking and an owner approval. Try Hebrew, Spanish or French on the matching business. Open "Tool trace" under a reply for each tool call and the verifier's verdict.
2. **Booking approval: `/owner`, "Pending approvals".** Approve (the booking becomes CONFIRMED and the customer gets a confirmation in their language) or Reject.
3. **Content: `/owner`, "Content".** Choose `fixtures/demo/beard-oil.jpg` (drawn from shapes by `scripts/make-sample-photo.ts`, not a real photo), pick an offer, type one simple word for the object to cut out (`bottle`), Generate (three model calls). If SAM finds nothing, you are told so and nothing is generated.
4. **Onboarding: `/onboard`** (optional; the seeded brains are approved). Type or record how the business works, review the draft, approve.

Locally `/owner` and `/onboard` need no login. Hosted, they return 404 unless you open `/owner?token=<OWNER_ACCESS_TOKEN>` once (an httpOnly cookie) or send the token in the Authorization header.

## The verifier is bounded

Before any reply or booking request leaves, deterministic code checks it against the approved brain and the latest tool results: prices and discounts (and the day they apply), durations, times (opening boundaries or offered slots), booking claims ("confirmed" before the owner approved, in four languages, with negations), promises to check later, and, for health businesses, diagnostic or treatment advice. A block is fed back to the model once; a second block hands the conversation to the owner.

It is pattern-based, not a proof. It catches what it can tie to the brain; phrasings outside its patterns pass, and it has false positives: in the recorded golden run it blocks a reply that repeats a customer's "12:45" because 12:45 is neither an opening boundary nor a slot (the model then corrects itself).

## Spend safety

- Every model call goes through one gateway (`src/lib/gateway/`) that reserves the worst-case cost in the durable ledger before dispatch and settles the real cost after. One file (`meta-dispatcher.ts`) talks to the Meta API; a test fails if any other source file does.
- `MODEL_SPEND_HARD_CAP_USD` is required and can never exceed $130. `LIVE_CREDITS_VERIFIED` is a human switch; until it is `true` no request reaches Meta and customer messages go to the owner.
- Measured in the recorded golden run: $0.0013 to $0.0040 per model call, $0.0017 to $0.0093 per customer turn (n=8 calls, 4 turns); a content post about $0.016 to $0.019 (3 calls).

## Meta models used

| Model | Where | What for |
|---|---|---|
| `muse-spark-1.3` | `src/lib/engine/conversation-service.ts`, `onboarding.ts`, `src/lib/content/caption.ts` | Customer conversation with tool calls, brain extraction from the owner's words, post captions |
| `muse-voice-transcribe-1.0` | `src/lib/engine/onboarding.ts` | Voice onboarding (language bias from the business's languages) |
| `sam-3.1` | `src/lib/content/creative.ts` (parsing in `segment.ts`) | Cuts the product out of the owner's photo (mask decoded with Meta's `@meta-sam/parser`) |
| `muse-image-1.0` | `src/lib/content/creative.ts` | Background scene, no text in the image. The output is kept byte-identical with its response headers; it carries IPTC `trainedAlgorithmicMedia`, and the exports say `compositeWithTrainedAlgorithmicMedia` (they add the owner's photo and printed text). Each creative's `manifest.json` records what Meta returned and what was preserved. |

No other model provider is used anywhere in the product.

## WhatsApp (optional, live path)

The hosted deploy answers a WhatsApp Cloud API test number through the same engine (`src/app/api/whatsapp/webhook/route.ts`, signature-checked, deduplicated). It needs a Meta app, a WhatsApp Business Account with a registered number, a token with `whatsapp_business_messaging` and `whatsapp_business_management` on that WABA, the app subscribed to the WABA, and `WHATSAPP_*` plus `META_APP_SECRET` set. Nothing in the demo or the web app needs it.

## Built during the hackathon vs pre-existing

Built Oct 27 to Nov 4, 2026: all code in this repository (engine, tools, verifier, gateway and ledger, storage, WhatsApp webhook, onboarding, content engine, owner screen, demo and replay, tests). Before that there were only planning documents. Dated log: [PROVENANCE.md](PROVENANCE.md).

Pre-existing dependencies, used as published: Next.js, React, `@supabase/supabase-js`, `better-sqlite3`, `sharp`, Meta's `@meta-sam/parser`, `opentype.js`, Tailwind, Vitest, tsx. Fonts: Inter and Heebo under the SIL Open Font License (`assets/fonts/OFL-*.txt`), bundled so composites render the same on every host.

## Known limits

- **Slot lock is on start time only.** Two bookings with the same start are impossible (unique index), but overlapping durations (a 30-minute and a 50-minute service 15 minutes apart) are only prevented by the availability check just before the request, not by the store.
- **No approved WhatsApp template.** A confirmation sent after the customer's 24-hour window is queued, shown to the owner, and sent when the customer writes again; it is not sent as a template.
- **Approval is not bound to a brain version.** A booking made under one brain version can be approved after a newer version is approved; the price is fixed on the booking when it is requested.
- **A failed inbound WhatsApp message is retried only on redelivery.** Its claim is released if nothing was recorded, but Meta does not redeliver after the webhook's 200, so in practice the customer must write again.
- **The verifier is pattern-based** (see above).
- **Right-to-left text on composites** uses a minimal bidi pass, enough for one-line labels.

## Tests

```bash
npm test          # vitest, no network (includes the golden REPLAY)
npm run typecheck
```
