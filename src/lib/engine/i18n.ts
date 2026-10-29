// The strings the code itself inserts into customer messages (AI disclosure,
// owner hand-off notice, owner decision replies, price quotes, dates), in the
// four supported languages, and a small language detector. Prices and service
// names always come from the brain; the model never translates them.
import type { BusinessBrain, Service, Weekday } from "../storage/types";

export type Lang = "en" | "he" | "es" | "fr";
export const SUPPORTED_LANGS: readonly Lang[] = ["en", "he", "es", "fr"];

const NAMES: Record<Lang, string> = { en: "English", he: "Hebrew", es: "Spanish", fr: "French" };
const ALIASES: Record<string, Lang> = {
  en: "en", english: "en",
  he: "he", iw: "he", hebrew: "he", "עברית": "he",
  es: "es", spanish: "es", "español": "es", espanol: "es",
  fr: "fr", french: "fr", "français": "fr", francais: "fr",
};

/** "Spanish", "es", "español" -> "es"; null when not a supported language. */
export function langCode(lang: string): Lang | null {
  return ALIASES[lang.trim().toLowerCase()] ?? null;
}

export function langName(lang: Lang): string {
  return NAMES[lang];
}

/** The brain's languages that are supported, in its order; English when none is. */
export function brainLangs(brain: BusinessBrain): Lang[] {
  const out = [...new Set(brain.languages.map(langCode).filter((l): l is Lang => l !== null))];
  return out.length ? out : ["en"];
}

const DAYS: Record<Lang, Record<Weekday, string>> = {
  en: { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" },
  he: { sun: "יום ראשון", mon: "יום שני", tue: "יום שלישי", wed: "יום רביעי", thu: "יום חמישי", fri: "יום שישי", sat: "שבת" },
  es: { sun: "domingo", mon: "lunes", tue: "martes", wed: "miércoles", thu: "jueves", fri: "viernes", sat: "sábado" },
  fr: { sun: "dimanche", mon: "lundi", tue: "mardi", wed: "mercredi", thu: "jeudi", fri: "vendredi", sat: "samedi" },
};

export function dayName(day: Weekday, lang: Lang): string {
  return DAYS[lang][day];
}

/** The service's name in lang: its local name for lang, else the name as the owner gave it. */
export function serviceName(service: Pick<Service, "name" | "localNames">, lang: Lang): string {
  return service.localNames?.[lang]?.trim() || service.name;
}

type Strings = {
  disclosure: string;
  ownerHelp: string;
  approved: (service: string, when: string) => string;
  rejected: (service: string, when: string) => string;
  quote: (service: string, price: string, day: string, normal: string) => string;
  plainQuote: (service: string, price: string) => string;
  /** Intl locale for dates. */
  locale: string;
};

export const STRINGS: Record<Lang, Strings> = {
  en: {
    disclosure: "[AI assistant] ",
    ownerHelp: "Thanks, I've passed this to the team and someone will get back to you shortly.",
    approved: (s, w) => `Good news: your ${s} on ${w} is confirmed. See you then.`,
    rejected: (s, w) => `Sorry, the ${s} on ${w} isn't available after all. Would you like me to check another time?`,
    quote: (s, p, d, n) => `${s} is ${p} on ${d}, normally ${n}`,
    plainQuote: (s, p) => `${s} is ${p}`,
    locale: "en-US",
  },
  he: {
    disclosure: "[עוזר AI] ",
    ownerHelp: "תודה, העברתי את זה לצוות ומישהו יחזור אליך בקרוב.",
    approved: (s, w) => `התור שלך ל${s} ב${w} אושר. נתראה!`,
    rejected: (s, w) => `מצטערים, התור ל${s} ב${w} לא זמין בסוף. לבדוק לך מועד אחר?`,
    quote: (s, p, d, n) => `${s} ב-${p} ב${d}, במקום ${n}`,
    plainQuote: (s, p) => `${s} ב-${p}`,
    locale: "he-IL",
  },
  es: {
    disclosure: "[Asistente IA] ",
    ownerHelp: "Gracias, le pasé tu mensaje al equipo y alguien te responderá en breve.",
    approved: (s, w) => `Buenas noticias: tu cita de ${s} el ${w} está confirmada. ¡Te esperamos!`,
    rejected: (s, w) => `Lo sentimos, la cita de ${s} el ${w} al final no está disponible. ¿Quieres que te busque otro horario?`,
    quote: (s, p, d, n) => `${s} cuesta ${p} el ${d}, normalmente ${n}`,
    plainQuote: (s, p) => `${s} cuesta ${p}`,
    locale: "es-US",
  },
  fr: {
    disclosure: "[Assistant IA] ",
    ownerHelp: "Merci, j'ai transmis votre message à l'équipe; quelqu'un vous répondra sous peu.",
    approved: (s, w) => `Bonne nouvelle : votre rendez-vous ${s} le ${w} est confirmé. À bientôt!`,
    rejected: (s, w) => `Désolé, le rendez-vous ${s} le ${w} n'est finalement plus disponible. Voulez-vous que je cherche un autre créneau?`,
    quote: (s, p, d, n) => `${s} coûte ${p} le ${d}, normalement ${n}`,
    plainQuote: (s, p) => `${s} coûte ${p}`,
    locale: "fr-CA",
  },
};

// Marker words per language; Latin-script languages are told apart by counting them.
const MARKERS: Record<Exclude<Lang, "he">, RegExp> = {
  en: /\b(?:the|you|your|do|does|have|what|for|is|are|can|i|my|book|please|offer|price|hi|hello|monday|tuesday|wednesday|thursday|friday|saturday|sunday|available|thanks)\b/giu,
  es: /(?<!\p{L})(?:que|qué|tienen|tiene|hola|para|gracias|hueco|cuánto|cuanto|ofrecen|ofrece|el|los|las|una|un|con|hay|puedo|quiero|precio|cita|por favor|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|disponible|horario|mañana)(?!\p{L})/giu,
  fr: /(?<!\p{L})(?:vous|est|avez|pour|bonjour|merci|qu'|quel|quelle|proposez|place|je|nous|le|les|des|une|avec|rendez-vous|prix|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|disponible|créneau|demain|c'est)(?!\p{L})/giu,
};
const ACCENTS: Array<[Exclude<Lang, "he">, RegExp]> = [
  ["es", /[ñ¿¡áíóú]/giu],
  ["fr", /[çœàâèêëîïôûù]/giu],
];

/**
 * The language of text among the supported ones: Hebrew by script, the Latin
 * ones by marker words and accents; fallback when nothing decides it.
 */
export function detectLanguage(text: string, fallback: Lang = "en"): Lang {
  const firstLetter = text.match(/\p{L}/u)?.[0];
  if (firstLetter && /\p{Script=Hebrew}/u.test(firstLetter)) return "he";
  const score: Record<Exclude<Lang, "he">, number> = { en: 0, es: 0, fr: 0 };
  for (const [lang, re] of Object.entries(MARKERS) as Array<[Exclude<Lang, "he">, RegExp]>) score[lang] += text.match(re)?.length ?? 0;
  for (const [lang, re] of ACCENTS) score[lang] += 2 * (text.match(re)?.length ?? 0);
  const best = (Object.entries(score) as Array<[Exclude<Lang, "he">, number]>).sort((a, b) => b[1] - a[1]);
  if (best[0][1] === 0 || best[0][1] === best[1][1]) return fallback;
  return best[0][0];
}

/** Long weekday, day, month and HH:MM in tz, in lang; the zone abbreviation is added outside Israel. */
export function formatWhenIn(instant: Date | string, tz: string, lang: Lang, zone: string): string {
  const wall = new Intl.DateTimeFormat(STRINGS[lang].locale, {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
  return tz === "Asia/Jerusalem" ? wall : `${wall} ${zone}`;
}
