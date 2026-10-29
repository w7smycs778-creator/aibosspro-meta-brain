// Caption: Spark writes it from the offer facts; the existing verifier plus
// offer checks decide whether it is used. One correction, then an empty
// caption for the owner to write.
import { ENGINE_REASONING_EFFORT, type EngineDeps } from "../engine/deps";
import type { ChatMessage } from "../gateway/types";
import { verifyText, type Check } from "../engine/verifier";
import type { BusinessBrain } from "../storage/types";
import type { Offer } from "./offers";

/** Spark counts reasoning inside this budget; 512 ran out on reasoning live on 2026-10-29. */
export const CAPTION_MAX_OUTPUT_TOKENS = 2_048;
const MAX_SENTENCES = 3; // two sentences plus one call to action

export type CaptionLog = {
  attempts: Array<{ text: string; pass: boolean; checks: Check[] }>;
  final: "verified" | "empty";
};

function escape(re: string): string {
  return re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The verifier's checks (prices, discounts and their day conditions, times,
 * protocol leaks) plus: every price is this offer's price or its list price,
 * every percent is this offer's, no other service is named, at most two
 * sentences and a call to action.
 */
export function verifyCaption(text: string, brain: BusinessBrain, offer: Offer): { pass: boolean; checks: Check[] } {
  const base = verifyText(text, { brain, availability: null, bookings: [] });
  const checks: Check[] = [...base.checks];
  const allowed = new Set([offer.offerPriceCents, offer.listPriceCents]);
  for (const m of text.matchAll(/([$₪€£])\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(?:USD|dollars?|ILS|NIS|shekels?|₪|€|£)(?![\p{L}\d])/giu)) {
    const cents = Math.round(Number((m[2] ?? m[3]).replace(",", ".")) * 100);
    const ok = allowed.has(cents);
    checks.push({ rule: "offer", claim: m[0], pass: ok, ...(!ok && { detail: `only ${offer.priceText}${offer.kind === "discount" ? ` or ${offer.listPriceText}` : ""} belongs to this offer` }) });
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)) {
    const ok = offer.percentOff !== null && Number(m[1]) === offer.percentOff;
    checks.push({ rule: "offer", claim: m[0], pass: ok, ...(!ok && { detail: "not this offer's discount" }) });
  }
  for (const s of brain.services) {
    if (s.id === offer.serviceId) continue;
    if (new RegExp(`\\b${escape(s.name)}\\b`, "i").test(text)) {
      checks.push({ rule: "offer", claim: s.name, pass: false, detail: `names ${s.name}; the offer is ${offer.serviceName}` });
    }
  }
  const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
  if (sentences > MAX_SENTENCES) checks.push({ rule: "length", claim: `${sentences} sentences`, pass: false, detail: "at most two sentences and one call to action" });
  return { pass: checks.every((c) => c.pass), checks };
}

function captionPrompt(brain: BusinessBrain, offer: Offer): string {
  return [
    `Write an Instagram caption for ${brain.name}.`,
    `Tone: ${brain.tone.adjectives.join(", ") || "friendly"}.${brain.tone.example ? ` Example of the voice: "${brain.tone.example}"` : ""}`,
    `The post promotes exactly one offer: ${offer.serviceName}, ${offer.durationMin} min, price ${offer.priceText}${offer.kind === "discount" ? ` (normally ${offer.listPriceText})` : ""}${offer.condition ? `, only on ${offer.condition}` : ""}.`,
    offer.condition ? `If you mention the price ${offer.priceText}, say in the same sentence that it is for ${offer.condition}.` : "",
    "At most two short sentences, then one call to action. Use only these facts; no other services, prices or discounts. No hashtags. Plain text only.",
    ...(brain.doNotSay.length ? [`Never say: ${brain.doNotSay.join("; ")}.`] : []),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function writeCaption(deps: EngineDeps, brain: BusinessBrain, offer: Offer, businessId: string): Promise<{ caption: string; log: CaptionLog }> {
  const log: CaptionLog = { attempts: [], final: "empty" };
  if (!deps.gateway) return { caption: "", log };
  const messages: ChatMessage[] = [
    { role: "system", content: captionPrompt(brain, offer) },
    { role: "user", content: "Write the caption." },
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await deps.gateway.call({
      kind: "chat",
      model: deps.model,
      maxOutputTokens: CAPTION_MAX_OUTPUT_TOKENS,
      reasoningEffort: ENGINE_REASONING_EFFORT,
      messages,
      businessId,
    });
    if (r.outcome !== "ok") {
      log.attempts.push({ text: "", pass: false, checks: [{ rule: "length", claim: "no caption", pass: false, detail: r.outcome === "denied" ? `${r.reason}: ${r.detail}` : `model call failed (status ${r.status})` }] });
      break;
    }
    if (!r.output?.trim()) {
      // An empty reply counts as a failed attempt; the second attempt asks again.
      log.attempts.push({ text: "", pass: false, checks: [{ rule: "length", claim: "empty caption", pass: false, detail: `empty reply (finish_reason ${r.finishReason ?? "unknown"})` }] });
      messages.push({ role: "user", content: "Write the caption now, as plain text." });
      continue;
    }
    const text = r.output.trim().replace(/^"|"$/g, "");
    const verdict = verifyCaption(text, brain, offer);
    log.attempts.push({ text, ...verdict });
    if (verdict.pass) {
      log.final = "verified";
      return { caption: text, log };
    }
    const failed = verdict.checks.filter((c) => !c.pass).map((c) => `${c.claim} (${c.detail ?? c.rule})`).join("; ");
    messages.push(
      { role: "assistant", content: text },
      { role: "user", content: `That caption was blocked by the fact check: ${failed}. Write it again using only the offer facts.` },
    );
  }
  return { caption: "", log };
}
