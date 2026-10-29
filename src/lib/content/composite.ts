// Deterministic branded composite: scene (or a flat brand colour), the subject
// lower-centre with a soft shadow, and a text band drawn by code with the
// business name, offer line and price exactly as computed from the brain.
// No model touches these pixels.
import sharp from "sharp";

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

const LAYOUT: Record<SizeName, { band: number; box: { w: number; h: number }; bottom: number; name: number; headline: number; price: number }> = {
  feed: { band: 300, box: { w: 720, h: 620 }, bottom: 50, name: 34, headline: 50, price: 112 },
  story: { band: 470, box: { w: 900, h: 1150 }, bottom: 170, name: 42, headline: 62, price: 150 },
};

/** A deterministic brand colour from the business name. */
export function brandColor(name: string): string {
  const palette = ["#1f2a44", "#2d3b2f", "#3b2a2a", "#2a3340", "#3a3125", "#24323a"];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The text band as SVG. The strings are rendered exactly as given. */
export function bandSvg(band: Band, size: SizeName): string {
  const { w } = SIZES[size];
  const L = LAYOUT[size];
  const headlineSize = band.headline.length > 30 ? Math.round(L.headline * (30 / band.headline.length)) : L.headline;
  const font = "Helvetica Neue, Helvetica, Arial, sans-serif";
  const y1 = Math.round(L.band * 0.2);
  const y2 = Math.round(L.band * 0.42);
  const y3 = Math.round(L.band * (band.note ? 0.78 : 0.82));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${L.band}">`,
    `<rect width="${w}" height="${L.band}" fill="#000" fill-opacity="0.62"/>`,
    `<text x="${w / 2}" y="${y1}" font-family="${font}" font-size="${L.name}" font-weight="600" letter-spacing="4" fill="#ffffff" fill-opacity="0.85" text-anchor="middle">${esc(band.name.toUpperCase())}</text>`,
    `<text x="${w / 2}" y="${y2}" font-family="${font}" font-size="${headlineSize}" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(band.headline)}</text>`,
    `<text x="${w / 2}" y="${y3}" font-family="${font}" font-size="${L.price}" font-weight="800" fill="#ffd166" text-anchor="middle">${esc(band.price)}</text>`,
    ...(band.note
      ? [`<text x="${w / 2}" y="${Math.round(L.band * 0.94)}" font-family="${font}" font-size="${Math.round(L.name * 0.8)}" fill="#ffffff" fill-opacity="0.8" text-anchor="middle">${esc(band.note)}</text>`]
      : []),
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
