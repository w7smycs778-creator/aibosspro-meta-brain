# AIBOSSPRO Meta Brain

An AI front desk for a small service business, built on Meta's models. The owner describes the business once, by voice or text; Muse Spark turns that into a structured "brain" (services, prices, hours, discount rules, tone, languages) that the owner reviews and approves. Customers then chat with an assistant (customer panel or WhatsApp Cloud API) that answers in their language (English or Hebrew), checks real availability, quotes prices computed by code, and requests bookings that only the owner can approve. Every reply passes a deterministic verifier before it is sent, so a wrong price, a discount on the wrong day, or a "your booking is confirmed" before the owner approved it is blocked. The same brain drives a content engine: SAM 3.1 cuts the product out of a photo, Muse Image paints a scene, code composites the offer and price, Spark writes a verified caption, and the owner approves the post.

Every AI reply is labelled as AI. Nothing is booked or published without the owner's approval. Owner switches per conversation: AUTO, HUMAN, PAUSED.

## Prerequisites

- Node 20 or newer (`node -v`; the repo pins 20 in `.nvmrc`).
- For live model calls: a Meta Model API key with credit. Without one, the app still runs and shows exactly why inference is off.
- macOS or Linux shell (the start script is bash).
- Clone somewhere outside `/tmp`: the spend ledger in a temp directory counts as not durable, so live calls (and the tests that exercise the durable ledger) are refused there.

## Start locally (one command)

```bash
git clone https://github.com/w7smycs778-creator/aibosspro-meta-brain.git meta-brain && cd meta-brain
npm run judge
```

`npm run judge` checks Node, creates `.env` from `.env.example` if there is none, runs `npm ci`, seeds the demo business **Cedar Street Barbers** into `./data` (SQLite) if no local database exists yet, and starts the app on http://localhost:3000. Stop it with Ctrl+C; run it again to restart with the same data. Start over clean with `npm run demo:reset -- --yes` (keeps the spend ledger, backs the database up first).

To turn on live inference, edit `.env` before (or after, then restart):

```bash
# your Meta Model API key, pasted after the = sign
MODEL_API_KEY=<key>
MODEL_CREDIT_BALANCE_USD=<credit left in Billing, e.g. 150>
MODEL_SPEND_HARD_CAP_USD=5
LIVE_CREDITS_VERIFIED=true
```

## What to click

The demo business: Cedar Street Barbers, Asia/Jerusalem, prices in ₪. Classic cut ₪80, Skin fade ₪90, Beard trim ₪50, Cut plus beard ₪120, and Cut plus beard is 15% off on Tuesdays (₪102). English and Hebrew.

1. **Onboarding, text path: http://localhost:3000/onboard** (optional; the seeded brain is already approved). Under "3. Or type the rules" paste, for example:
   > We're Cedar Street Barbers in Jerusalem. Classic cut 80 shekels, 30 minutes. Skin fade 90, 40 minutes. Beard trim 50, 20 minutes. Cut plus beard 120, 50 minutes. Tuesdays cut plus beard is 15% off. Open Sunday to Thursday 9 to 7, Friday 8 to 1, closed Saturday. We speak English and Hebrew. Warm, short, relaxed.

   Click **Build draft** (one Muse Spark call). Review the draft beside the source text, edit any field, then **Approve brain**. Only approved versions reach the assistant. ("1. Record" and "2. Or upload an audio file" are the voice path through Muse Voice Transcribe.)
2. **Customer panel: http://localhost:3000/owner**, right column. Type as the customer:
   - `What do you offer?`
   - `Do you have Tuesday 10:00 for a cut plus beard?` The reply quotes the Tuesday price computed by code, e.g. "Tuesday 10:00 is open, Cut plus beard is ₪102 on Tuesday, normally ₪120."
   - `Book it, I'm Dana 050-0000000` creates a PENDING booking and an owner approval.
   - Try Hebrew: `מה אתם מציעים?` then `יש לכם ביום שלישי ב-10:00 תספורת וזקן?`
   - Try to break it: `Can you give me 50% off?` Open "Tool trace" under any reply to see each tool call and the verifier's verdict (BLOCK, then the corrected reply).
3. **Booking approval: /owner, left column, "Pending approvals".** Click **Approve** (the booking becomes CONFIRMED and the customer gets a confirmation in their language) or **Reject**. The conversation list has the AUTO / HUMAN / PAUSED switches and "Send as owner" (takes the conversation over).
4. **Content: /owner, "Content" section.** Choose the bundled synthetic photo `fixtures/demo/beard-oil.jpg` (an amber beard-oil bottle, rendered from shapes by `scripts/make-sample-photo.ts`; not a real photo), pick an offer (e.g. the Tuesday Cut plus beard offer), type `bottle` as the object to cut out, click **Generate** (three model calls: SAM 3.1, Muse Image, Muse Spark). Review the feed and story images and the verified caption, then **Approve** or **Reject**.

`/owner` and `/onboard` run locally only; on the hosted deploy they return 404 because the owner screen has no login yet.

## Spend safety

- Every model call goes through one gateway (`src/lib/gateway/`) that reserves the worst-case cost in a durable ledger (SQLite in `./data`, or Postgres when hosted) before dispatch and settles the real cost after. One file (`meta-dispatcher.ts`) talks to the Meta API; a test fails if any other file does.
- `MODEL_SPEND_HARD_CAP_USD` is **required**: the server refuses to start without it, and it can never exceed $130. Once total ledger spend would pass the cap, calls are refused. `MODEL_CREDIT_BALANCE_USD` must be set too (an unknown balance fails closed; a $20 buffer is kept below it).
- `LIVE_CREDITS_VERIFIED` is a human switch: set it to `true` only after you have confirmed the key has credit in Meta Model API Billing. Code never sets it. Until it is `true`, no request reaches Meta: `/owner` shows "Live inference is off: LIVE_CREDITS_VERIFIED is not 'true'; the Meta dispatcher is blocked", and customer messages are handed to the owner instead of answered.
- A hosted deploy (Vercel) additionally requires `STORAGE_BACKEND=supabase` and a reachable ledger table. A local ledger in a temp directory is not durable and is refused for live calls.
- Rough cost seen in testing: a customer reply about $0.001 to $0.004; a content post about $0.015.

## Meta models used

| Model | Where | What for |
|---|---|---|
| `muse-spark-1.3` (Meta Model API) | `src/lib/engine/conversation-service.ts`, `src/lib/engine/onboarding.ts`, `src/lib/content/caption.ts` | Customer conversation with tool calls (services, hours, availability, booking request, owner hand-off), brain extraction from the owner's words (JSON schema), post captions |
| `muse-voice-transcribe-1.0` | `src/lib/engine/onboarding.ts` | Voice onboarding: the owner's voice note (Hebrew/English) to text |
| `sam-3.1` | `src/lib/content/creative.ts` (parsing in `segment.ts`) | Cuts the product out of the owner's photo (mask decoded with Meta's `@meta-sam/parser`) |
| `muse-image-1.0` | `src/lib/content/creative.ts` | Background scene for the post, no text in the image |

No other model provider is used anywhere in the product.

## Built during the hackathon

Everything in this repository was built during the hackathon (Oct 27 to Nov 4, 2026); before that there were only planning documents and no code. Dated log: [PROVENANCE.md](PROVENANCE.md).

## Tests

```bash
npm test          # vitest, mock model client, no network
npm run typecheck
```
