// Text for the composites, drawn as SVG paths from bundled fonts (Inter for
// Latin, Heebo for Hebrew and ₪). No <text> element and no system font is
// used, so a laptop, Vercel and a judge's Linux render the same pixels.
// Right-to-left runs are ordered with a minimal bidi pass (Hebrew runs
// reversed, digits and Latin kept left to right) — enough for one-line labels.
import opentype from "opentype.js";
import { FONT_FILES } from "./fonts.generated";

export type Weight = 600 | 700 | 800;
type Script = "latin" | "hebrew";
const FILE: Record<Script, (w: Weight) => string> = {
  latin: (w) => `inter-latin-${w}-normal.woff`,
  hebrew: (w) => `heebo-hebrew-${w}-normal.woff`,
};

const cache = new Map<string, opentype.Font>();
function font(script: Script, weight: Weight): opentype.Font {
  const file = FILE[script](weight);
  let f = cache.get(file);
  if (!f) {
    const b = Buffer.from(FONT_FILES[file], "base64");
    f = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    cache.set(file, f);
  }
  return f;
}

const HEBREW = /[֐-׿יִ-ﭏ]/;
const STRONG_LTR = /[A-Za-z0-9À-ɏ$€£%₪]/;

/** The font that has this character: Hebrew letters and ₪ from Heebo, the rest from Inter. */
function scriptOf(ch: string, weight: Weight): Script {
  if (HEBREW.test(ch) || ch === "₪") return "hebrew";
  return font("latin", weight).charToGlyphIndex(ch) > 0 ? "latin" : "hebrew";
}

/** Characters in display order, left to right. */
export function visualOrder(text: string): string[] {
  const chars = [...text];
  if (!chars.some((c) => HEBREW.test(c))) return chars;
  const type = chars.map((c) => (HEBREW.test(c) ? "R" : STRONG_LTR.test(c) ? "L" : "N"));
  // A neutral between two left-to-right characters stays with them; otherwise it follows the paragraph (RTL).
  const resolved = type.map((t, i) => {
    if (t !== "N") return t;
    const prev = type.slice(0, i).reverse().find((x) => x !== "N");
    const next = type.slice(i + 1).find((x) => x !== "N");
    return prev === "L" && next === "L" ? "L" : "R";
  });
  const runs: Array<{ dir: string; chars: string[] }> = [];
  for (const [i, c] of chars.entries()) {
    const last = runs.at(-1);
    if (last && last.dir === resolved[i]) last.chars.push(c);
    else runs.push({ dir: resolved[i], chars: [c] });
  }
  return runs.reverse().flatMap((r) => (r.dir === "R" ? [...r.chars].reverse() : r.chars));
}

export type Missing = { char: string; code: string };

/** Width in px and any characters neither font can draw. */
export function measure(text: string, size: number, weight: Weight, letterSpacing = 0): { width: number; missing: Missing[] } {
  let width = 0;
  const missing: Missing[] = [];
  for (const ch of visualOrder(text)) {
    const f = font(scriptOf(ch, weight), weight);
    const g = f.charToGlyph(ch);
    if (g.index === 0 && ch.trim()) missing.push({ char: ch, code: `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` });
    width += ((g.advanceWidth ?? 0) / f.unitsPerEm) * size + letterSpacing;
  }
  return { width: Math.max(0, width - letterSpacing), missing };
}

/**
 * An SVG <path> for one line, centred on cx with its baseline at y. The size
 * shrinks to fit maxWidth (not below minSize). Throws on a character neither
 * font has, rather than drawing an empty box.
 */
export function textPath(opts: {
  text: string;
  cx: number;
  y: number;
  size: number;
  minSize?: number;
  maxWidth: number;
  weight: Weight;
  fill: string;
  opacity?: number;
  letterSpacing?: number;
}): { svg: string; size: number; width: number } {
  const spacing = opts.letterSpacing ?? 0;
  let size = opts.size;
  let m = measure(opts.text, size, opts.weight, spacing);
  if (m.missing.length) throw new Error(`no glyph for ${m.missing.map((x) => `"${x.char}" ${x.code}`).join(", ")} in the bundled fonts`);
  if (m.width > opts.maxWidth) {
    size = Math.max(opts.minSize ?? Math.round(opts.size * 0.5), Math.floor(size * (opts.maxWidth / m.width)));
    m = measure(opts.text, size, opts.weight, spacing);
  }
  let x = opts.cx - m.width / 2;
  const d: string[] = [];
  for (const ch of visualOrder(opts.text)) {
    const f = font(scriptOf(ch, opts.weight), opts.weight);
    const g = f.charToGlyph(ch);
    d.push(g.getPath(x, opts.y, size).toPathData(2));
    x += ((g.advanceWidth ?? 0) / f.unitsPerEm) * size + spacing;
  }
  const opacity = opts.opacity !== undefined ? ` fill-opacity="${opts.opacity}"` : "";
  return { svg: `<path d="${d.join(" ")}" fill="${opts.fill}"${opacity}/>`, size, width: m.width };
}
