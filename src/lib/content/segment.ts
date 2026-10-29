// SAM 3.1 cutout. The API documents the output only as "special-token text,
// one box + mask per match", so this parser accepts the plausible encodings
// (JSON with a base64 PNG mask, COCO run-length counts, or a box; token-wrapped
// boxes and masks) and reports what it saw. A mask becomes the alpha channel of
// a transparent PNG; a box alone becomes a framed crop; nothing usable means
// the caller falls back to the framed original.
import sharp from "sharp";

export type Box = [x1: number, y1: number, x2: number, y2: number];
export type Segmentation = {
  /** One byte per pixel (0..255) at the size of the image sent, row-major. */
  alpha: Buffer | null;
  box: Box | null;
  format: string;
};

/** Byte-free description of a model output for logs: length, JSON keys, tokens, a head with long base64 runs elided. */
export function describeOutput(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return { present: false };
  let keys: string[] | null = null;
  try {
    const v = JSON.parse(raw);
    keys = Array.isArray(v) ? [`array(${v.length})`, ...(v[0] && typeof v[0] === "object" ? Object.keys(v[0]) : [])] : typeof v === "object" && v ? Object.keys(v) : null;
  } catch {
    keys = null;
  }
  const tokens = [...new Set(raw.match(/<\|?[a-z_]{2,24}\|?>/gi) ?? [])].slice(0, 20);
  const head = raw.slice(0, 400).replace(/[A-Za-z0-9+/=]{60,}/g, (m) => `<base64 ${m.length} chars>`);
  return { present: true, length: raw.length, json: keys !== null, keys, tokens, head };
}

function decodeCocoString(s: string): number[] {
  // pycocotools compressed RLE string.
  const counts: number[] = [];
  let p = 0;
  while (p < s.length) {
    let x = 0;
    let k = 0;
    let more = true;
    while (more) {
      const c = s.charCodeAt(p) - 48;
      x |= (c & 0x1f) << (5 * k);
      more = (c & 0x20) !== 0;
      p++;
      k++;
      if (!more && c & 0x10) x |= -1 << (5 * k);
    }
    if (counts.length > 2) x += counts[counts.length - 2];
    counts.push(x);
  }
  return counts;
}

/** COCO RLE (column-major, starting with background) -> row-major alpha. */
function rleToAlpha(counts: number[], h: number, w: number): Buffer {
  const colMajor = new Uint8Array(h * w);
  let pos = 0;
  counts.forEach((n, i) => {
    if (i % 2 === 1) colMajor.fill(255, pos, Math.min(pos + n, colMajor.length));
    pos += n;
  });
  const out = Buffer.alloc(h * w);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) out[y * w + x] = colMajor[x * h + y];
  return out;
}

async function pngToAlpha(b64: string, w: number, h: number): Promise<Buffer> {
  const png = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const { data } = await sharp(png).resize(w, h, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data;
}

function toBox(nums: number[], w: number, h: number): Box | null {
  if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
  let [x1, y1, x2, y2] = nums;
  // Fractions of the image when every value is in 0..1; otherwise pixels of the image sent.
  if (Math.max(x1, y1, x2, y2) <= 1) [x1, y1, x2, y2] = [x1 * w, y1 * h, x2 * w, y2 * h];
  // [x, y, width, height] when the second corner is smaller than the first.
  if (x2 < x1 || y2 < y1) [x2, y2] = [x1 + x2, y1 + y2];
  const b: Box = [Math.max(0, x1), Math.max(0, y1), Math.min(w, x2), Math.min(h, y2)];
  return b[2] - b[0] > 4 && b[3] - b[1] > 4 ? b : null;
}

/** Finds the first mask and box in a JSON value, at any depth. */
function scanJson(v: unknown): { mask?: unknown; box?: number[] } {
  const found: { mask?: unknown; box?: number[] } = {};
  const visit = (x: unknown) => {
    if (found.mask !== undefined && found.box) return;
    if (Array.isArray(x)) return x.forEach(visit);
    if (!x || typeof x !== "object") return;
    for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (found.mask === undefined && (key === "mask" || key === "segmentation" || key === "rle")) found.mask = val;
      else if (found.mask === undefined && key === "masks" && Array.isArray(val)) found.mask = val[0];
      else if (!found.box && (key === "box" || key === "bbox") && Array.isArray(val)) found.box = val.map(Number);
      else if (!found.box && key === "boxes" && Array.isArray(val) && Array.isArray(val[0])) found.box = (val[0] as unknown[]).map(Number);
      else visit(val);
    }
  };
  visit(v);
  return found;
}

export async function parseSegmentation(raw: string | undefined, w: number, h: number): Promise<Segmentation> {
  if (!raw?.trim()) return { alpha: null, box: null, format: "empty" };
  const text = raw.trim();

  let json: unknown;
  for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1), text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)]) {
    try {
      json = JSON.parse(candidate);
      break;
    } catch {
      // next candidate
    }
  }
  if (json !== undefined) {
    const { mask, box } = scanJson(json);
    let alpha: Buffer | null = null;
    let format = "json";
    if (typeof mask === "string" && /^(data:image|iVBOR)/.test(mask)) {
      alpha = await pngToAlpha(mask, w, h);
      format = "json+png-mask";
    } else if (mask && typeof mask === "object" && "counts" in (mask as object)) {
      const m = mask as { counts: number[] | string; size?: [number, number] };
      const [mh, mw] = m.size ?? [h, w];
      const counts = typeof m.counts === "string" ? decodeCocoString(m.counts) : m.counts;
      const small = rleToAlpha(counts, mh, mw);
      alpha = mh === h && mw === w ? small : (await sharp(small, { raw: { width: mw, height: mh, channels: 1 } }).resize(w, h, { fit: "fill" }).raw().toBuffer());
      format = "json+rle-mask";
    }
    if (alpha || box) return { alpha, box: box ? toBox(box, w, h) : null, format: alpha ? format : "json+box" };
    // No mask or box keys: the special tokens may sit inside text fields.
    const inner = await parseTokens(collectStrings(json).join("\n"), w, h);
    return { ...inner, format: inner.format === "unrecognised" ? "json-unrecognised" : `json+${inner.format}` };
  }
  return parseTokens(text, w, h);
}

function collectStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(collectStrings);
  if (v && typeof v === "object") return Object.values(v).flatMap(collectStrings);
  return [];
}

async function parseTokens(text: string, w: number, h: number): Promise<Segmentation> {
  const maskToken = text.match(/<\|?mask[^>]*\|?>\s*([A-Za-z0-9+/=]{100,})/i);
  const boxToken = text.match(/<\|?(?:box|bbox)[^>]*\|?>\s*\(?\[?\s*([-\d.,\s]+)/i);
  const alpha = maskToken ? await pngToAlpha(maskToken[1], w, h).catch(() => null) : null;
  const box = boxToken ? toBox(boxToken[1].split(/[\s,]+/).filter(Boolean).map(Number), w, h) : null;
  return { alpha, box, format: alpha ? "tokens+mask" : box ? "tokens+box" : "unrecognised" };
}

/** Coverage of a mask, 0..1. */
function coverage(alpha: Buffer): number {
  let on = 0;
  for (const v of alpha) if (v > 127) on++;
  return on / alpha.length;
}

/** Bounding box of the mask's opaque pixels. */
function maskBounds(alpha: Buffer, w: number, h: number): Box {
  let [x1, y1, x2, y2] = [w, h, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > 127) [x1, y1, x2, y2] = [Math.min(x1, x), Math.min(y1, y), Math.max(x2, x), Math.max(y2, y)];
  return [x1, y1, x2 + 1, y2 + 1];
}

export type Cutout = { png: Buffer; kind: "mask" | "box" | "unavailable"; reason: string };

/**
 * Builds the cutout from the image that was sent to SAM. A mask covering under
 * 1% or over 90% of the frame is treated as unusable (it picked nothing, or the
 * whole scene).
 */
export async function buildCutout(image: Buffer, seg: Segmentation): Promise<Cutout> {
  const { width: w, height: h } = await sharp(image).metadata();
  if (seg.alpha) {
    const c = coverage(seg.alpha);
    if (c >= 0.01 && c <= 0.9) {
      const [x1, y1, x2, y2] = maskBounds(seg.alpha, w!, h!);
      const softAlpha = await sharp(seg.alpha, { raw: { width: w!, height: h!, channels: 1 } }).blur(1.2).raw().toBuffer();
      // RGB plus the mask as an explicit fourth (alpha) channel.
      const rgb = await sharp(image).removeAlpha().toColourspace("srgb").raw().toBuffer();
      const rgba = Buffer.alloc(w! * h! * 4);
      for (let i = 0; i < w! * h!; i++) {
        rgba[i * 4] = rgb[i * 3];
        rgba[i * 4 + 1] = rgb[i * 3 + 1];
        rgba[i * 4 + 2] = rgb[i * 3 + 2];
        rgba[i * 4 + 3] = softAlpha[i];
      }
      const png = await sharp(rgba, { raw: { width: w!, height: h!, channels: 4 } })
        .extract({ left: x1, top: y1, width: x2 - x1, height: y2 - y1 })
        .png()
        .toBuffer();
      return { png, kind: "mask", reason: `mask covers ${(c * 100).toFixed(1)}% of the frame` };
    }
    if (!seg.box) return { png: await sharp(image).png().toBuffer(), kind: "unavailable", reason: `mask covers ${(c * 100).toFixed(1)}% of the frame` };
  }
  if (seg.box) {
    const [x1, y1, x2, y2] = seg.box.map(Math.round);
    const png = await sharp(image).extract({ left: x1, top: y1, width: x2 - x1, height: y2 - y1 }).png().toBuffer();
    return { png, kind: "box", reason: "box only, no usable mask" };
  }
  return { png: await sharp(image).png().toBuffer(), kind: "unavailable", reason: `no mask or box (${seg.format})` };
}
