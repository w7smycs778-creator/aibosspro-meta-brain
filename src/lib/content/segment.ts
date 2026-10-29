// SAM 3.1 cutout. Output grammar, per https://dev.meta.ai/docs/sam/reading-segmentation
// (saved in research/SAM-DOCS-2026-10-29.md):
//   <Nf>id<|box;x1=..;y1=..;x2=..;y2=..;w=<frameW>;h=<frameH>[;c=<conf>]|><|mask;x=0;y=0[;c=<conf>];data=<H>,<W>,<enc>payload|>
//   ENC ::= "~" (lossless, default) | "!" (one_bit); PAYLOAD ::= base85 bytes, which may contain "~", "!" or "|".
// The docs leave the byte format to the official parser, so records and masks
// come from @meta-sam/parser (parseImageStream + decodeMaskToRaster, a
// row-major 0/1 raster of H x W covering the record's box). A decoded mask
// becomes the alpha channel; a box alone becomes a crop with a soft vignette;
// nothing usable means the caller falls back to the framed original. JSON with
// a base64 PNG or COCO run-length mask is still accepted in case another
// response shape appears.
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import sharp from "sharp";

export type Box = [x1: number, y1: number, x2: number, y2: number];
export type Segmentation = {
  /** One byte per pixel (0..255) at the size of the image sent, row-major. */
  alpha: Buffer | null;
  /** Box in pixels of the image sent. */
  box: Box | null;
  format: string;
  /** Decoded box-local SAM mask: row-major 0/1, height x width, covering `box`. */
  boxMask?: { raster: Uint8Array; width: number; height: number };
  /** A mask token was present but could not be decoded (reason recorded). */
  undecodedMask?: { width: number; height: number; length: number; reason?: string };
};

/** Records from SAM's special-token text via the official parser (the saved text replayed as a finished stream). */
async function samRecords(text: string) {
  async function* events() {
    yield { type: "response.output_text.done" as const, item_id: "saved", output_index: 0, content_index: 0, text };
    yield { type: "response.completed" as const };
  }
  const result = await parseImageStream(events()).finalResult;
  return { boxes: recordsOfKind(result.records, "box"), masks: recordsOfKind(result.records, "mask"), diagnostics: result.diagnostics };
}

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
  if (text.includes("<|box;")) {
    try {
      const { boxes, masks } = await samRecords(text);
      const mask = masks[0];
      const record = mask ?? boxes[0];
      if (record) {
        const b = mask ? mask.bounds : { left: boxes[0].left, top: boxes[0].top, right: boxes[0].right, bottom: boxes[0].bottom };
        // Box corners are pixels of the frame SAM saw (w x h in the box token); scale them to the image given here.
        const frame = text.match(/<\|box;[^|]*?w=(\d+);h=(\d+)/);
        const fx = frame ? w / Number(frame[1]) : 1;
        const fy = frame ? h / Number(frame[2]) : 1;
        const box = toBox([b.left * fx, b.top * fy, b.right * fx, b.bottom * fy], w, h);
        if (mask) {
          try {
            const raster = decodeMaskToRaster(mask.mask);
            return { alpha: null, box, format: `sam-tokens+${mask.mask.encoding}-mask`, boxMask: { raster, width: mask.mask.width, height: mask.mask.height } };
          } catch (err) {
            return {
              alpha: null,
              box,
              format: "sam-tokens+box",
              undecodedMask: { width: mask.mask.width, height: mask.mask.height, length: mask.mask.payload.length, reason: (err as Error).message },
            };
          }
        }
        return { alpha: null, box, format: "sam-tokens+box" };
      }
    } catch {
      // Fall through to the key=value box reader below.
    }
  }
  // SAM 3.1 key=value box token, when the official parser rejected the text.
  const kvBox = text.match(/<\|box;([^|]*)\|>/);
  if (kvBox) {
    const f = Object.fromEntries(kvBox[1].split(";").map((p) => p.split("=") as [string, string]));
    const refW = Number(f.w) || w;
    const refH = Number(f.h) || h;
    const box = toBox([Number(f.x1) * (w / refW), Number(f.y1) * (h / refH), Number(f.x2) * (w / refW), Number(f.y2) * (h / refH)], w, h);
    const kvMask = text.match(/<\|mask;[^|]*?data=(\d+),(\d+),/);
    return {
      alpha: null,
      box,
      format: box ? "sam-tokens+box" : "sam-tokens-unrecognised",
      ...(kvMask && { undecodedMask: { height: Number(kvMask[1]), width: Number(kvMask[2]), length: 0, reason: "the official parser rejected the text" } }),
    };
  }
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

/** A crop whose edges fade out in a soft ellipse, so it sits on the scene without a hard frame. */
async function vignette(crop: Buffer): Promise<Buffer> {
  const { width, height } = await sharp(crop).metadata();
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><radialGradient id="g" cx="50%" cy="50%" r="50%">` +
      `<stop offset="62%" stop-color="#fff" stop-opacity="1"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
      `<ellipse cx="${width! / 2}" cy="${height! / 2}" rx="${width! / 2}" ry="${height! / 2}" fill="url(#g)"/></svg>`,
  );
  return sharp(crop).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

/**
 * Builds the cutout. The segmentation refers to `sent` (the downscaled copy
 * given to SAM); the cutout is cut from `original` at full resolution, with the
 * box or mask scaled back to it. A mask covering under 1% or over 90% of the
 * frame is treated as unusable (it picked nothing, or the whole scene).
 */
export async function buildCutout(sent: Buffer, seg: Segmentation, original: Buffer = sent): Promise<Cutout> {
  const { width: sw, height: sh } = await sharp(sent).metadata();
  const { width: ow, height: oh } = await sharp(original).metadata();
  const sx = ow! / sw!;
  const sy = oh! / sh!;
  const image = original;
  const w = ow;
  const h = oh;
  if (seg.alpha && (sx !== 1 || sy !== 1)) {
    seg = { ...seg, alpha: await sharp(seg.alpha, { raw: { width: sw!, height: sh!, channels: 1 } }).resize(ow!, oh!, { fit: "fill" }).raw().toBuffer() };
  }
  if (seg.box) seg = { ...seg, box: [seg.box[0] * sx, seg.box[1] * sy, seg.box[2] * sx, seg.box[3] * sy] };
  if (seg.boxMask && seg.box) {
    // The decoded mask covers the box: crop the box from the original, scale the
    // mask to it, feather the edge by 2 px, use it as the alpha channel.
    const [x1, y1, x2, y2] = seg.box.map(Math.round);
    const left = Math.max(0, x1);
    const top = Math.max(0, y1);
    const cw = Math.min(w!, x2) - left;
    const ch = Math.min(h!, y2) - top;
    const m = seg.boxMask;
    const on = m.raster.reduce((n, v) => n + v, 0) / m.raster.length;
    if (on >= 0.02) {
      const mask255 = Buffer.from(m.raster.map((v) => (v ? 255 : 0)));
      const alpha = await sharp(mask255, { raw: { width: m.width, height: m.height, channels: 1 } }).resize(cw, ch, { fit: "fill", kernel: "cubic" }).blur(2).raw().toBuffer();
      const rgb = await sharp(image).extract({ left, top, width: cw, height: ch }).removeAlpha().toColourspace("srgb").raw().toBuffer();
      const rgba = Buffer.alloc(cw * ch * 4);
      for (let i = 0; i < cw * ch; i++) {
        rgba[i * 4] = rgb[i * 3];
        rgba[i * 4 + 1] = rgb[i * 3 + 1];
        rgba[i * 4 + 2] = rgb[i * 3 + 2];
        rgba[i * 4 + 3] = alpha[i];
      }
      const png = await sharp(rgba, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer();
      return { png, kind: "mask", reason: `SAM mask ${m.height}x${m.width} decoded, ${(on * 100).toFixed(1)}% of the box, scaled to ${cw}x${ch} with a 2 px feather` };
    }
    seg = { ...seg, boxMask: undefined, undecodedMask: { width: m.width, height: m.height, length: 0, reason: `mask covers only ${(on * 100).toFixed(1)}% of the box` } };
  }
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
    const left = Math.max(0, x1);
    const top = Math.max(0, y1);
    const crop = await sharp(image).extract({ left, top, width: Math.min(w!, x2) - left, height: Math.min(h!, y2) - top }).png().toBuffer();
    const why = seg.undecodedMask
      ? `box crop with soft vignette; mask ${seg.undecodedMask.height}x${seg.undecodedMask.width} not used (${seg.undecodedMask.reason ?? "not decoded"})`
      : "box crop with soft vignette; no mask";
    return { png: await vignette(crop), kind: "box", reason: why };
  }
  return { png: await sharp(image).png().toBuffer(), kind: "unavailable", reason: `no mask or box (${seg.format})` };
}
