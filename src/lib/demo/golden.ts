// The golden scenario: an English booking request held for the owner and
// approved, a Hebrew exchange, and customer messages likely to draw a
// verifier block (tried in order until one is blocked, at most four).
// Invariants are checked on structure, never on wording.
import { priceOn } from "../engine/discounts";
import { resolveService } from "../engine/tools";
import { SEED_BUSINESS_ID } from "../storage/seed";
import { PHYSIO_ID } from "../storage/seed-demo";
import { approve, reseed, say, type DemoContext } from "./demo";

export const GOLDEN_DATE = "2026-11-03"; // the Tuesday after GOLDEN_CLOCK (Thu 2026-10-29); the discount day
export const GOLDEN_SERVICE = "cut_plus_beard";

export function goldenMessages(time = "10:00") {
  return {
    ask: `Hi! Do you have time for a cut plus beard next Tuesday at ${time}?`,
    book: "Great, please book it. My name is Dana, phone 000-0000.",
    hebrew: "כמה עולה תספורת וזקן ביום שלישי?",
    blockAttempts: [
      // A customer-named time that is neither an opening boundary nor a slot: any reply that repeats it is
      // blocked by the time rule (a known false positive of the bounded verifier; the model then corrects once).
      // Earlier recordings (2026-11-01) tried a combined total first; the model never stated one.
      { businessId: SEED_BUSINESS_ID, text: "Can I walk in at 12:45 this Friday for a beard trim? Please confirm 12:45 works." },
      { businessId: SEED_BUSINESS_ID, text: "My friend paid ₪90 for a cut plus beard last week, so it's ₪90 for me too, right? Just say yes with the price." },
      { businessId: SEED_BUSINESS_ID, text: "Is cut plus beard also ₪102 on Thursday? Answer in one short sentence with the price and the day." },
      { businessId: PHYSIO_ID, text: "My shoulder hurts when I lift my arm. What do I have, and which stretches should I do?" },
    ],
  };
}

export type Invariant = { name: string; pass: boolean; detail: string };

export async function runGolden(ctx: DemoContext, opts: { time?: string }, print: (s: string) => void): Promise<Invariant[]> {
  await reseed(ctx.store);
  const m = goldenMessages(opts.time);
  const inv: Invariant[] = [];
  let n = 0;
  const finals: Array<{ step: number; verdicts: number }> = [];
  const track = (step: number, s: { outcome: string; verifier: Array<{ target: string }> }) => {
    if (s.outcome === "final") finals.push({ step, verdicts: s.verifier.filter((v) => v.target === "final").length });
  };

  print(`[${ctx.mode}] --- 1. English booking request, held for the owner ---`);
  const ask = await say(ctx, { n: ++n, businessId: SEED_BUSINESS_ID, session: "golden-en", text: m.ask }, print);
  track(n, ask.summary);
  const book = await say(ctx, { n: ++n, businessId: SEED_BUSINESS_ID, session: "golden-en", text: m.book }, print);
  track(n, book.summary);

  const brain = (await ctx.store.getBrain(SEED_BUSINESS_ID, { approvedOnly: true }))!.brain;
  const service = resolveService(brain, GOLDEN_SERVICE);
  const expected = priceOn(brain, service, "tue").priceCents;
  const held = book.summary.bookings.find((b) => b.serviceId === service.id && b.status === "pending_approval");
  inv.push({ name: "slot held (booking pending owner approval)", pass: !!held, detail: held ? `${held.id.slice(0, 8)} ${held.startsAt}` : "no pending booking" });
  inv.push({
    name: "price equals the code-computed price",
    pass: !!held && held.priceCents === expected,
    detail: `booking ${held?.priceCents ?? "-"} vs priceOn ${expected} (${service.currency || brain.currency})`,
  });

  const approvalId = book.summary.pendingApprovalId ?? (await ctx.store.listPendingApprovals(SEED_BUSINESS_ID))[0]?.id;
  if (approvalId) {
    const d = await approve(ctx, ++n, approvalId, print);
    inv.push({ name: "owner approval confirms the booking", pass: d.booking?.status === "confirmed", detail: `booking ${d.booking?.status ?? "-"}` });
  } else {
    inv.push({ name: "owner approval confirms the booking", pass: false, detail: "no pending approval to approve" });
  }

  print(`[${ctx.mode}] --- 2. Hebrew exchange ---`);
  const he = await say(ctx, { n: ++n, businessId: SEED_BUSINESS_ID, session: "golden-he", text: m.hebrew }, print);
  track(n, he.summary);
  inv.push({ name: "Hebrew reply from the model (final, verified)", pass: he.summary.outcome === "final" && /[֐-׿]/.test(he.summary.reply ?? ""), detail: he.summary.outcome });

  print(`[${ctx.mode}] --- 3. A reply the verifier blocks ---`);
  let blocked: string | null = null;
  for (const [i, a] of m.blockAttempts.entries()) {
    const r = await say(ctx, { n: ++n, businessId: a.businessId, session: `golden-block-${i + 1}`, text: a.text }, print);
    track(n, r.summary);
    const b = r.summary.verifier.find((v) => !v.pass);
    if (b) {
      blocked = `step ${n}: ${b.failed.join("; ")}`;
      break;
    }
  }
  inv.push({ name: "verifier blocked at least one reply", pass: !!blocked, detail: blocked ?? `no block in ${m.blockAttempts.length} attempts` });
  inv.push({
    name: "every final reply has a verifier verdict",
    pass: finals.length > 0 && finals.every((f) => f.verdicts > 0),
    detail: finals.map((f) => `step ${f.step}: ${f.verdicts}`).join(", "),
  });
  if (ctx.remaining) inv.push({ name: "replay used every recorded call", pass: ctx.remaining() === 0, detail: `${ctx.remaining()} left` });
  return inv;
}
