// Renders the approved brain into the system prompt, so the model answers
// questions about services, prices, hours and discounts without a tool call.
import { discountedCents, rulesFor } from "./discounts";
import { brainLangs, langCode, langName, type Lang } from "./i18n";
import type { BusinessBrain, Weekday } from "../storage/types";

const SYMBOLS: Record<string, string> = { USD: "$", ILS: "₪", EUR: "€", GBP: "£" };
/** Currencies written after the amount, as their customers write them. */
const SUFFIXES: Record<string, string> = { CAD: " $ CA" };
const DAY_NAMES: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_ORDER: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** "he" -> "Hebrew"; unsupported names pass through. */
export function languageName(lang: string): string {
  const code = langCode(lang);
  return code ? langName(code) : lang.trim();
}

function localNamesText(names: Record<string, string> | undefined): string {
  const entries = Object.entries(names ?? {});
  return entries.length ? ` (${entries.map(([lang, n]) => `${languageName(lang)}: ${n}`).join("; ")})` : "";
}

export function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2).replace(/\.00$/, "");
  const code = currency.toUpperCase();
  if (SUFFIXES[code]) return `${amount}${SUFFIXES[code]}`;
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`;
}

/** How to write prices, times and days in each language, so the verifier can read them. */
const CONVENTIONS: Record<Lang, string> = {
  en: "In English: times as HH:MM (10:00), days as Monday, Tuesday...",
  he: "In Hebrew: write prices with digits as listed, times as HH:MM (10:00), and days as יום ראשון/שני/שלישי/רביעי/חמישי/שישי or שבת.",
  es: "In Spanish: write prices with digits as listed, times as HH:MM (10:00), and days as lunes, martes, miércoles, jueves, viernes, sábado, domingo.",
  fr: "In French: write prices with digits as listed, times as HH:MM (10:00), and days as lundi, mardi, mercredi, jeudi, vendredi, samedi, dimanche.",
};

export function brainFacts(brain: BusinessBrain, version: number): string {
  const name = (id: string) => brain.services.find((s) => s.id === id)?.name ?? id;
  const langs = brainLangs(brain);
  const lines = [
    `Business facts (owner-approved, brain v${version}). Answer questions about services, prices, durations, discounts and opening hours from these directly; list_services returns the same facts, so there is no need to call it for them.`,
    "Services:",
    ...brain.services.map((s) => `- ${s.name}${localNamesText(s.localNames)}: ${formatMoney(s.priceCents, s.currency || brain.currency)}, ${s.durationMin} min (id ${s.id})`),
    `Opening hours (${brain.timezone}):`,
    ...DAY_ORDER.map((d) => `- ${DAY_NAMES[d]}: ${brain.hours[d].length ? brain.hours[d].map(([o, c]) => `${o}-${c}`).join(", ") : "closed"}`),
    "Discounts:",
    ...(brain.discounts.length
      ? brain.discounts.map((d) => {
          const off = d.percentOff !== null ? `${d.percentOff}% off` : `${formatMoney(d.amountOffCents ?? 0, brain.currency)} off`;
          const services = d.serviceIds.length ? d.serviceIds.map(name).join(", ") : "all services";
          const days = d.weekdays.length ? ` on ${d.weekdays.map((w) => DAY_NAMES[w]).join(", ")}` : "";
          // The discounted price per covered service, computed here so the model never does the arithmetic.
          const covered = brain.services.filter((s) => rulesFor(brain, s.id).includes(d));
          const prices = covered
            .map((s) => `${s.name} ${formatMoney(discountedCents(s, d), s.currency || brain.currency)} instead of ${formatMoney(s.priceCents, s.currency || brain.currency)}`)
            .join(", ");
          return `- ${d.description} (${off} ${services}${days}${d.conditions ? `; ${d.conditions}` : ""}; price then: ${prices})`;
        })
      : ["- none; offer no discount"]),
    "Booking policy: every booking needs the owner's approval.",
    `Languages: ${langs.map(langName).join(", ")}. Reply in the language of the customer's latest message when it is one of these (switch when the customer switches), otherwise in ${langName(langs[0])}.`,
    "Use each service's name exactly as listed for the reply's language (the name in brackets for that language, else the listed name). Copy prices exactly as listed; never convert or translate them.",
    ...langs.map((l) => CONVENTIONS[l]),
    ...(brain.tone.adjectives.length ? [`Tone: ${brain.tone.adjectives.join(", ")}.${brain.tone.example ? ` Example: "${brain.tone.example}"` : ""}`] : []),
    ...(brain.doNotSay.length ? [`Never say: ${brain.doNotSay.join("; ")}.`] : []),
  ];
  return lines.join("\n");
}
