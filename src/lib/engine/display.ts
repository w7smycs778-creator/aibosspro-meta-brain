// Pure display helpers shared by the owner screen, the onboarding page and
// their API data. No Node imports: client components use this module too.

type SourceLike = { kind: string; text: string | null } | null;

/** Label and text for the box beside a brain draft. */
export function sourceBox(version: number, source: SourceLike): { label: string; text: string } {
  const label = source?.kind === "voice" ? `Voice transcript (v${version})` : `Typed text (v${version})`;
  return { label, text: source?.text?.trim() || "(no source text was stored for this version)" };
}

/** Israel has no Intl short name in en-US; everything else uses Intl's short name. */
function zoneAbbreviation(instant: Date, tz: string): string {
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  if (tz === "Asia/Jerusalem") return offset === "GMT+3" ? "IDT" : "IST";
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(instant).find((p) => p.type === "timeZoneName")?.value ??
    offset ??
    tz
  );
}

/** e.g. "Thu, Oct 29, 16:00 IST": wall-clock time in tz with the zone abbreviation. */
export function formatWithZone(instant: Date | string, tz: string): string {
  const d = new Date(instant);
  const wall = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return `${wall} ${zoneAbbreviation(d, tz)}`;
}
