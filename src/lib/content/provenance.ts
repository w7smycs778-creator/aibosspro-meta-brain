// What an image file carries besides pixels, read from the bytes themselves,
// and the asset manifest of a creative. Nothing here infers provenance: a field
// is reported present only when it was found in the bytes or the response.
import { createHash } from "node:crypto";
import sharp from "sharp";

export type ImageFacts = {
  sha256: string;
  bytes: number;
  /** From the file signature, not the requested format. */
  format: "png" | "jpeg" | "webp" | "unknown";
  width: number | null;
  height: number | null;
  exif: boolean;
  xmp: boolean;
  iptc: boolean;
  icc: boolean;
  /** PNG tEXt/iTXt keywords found (values not copied). */
  pngTextKeys: string[];
  /** A C2PA manifest store: PNG caBX chunk, or a JUMBF box labelled c2pa. */
  c2pa: boolean;
};

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatOf(b: Buffer): ImageFacts["format"] {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return "unknown";
}

/** PNG chunk types present, in order. */
function pngChunks(b: Buffer): string[] {
  const out: string[] = [];
  let off = 8;
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    out.push(b.subarray(off + 4, off + 8).toString("latin1"));
    off += 12 + len;
  }
  return out;
}

export async function inspectImage(bytes: Buffer): Promise<ImageFacts> {
  const format = formatOf(bytes);
  const meta = await sharp(bytes).metadata().catch(() => null);
  const chunks = format === "png" ? pngChunks(bytes) : [];
  const latin = bytes.toString("latin1");
  return {
    sha256: sha256(bytes),
    bytes: bytes.length,
    format,
    width: meta?.width ?? null,
    height: meta?.height ?? null,
    exif: Boolean(meta?.exif),
    xmp: Boolean(meta?.xmp),
    iptc: Boolean(meta?.iptc),
    icc: Boolean(meta?.icc),
    pngTextKeys: (meta?.comments ?? []).map((c) => c.keyword),
    c2pa: chunks.includes("caBX") || /jumb[\s\S]{0,64}c2pa/.test(latin),
  };
}

/** The XMP packet of an image as text, when it has one. */
export async function xmpOf(bytes: Buffer): Promise<string | null> {
  const meta = await sharp(bytes).metadata().catch(() => null);
  return meta?.xmp ? meta.xmp.toString("utf8") : null;
}

export type Carried = {
  xmp: boolean;
  /** IPTC digital source type: what Meta sent and what the export says; null when Meta sent none. */
  digitalSourceType: { received: string; written: string; verified: boolean; reason: string } | null;
  notCarried: Array<{ field: string; reason: string }>;
};

const DST_BASE = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const DST_RE = /http:\/\/cv\.iptc\.org\/newscodes\/digitalsourcetype\/([A-Za-z]+)/;
const AI_ONLY = "trainedAlgorithmicMedia";
const COMPOSITE = "compositeWithTrainedAlgorithmicMedia";

/**
 * Copies what can be copied from the generated scene into a composite PNG and
 * re-reads the result, so "carried" is only claimed when the output has it.
 * A scene marked trainedAlgorithmicMedia becomes compositeWithTrainedAlgorithmicMedia
 * on the export: the export also holds the owner's photo and printed text.
 */
export async function carryMetadata(composite: Buffer, source: ImageFacts | null, sourceXmp: string | null): Promise<{ png: Buffer; carried: Carried }> {
  const notCarried: Carried["notCarried"] = [];
  let png = composite;
  let xmp = false;
  let digitalSourceType: Carried["digitalSourceType"] = null;
  if (source) {
    if (sourceXmp) {
      const received = sourceXmp.match(DST_RE)?.[1] ?? null;
      const written = received === AI_ONLY ? COMPOSITE : received;
      const exportXmp = received === AI_ONLY ? sourceXmp.replaceAll(DST_BASE + AI_ONLY, DST_BASE + COMPOSITE) : sourceXmp;
      png = await sharp(composite).withXmp(exportXmp).png().toBuffer();
      const reread = await xmpOf(png);
      xmp = reread !== null;
      if (!xmp) notCarried.push({ field: "xmp", reason: "written but not found on re-read" });
      if (received && written) {
        digitalSourceType = {
          received: DST_BASE + received,
          written: DST_BASE + written,
          verified: reread?.match(DST_RE)?.[1] === written,
          reason:
            received === AI_ONLY
              ? "the export combines the Muse Image scene with the owner's photo and code-drawn text, so it is a composite with AI-generated media, not wholly AI-generated"
              : "carried unchanged",
        };
      }
    }
    if (source.c2pa) notCarried.push({ field: "c2pa", reason: "a C2PA manifest signs the original pixels; any edit invalidates it. The untouched original is kept." });
    if (source.exif) notCarried.push({ field: "exif", reason: "not copied: the composite is a new image (sharp cannot copy raw EXIF across images)" });
    if (source.iptc) notCarried.push({ field: "iptc", reason: "not copied" });
    if (source.icc) notCarried.push({ field: "icc", reason: "not copied; composites are sRGB" });
    if (source.pngTextKeys.length) notCarried.push({ field: `png text (${source.pngTextKeys.join(", ")})`, reason: "not copied" });
  }
  return { png, carried: { xmp, digitalSourceType, notCarried } };
}

/** Response headers worth keeping as identifiers, when the provider sent them. */
export function providerRequestId(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  for (const h of ["x-request-id", "request-id", "x-fb-request-id", "x-fb-trace-id", "x-meta-request-id"]) if (headers[h]) return headers[h];
  return null;
}
