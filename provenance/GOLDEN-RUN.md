# Golden run

Anchored to commit `0f4cc61` (recorded 2026-11-01T13:23:39.400Z). Model `muse-spark-1.3`, tool mode `native`, fixed clock 2026-10-29T12:00:00.000Z (Thursday). Local store `./data/demo/meta-brain.sqlite`.

Raw records: LIVE trace [`provenance/traces/2026-11-01T13-23-24-497Z.jsonl`](traces/2026-11-01T13-23-24-497Z.jsonl), REPLAY trace [`provenance/traces/2026-11-01T13-23-50-016Z.jsonl`](traces/2026-11-01T13-23-50-016Z.jsonl), recorded request/response pairs [`fixtures/replay/golden.json`](../fixtures/replay/golden.json) (exchange `seq` = the # below; request bodies as sent, without request headers; response bodies and headers as received, cookies dropped).

The scenario is fictional: Cedar Street Barbers and Clinique Physio Érable are invented demo businesses; Dana and 000-0000 are made up. Every reply below was produced by the model live and is replayed, not rewritten.

## Steps

| Step | Input | API request (seq, endpoint, model, provider request id, latency) | Raw response | Tool result | Verifier verdict | Ledger (reservation → settlement, tokens) | Booking state | Video |
|---|---|---|---|---|---|---|---|---|
| 1 | Hi! Do you have time for a cut plus beard next Tuesday at 10:00? | #1 `/v1/chat/completions` muse-spark-1.3, req id `29cbe1f8-470d-4400-a98a-e5566c6347d9`, 1501 ms | tool call: check_availability({"date":"2026-11-03","service":"cut_plus_beard"}) (finish tool_calls) | ok: {"date":"2026-11-03","weekday":"tue","service":{"id":"cut_plus_beard","name":"Cut plus be… | PASS check_availability | reserved $0.015631, settled $0.001334; in 1641, out 225 (reasoning 128) | – | TBD |
|  |  | #2 `/v1/chat/completions` muse-spark-1.3, req id `06fbeca7-53de-4eb5-a7a0-dd6654524510`, 2585 ms | text: Yes - Tuesday 10:00 is open, Cut plus beard is ₪102 on Tuesday, normally ₪120. Want me to request it? Just sh… (finish stop) | – | PASS final | reserved $0.018624, settled $0.002878; in 2682, out 282 (reasoning 235) | none | TBD |
| 2 | Great, please book it. My name is Dana, phone 000-0000. | #3 `/v1/chat/completions` muse-spark-1.3, req id `a4703ff7-050c-4497-9781-26387ed29c7b`, 1385 ms | tool call: request_booking({"customer_contact":"000-0000","customer_name":"Dana","service":"cut_plus_beard","slot":"2026… (finish tool_calls) | ok: {"bookingId":"625a6e29-cfac-45e1-9cef-2795b16b5f34","approvalId":"fd36a71d-0de1-4790-a6a5… | PASS request_booking | reserved $0.018525, settled $0.003313; in 2595, out 178 (reasoning 50) | – | TBD |
|  |  | #4 `/v1/chat/completions` muse-spark-1.3, req id `34f430d2-e178-4ea9-89de-e0c2b5610769`, 1705 ms | text: Done - I've requested Tuesday 10:00 for Cut plus beard for Dana. It's pending approval from the owner, I'll l… (finish stop) | – | PASS final | reserved $0.019334, settled $0.001586; in 2886, out 183 (reasoning 144) | pending_approval cut_plus_beard 2026-11-03T08:00:00.000Z 10200 ILS | TBD |
| 3 | owner taps Approve (fd36a71d-0d…) | no model call | – | decideBooking | – | – | confirmed 10200 ILS | TBD |
| | reply to customer | | | | | | Good news: your Cut plus beard on Tue, Nov 3, 10:00 IST is confirmed. See you then. | |
| 4 | כמה עולה תספורת וזקן ביום שלישי? | #5 `/v1/chat/completions` muse-spark-1.3, req id `f67e87ca-c1b7-4dd2-9706-fc572ca826be`, 2069 ms | text: ביום שלישי תספורת וזקן ב-₪102, בדרך כלל ₪120. בוא תשב אצלנו - נסדר אותך. (finish stop) | – | PASS final | reserved $0.015624, settled $0.001719; in 1639, out 316 (reasoning 268) | confirmed cut_plus_beard 2026-11-03T08:00:00.000Z 10200 ILS | TBD |
| 5 | Can I walk in at 12:45 this Friday for a beard trim? Please confirm 1… | #6 `/v1/chat/completions` muse-spark-1.3, req id `32e3cc06-a2d0-469a-98bc-1ce8454064ce`, 1635 ms | tool call: check_availability({"date":"2026-10-30","service":"beard_trim"}) (finish tool_calls) | ok: {"date":"2026-10-30","weekday":"fri","service":{"id":"beard_trim","name":"Beard trim","du… | PASS check_availability | reserved $0.015651, settled $0.003137; in 1646, out 254 (reasoning 161) | – | TBD |
|  |  | #7 `/v1/chat/completions` muse-spark-1.3, req id `41722de4-9077-4c2f-b657-b7473a855e01`, 1160 ms | text: 12:45 isn't open — we close at 13:00 on Friday. Friday 12:30 is open, Beard trim is ₪50. Want me to request 1… (finish stop) | – | **BLOCK** final: time: 12:45 | reserved $0.017453, settled $0.002110; in 2286, out 251 (reasoning 177) | – | TBD |
|  |  | #8 `/v1/chat/completions` muse-spark-1.3, req id `44a58909-b664-4542-9c27-a94a8666680a`, 2712 ms | text: Sorry, that one isn't open — we close Friday at 13:00. Friday 12:30 is open, Beard trim is ₪50. Want me to re… (finish stop) | – | PASS final | reserved $0.018027, settled $0.004049; in 2421, out 800 (reasoning 751) | confirmed cut_plus_beard 2026-11-03T08:00:00.000Z 10200 ILS | TBD |

The block in step 5: the customer named 12:45, which is neither an opening boundary nor a slot from check_availability, so the time rule blocked the first reply that repeated it; the model corrected once and the second reply passed. This is a known false positive of a bounded verifier: it allows only times, prices, durations and percentages it can tie to the brain or the latest tool result.

## Measured (LIVE, this run)

- Model calls: 8 (all `muse-spark-1.3`, all HTTP 200). Latency per call, measured at the HTTP client: min 1160 ms, median 1670 ms, max 2712 ms (n=8).
- Cost per call (ledger settlement): min $0.001334, max $0.004049 (n=8). Cost per customer turn: $0.004212, $0.004899, $0.001719, $0.009296 (n=4). Run total $0.020126 over 8 ledger rows (run `demo-live-2026-11-01T13-23-24-497Z`).
- The owner approval and the reply it sends make no model call.
- REPLAY latency is not a model measurement (answers come from the file) and is not reported.

## Invariants

| Invariant | LIVE (0f4cc61) | REPLAY (0f4cc61) |
|---|---|---|
| slot held (booking pending owner approval) | PASS (625a6e29 2026-11-03T08:00:00.000Z) | PASS (7c839045 2026-11-03T08:00:00.000Z) |
| price equals the code-computed price | PASS (booking 10200 vs priceOn 10200 (ILS)) | PASS (booking 10200 vs priceOn 10200 (ILS)) |
| owner approval confirms the booking | PASS (booking confirmed) | PASS (booking confirmed) |
| Hebrew reply from the model (final, verified) | PASS (final) | PASS (final) |
| verifier blocked at least one reply | PASS (step 5: time: 12:45) | PASS (step 5: time: 12:45) |
| every final reply has a verifier verdict | PASS (step 1: 1, step 2: 1, step 4: 1, step 5: 2) | PASS (step 1: 1, step 2: 1, step 4: 1, step 5: 2) |
| replay used every recorded call | – | PASS (0 left) |

## Reproduce

- Offline, exactly this run: `npm run demo -- --replay` (no API key needed; any request that differs from the recording stops the run).
- Live, with a changed input: `npm run demo -- --golden --time 11:00` (needs a model API key; capped by DEMO_CAP_USD, default $0.30). It asserts the invariants above, not the wording: the slot is held pending approval, the booked price equals `priceOn` (code-computed), owner approval confirms it, the Hebrew reply is a verified model reply, every final reply has a verifier verdict, and the verifier blocks at least one reply.

## Image and audio outputs

None in this scenario. The hosted content run of 2026-11-01 (creative `f6066875`, Supabase bucket `creative-media`, not in the repo) kept the Muse Image output byte-identical with its response headers and `x-request-id`; its manifest is described in PROVENANCE.md. The Spanish/French Voice Transcribe check is in PROVENANCE.md (local research notes are not committed).

## Earlier LIVE recordings of this scenario (kept, not used)

- [`provenance/traces/2026-11-01T13-19-02-485Z.jsonl`](traces/2026-11-01T13-19-02-485Z.jsonl) at f0858ff: FAIL verifier blocked at least one reply: no block in 3 attempts; $0.027461
- [`provenance/traces/2026-11-01T13-19-34-513Z.jsonl`](traces/2026-11-01T13-19-34-513Z.jsonl) at f0858ff: FAIL verifier blocked at least one reply: no block in 4 attempts; $0.029459
- [`provenance/traces/2026-11-01T13-20-22-414Z.jsonl`](traces/2026-11-01T13-20-22-414Z.jsonl) at f0858ff: all invariants passed; $0.026905
