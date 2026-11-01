// Deterministic branded composite: scene (or a flat brand colour), the subject
// lower-centre with a soft shadow, and a text band drawn by code with the
// business name, offer line and price exactly as computed from the brain.
// No model touches these pixels.
import sharp from "sharp";
import { textPath } from "./text";

export const SIZES = { feed: { w: 1080, h: 1080 }, story: { w: 1080, h: 1920 } } as const;
export type SizeName = keyof typeof SIZES;

export type Band = { name: string; headline: string; price: string; note: string | null };
export type CompositeParts = {
  /** Generated scene PNG, or null for the flat brand-colour fallback. */
  scene: Buffer | null;
  brandColor: string;
  /** Transparent cutout, or a photo/crop to show in a rounded frame. */
  subject: Buffer;
  subjectKind: "cutout" | "framed";
  band: Band;
};

/** Price and offer are the largest text: readable when the feed image is shown at phone width (~360 px). */
const LAYOUT: Record<SizeName, { band: number; box: { w: number; h: number }; bottom: number; name: number; headline: number; price: number; note: number }> = {
  feed: { band: 400, box: { w: 680, h: 580 }, bottom: 40, name: 30, headline: 72, price: 150, note: 34 },
  story: { band: 600, box: { w: 900, h: 1100 }, bottom: 150, name: 40, headline: 92, price: 200, note: 44 },
};

/** A deterministic brand colour from the business name. */
export function brandColor(name: string): string {
  const palette = ["#1f2a44", "#2d3b2f", "#3b2a2a", "#2a3340", "#3a3125", "#24323a"];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/** Split a label in two at the separator (" · ", else a space) nearest its middle. */
export function splitLine(text: string): [string, string] | null {
  const cuts = [...text.matchAll(/ · | /g)].map((m) => ({ at: m.index!, len: m[0].length, dot: m[0] === " · " }));
  if (!cuts.length) return null;
  const mid = text.length / 2;
  const pool = cuts.some((c) => c.dot) ? cuts.filter((c) => c.dot) : cuts;
  const best = pool.reduce((a, b) => (Math.abs(b.at - mid) < Math.abs(a.at - mid) ? b : a));
  const keepDot = best.dot ? " ·" : "";
  return [text.slice(0, best.at) + keepDot, text.slice(best.at + best.len)];
}

/** The offer line: one line when it fits at 75% of its size or more, otherwise two lines. */
function headlineLines(text: string, L: { band: number; headline: number }, cx: number, maxWidth: number): string[] {
  const one = textPath({ text, cx, y: Math.round(L.band * 0.38), size: L.headline, minSize: 1, maxWidth, weight: 700, fill: "#ffffff" });
  const split = splitLine(text);
  if (one.size >= L.headline * 0.75 || !split) return [one.svg];
  const size = Math.round(L.headline * 0.85);
  return split.map((line, i) => textPath({ text: line, cx, y: Math.round(L.band * 0.27 + i * size * 1.05), size, minSize: 1, maxWidth, weight: 700, fill: "#ffffff" }).svg);
}

/**
 * The text band as SVG. The strings are drawn exactly as given, as paths from
 * the bundled fonts (src/lib/content/text.ts), never as <text>: a host without
 * fonts (Vercel) would otherwise render empty boxes.
 */
export function bandSvg(band: Band, size: SizeName): string {
  const { w } = SIZES[size];
  const L = LAYOUT[size];
  const maxWidth = w - 80;
  const cx = w / 2;
  const name = textPath({ text: band.name.toUpperCase(), cx, y: Math.round(L.band * 0.13), size: L.name, maxWidth, weight: 600, fill: "#ffffff", opacity: 0.85, letterSpacing: 3 });
  const headline = headlineLines(band.headline, L, cx, maxWidth);
  const price = textPath({ text: band.price, cx, y: Math.round(L.band * (band.note ? 0.78 : 0.84)), size: L.price, maxWidth, weight: 800, fill: "#ffd166" });
  const note = band.note ? textPath({ text: band.note, cx, y: Math.round(L.band * 0.94), size: L.note, maxWidth, weight: 600, fill: "#ffffff", opacity: 0.8 }) : null;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${L.band}">`,
    `<rect width="${w}" height="${L.band}" fill="#000" fill-opacity="0.62"/>`,
    name.svg,
    ...headline,
    price.svg,
    ...(note ? [note.svg] : []),
    `</svg>`,
  ].join("");
}

async function framed(photo: Buffer, box: { w: number; h: number }): Promise<Buffer> {
  const img = await sharp(photo).resize(box.w - 24, box.h - 24, { fit: "inside" }).png().toBuffer();
  const { width, height } = await sharp(img).metadata();
  const r = 36;
  const mask = Buffer.from(`<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${r}" ry="${r}"/></svg>`);
  const rounded = await sharp(img).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  const border = Buffer.from(
    `<svg width="${width! + 24}" height="${height! + 24}"><rect width="${width! + 24}" height="${height! + 24}" rx="${r + 12}" ry="${r + 12}" fill="#ffffff"/></svg>`,
  );
  return sharp(border).composite([{ input: rounded, left: 12, top: 12 }]).png().toBuffer();
}

export async function composite(parts: CompositeParts, size: SizeName): Promise<Buffer> {
  const { w, h } = SIZES[size];
  const L = LAYOUT[size];
  const background = parts.scene
    ? await sharp(parts.scene).resize(w, h, { fit: "cover" }).png().toBuffer()
    : await sharp({ create: { width: w, height: h, channels: 4, background: parts.brandColor } }).png().toBuffer();

  const subject =
    parts.subjectKind === "cutout"
      ? await sharp(parts.subject).resize(L.box.w, L.box.h, { fit: "inside" }).png().toBuffer()
      : await framed(parts.subject, L.box);
  const { width: sw, height: sh } = await sharp(subject).metadata();
  const left = Math.round((w - sw!) / 2);
  const top = h - L.bottom - sh!;

  const shadowW = Math.round(sw! * 0.8);
  const shadow = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><filter id="b"><feGaussianBlur stdDeviation="22"/></filter></defs>` +
      `<ellipse cx="${w / 2}" cy="${top + sh! - 6}" rx="${shadowW / 2}" ry="${Math.round(sh! * 0.06) + 14}" fill="#000" fill-opacity="0.45" filter="url(#b)"/></svg>`,
  );

  return sharp(background)
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: subject, left, top },
      { input: Buffer.from(bandSvg(parts.band, size)), left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
}
