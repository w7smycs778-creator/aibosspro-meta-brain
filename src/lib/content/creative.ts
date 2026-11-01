// Photo -> SAM cutout -> Muse Image scene -> deterministic composite (feed +
// story) -> verified caption -> creative pending owner approval, all for one
// offer from the current approved brain. Every model call goes through the
// gateway and writes a ledger row. Any model step may fail; both images are
// always produced.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { EngineDeps } from "../engine/deps";
import type { BusinessBrain, Creative, Storage } from "../storage/types";
import { writeCaption, verifyCaption } from "./caption";
import { brandColor, composite, type Band } from "./composite";
import { findOffer, type Offer } from "./offers";
import { dirname } from "node:path";
import { contentTypeOf, FsMediaStore, mediaStoreFor, SupabaseMediaStore, type MediaStore } from "./media-store";
import { carryMetadata, inspectImage, providerRequestId, sha256, xmpOf, type Carried, type ImageFacts } from "./provenance";
import { buildCutout, describeOutput, parseSegmentation } from "./segment";
import { runCreativeQc, type QcVerdict } from "../engine/creative-qc";

export { mediaRoot } from "./media-store";

export const SEGMENT_MODEL = "sam-3.1";
export const IMAGE_MODEL = "muse-image-1.0";
/** Longest side of the copy sent to SAM; its size limits are undocumented. */
const SEND_MAX_PX = 1536;

export class ContentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Prompt for the background: brand tone, the kind of business (described by
 * its services, since the brain has no business-type field) and the offer.
 * The business name is left out so it cannot be drawn as text.
 */
export function scenePrompt(brain: BusinessBrain, offer: Offer): string {
  const tone = brain.tone.adjectives.join(", ") || "clean, modern";
  const services = brain.services.map((s) => s.name.toLowerCase()).join(", ");
  return [
    `A photographic background with a ${tone} feel, for a small business offering ${services}.`,
    `It promotes the ${offer.serviceName.toLowerCase()}: warm light, softly blurred interior, an empty surface in the lower half where a product will be placed.`,
    "No text of any kind: no words, no letters, no numbers, no logos, no signage, no labels, no people. Square composition.",
  ].join(" ");
}

export type GenerateInput = { businessId: string; photo: Buffer; offerId: string; object?: string; mediaDir?: string; media?: MediaStore };

/** What to cut out, as SAM is asked for it: trimmed, lower case, single spaces. */
export function normalizeObject(raw: string | undefined): string {
  const object = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!object) throw new ContentError("Say what to cut out of the photo, in one simple word like clippers.", 400);
  return object;
}

function notFound(object: string): ContentError {
  return new ContentError(`Couldn't find '${object}' in the photo — try one simple word like clippers.`, 422);
}

/** The creative's media store: given, else disk locally and Supabase Storage when hosted. */
function mediaFor(deps: EngineDeps, input: { mediaDir?: string; media?: MediaStore }): MediaStore {
  return input.media ?? mediaStoreFor(deps.store.backend, { mediaDir: input.mediaDir });
}

export async function generateCreative(deps: EngineDeps, input: GenerateInput): Promise<Creative> {
  const { store } = deps;
  const brainVersion = await store.getBrain(input.businessId, { approvedOnly: true });
  if (!brainVersion) throw new ContentError("no approved brain", 409);
  const brain = brainVersion.brain;
  const offer = findOffer(brain, input.offerId);
  if (!offer) throw new ContentError(`offer ${input.offerId} is not in the current approved brain`, 400);

  const id = randomUUID();
  const media = mediaFor(deps, input);
  const ref = (f: string) => media.ref(id, f);
  const assets: ManifestAsset[] = [];
  const save = async (file: string, bytes: Buffer | string, role: string) => {
    await media.put(ref(file), bytes, contentTypeOf(file));
    assets.push({ file, role, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) });
  };
  const object = normalizeObject(input.object);
  const diagnostics: Record<string, unknown> = { object };

  const original = await sharp(input.photo).rotate().jpeg({ quality: 92 }).toBuffer().catch(() => {
    throw new ContentError("the photo could not be read as an image", 400);
  });
  await save("original.jpg", original, "owner photo (EXIF rotation applied, JPEG q92)");
  const sent = await sharp(original).resize(SEND_MAX_PX, SEND_MAX_PX, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  await save("sent.jpg", sent, "copy sent to SAM");
  const { width: sw, height: sh } = await sharp(sent).metadata();

  // Cutout. Without one there is no creative: the owner is told why instead of getting a framed photo.
  if (!deps.gateway) throw new ContentError(`model unavailable: ${deps.gatewayError ?? "no gateway"}; nothing was generated`, 503);
  const r = await deps.gateway.call({ kind: "segment", model: SEGMENT_MODEL, prompt: object, image: new Uint8Array(sent), mimeType: "image/jpeg", businessId: input.businessId });
  diagnostics.segmentation = { outcome: r.outcome, ...(r.outcome === "denied" ? { reason: r.reason, detail: r.detail } : { status: r.status }), output: describeOutput(r.outcome === "denied" ? undefined : r.output) };
  if (r.outcome === "ok" && r.output) {
    // The full output is kept so a mask can be decoded again without another call.
    await save("sam-output.json", r.output, "raw SAM output");
    (diagnostics.segmentation as Record<string, unknown>).savedOutput = ref("sam-output.json");
  }
  if (r.outcome === "denied") throw new ContentError(`cutout refused: ${r.reason}: ${r.detail}; nothing was generated`, 503);
  if (r.outcome === "failed") throw new ContentError(`cutout failed (status ${r.status}); nothing was generated`, 502);
  const seg = await parseSegmentation(r.output, sw!, sh!);
  const cut = await buildCutout(sent, seg, original);
  if (cut.kind === "unavailable") throw notFound(object);
  diagnostics.cutout = { format: seg.format, kind: cut.kind, reason: cut.reason };
  const cutoutKind: Creative["cutoutKind"] = cut.kind;
  const subject: Buffer = cut.png;
  await save("cutout.png", cut.png, "cutout");
  const cutoutRef: string | null = ref("cutout.png");

  // Scene: the provider's bytes are stored untouched, with the response headers, before any processing.
  let scene: Buffer | null = null;
  let sceneKind: Creative["sceneKind"] = "flat";
  let sceneOriginalRef: string | null = null;
  let museFacts: ImageFacts | null = null;
  let museXmp: string | null = null;
  let muse: MuseRecord = { requested: false };
  if (deps.gateway) {
    const prompt = scenePrompt(brain, offer);
    const r = await deps.gateway.call({ kind: "image", model: IMAGE_MODEL, prompt, n: 1, size: "1024x1024", businessId: input.businessId });
    diagnostics.scene = { outcome: r.outcome, prompt, ...(r.outcome === "denied" ? { reason: r.reason, detail: r.detail } : { status: r.status, hasImage: Boolean(r.output) }) };
    const headers = r.outcome === "denied" ? undefined : r.responseHeaders;
    muse = { requested: true, model: IMAGE_MODEL, outcome: r.outcome, status: r.outcome === "denied" ? null : r.status, responseHeaders: headers ?? null, providerRequestId: providerRequestId(headers) };
    if (r.outcome === "ok" && r.output) {
      const raw = Buffer.from(r.output, "base64");
      museFacts = await inspectImage(raw);
      museXmp = museFacts.xmp ? await xmpOf(raw) : null;
      const file = `scene-original.${museFacts.format === "jpeg" ? "jpg" : museFacts.format === "unknown" ? "bin" : museFacts.format}`;
      await save(file, raw, "Muse Image output, bytes as returned (base64-decoded)");
      sceneOriginalRef = ref(file);
      muse.original = { file, ...museFacts };
      scene = await sharp(raw).png().toBuffer().catch(() => null);
      if (scene) {
        await save("scene.png", scene, "Muse Image output re-encoded to PNG for compositing");
        sceneKind = "generated";
      }
    }
  }

  // Composites: always both sizes, from the same parts; scene metadata carried where possible.
  const band: Band = { name: brain.name, headline: offer.headline, price: offer.priceText, note: offer.kind === "discount" ? `Normally ${offer.listPriceText}` : null };
  const parts = { scene, brandColor: brandColor(brain.name), subject, subjectKind: "cutout" as const, band };
  const preserved: Record<string, Carried> = {};
  let feedPng: Buffer | null = null;
  for (const kind of ["feed", "story"] as const) {
    const { png, carried } = await carryMetadata(await composite(parts, kind), museFacts, museXmp);
    await save(`${kind}.png`, png, `${kind} export`);
    preserved[kind] = carried;
    if (kind === "feed") feedPng = png;
  }

  const { caption, log } = await writeCaption(deps, brain, offer, input.businessId);
  // Wonder looks at the finished feed export; its verdict is shown to the owner and decides nothing.
  const qc = await runCreativeQc(deps.gateway, { feed: feedPng!, priceText: offer.priceText, object, businessId: input.businessId }, deps.now);

  const manifest: AssetManifest = { creativeId: id, createdAt: deps.now().toISOString(), store: media.kind, assets, museImage: muse, preserved, qc };
  await media.put(ref("manifest.json"), JSON.stringify(manifest, null, 2), "application/json");

  return store.createCreative({
    businessId: input.businessId,
    offerId: offer.id,
    offer: { ...offer },
    brainVersion: brainVersion.version,
    caption,
    captionLog: log as unknown as Record<string, unknown>,
    media: { original: ref("original.jpg"), cutout: cutoutRef, scene: scene ? ref("scene.png") : null, feed: ref("feed.png"), story: ref("story.png"), sceneOriginal: sceneOriginalRef, manifest: ref("manifest.json") },
    cutoutKind,
    sceneKind,
    diagnostics: { ...diagnostics, band, qc },
  });
}

export type ManifestAsset = { file: string; role: string; bytes: number; sha256: string };
/** What the image call returned; fields absent from the response stay null. */
export type MuseRecord =
  | { requested: false }
  | {
      requested: true;
      model: string;
      outcome: string;
      status: number | null;
      responseHeaders: Record<string, string> | null;
      providerRequestId: string | null;
      original?: { file: string } & ImageFacts;
    };
export type AssetManifest = {
  creativeId: string;
  createdAt: string;
  store: MediaStore["kind"];
  assets: ManifestAsset[];
  museImage: MuseRecord;
  /** Per export: what was carried over from the Muse output, and what was not and why. */
  preserved: Record<string, Carried>;
  /** Muse Wonder's check of the feed export (advisory). */
  qc: QcVerdict;
};

/** The media store a ref belongs to: Supabase Storage refs, else the creative's folder on disk. */
function mediaForRef(ref: string): MediaStore {
  if (ref.startsWith("supabase://")) return SupabaseMediaStore.fromEnv();
  return new FsMediaStore(dirname(dirname(ref)));
}

/** Downscaled copy for SAM: EXIF rotation applied, long side at most 1536 px, JPEG quality 85. The original is never sent. */
export async function samCopy(original: Buffer): Promise<Buffer> {
  return sharp(original).rotate().resize(SEND_MAX_PX, SEND_MAX_PX, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

/** segment: true = new SAM call; "saved" = re-parse the saved SAM output with the exact copy SAM saw (no call); false = keep the cutout. */
export type RegenerateOptions = { object: string; segment: boolean | "saved"; caption: boolean; captionAttempts?: number };

/**
 * Rebuilds a pending creative in place (same id, offer and brain version):
 * optionally a new SAM cutout from the stored original, composites redrawn on
 * the EXISTING scene (no new image call), optionally a new caption.
 */
export async function regenerateCreative(deps: EngineDeps, creativeId: string, opts: RegenerateOptions): Promise<Creative> {
  const { store } = deps;
  const creative = await store.getCreative(creativeId);
  if (!creative) throw new ContentError("creative not found", 404);
  if (creative.status !== "pending_approval") throw new ContentError("creative is already decided", 409);
  const brain = (await store.listBrainVersions(creative.businessId)).find((v) => v.version === creative.brainVersion)?.brain;
  const offer = brain ? findOffer(brain, creative.offerId) : null;
  if (!brain || !offer) throw new ContentError("the creative's brain version or offer is gone", 409);

  // The store the creative's files were written to, found from its refs.
  const media = mediaForRef(creative.media.feed);
  const at = (file: string) => media.sibling(creative.media.feed, file);
  const must = async (r: string) => {
    const b = await media.get(r);
    if (!b) throw new ContentError(`media file missing: ${r.slice(r.lastIndexOf("/") + 1)}`, 409);
    return b;
  };
  const original = await must(creative.media.original);
  const diagnostics: Record<string, unknown> = { ...creative.diagnostics, regeneratedAt: deps.now().toISOString() };
  let cutoutKind = creative.cutoutKind;
  let cutoutPath = creative.media.cutout;
  let subject: Buffer = cutoutPath ? await must(cutoutPath) : original;

  if (opts.segment === "saved") {
    const savedOutput = await media.get(at("sam-output.json"));
    const sent = await media.get(at("sent.jpg"));
    if (!savedOutput || !sent) throw new ContentError("no saved SAM output for this creative", 409);
    const { width: sw, height: sh } = await sharp(sent).metadata();
    const seg = await parseSegmentation(savedOutput.toString("utf8"), sw!, sh!);
    const cut = await buildCutout(sent, seg, original);
    diagnostics.cutout = { format: seg.format, kind: cut.kind, reason: cut.reason, boxInSent: seg.box, rebuiltFrom: at("sam-output.json"), ...(seg.undecodedMask && { undecodedMask: seg.undecodedMask }) };
    cutoutKind = cut.kind;
    if (cut.kind !== "unavailable") {
      await media.put(at("cutout.png"), cut.png, "image/png");
      cutoutPath = at("cutout.png");
      subject = cut.png;
    }
  } else if (opts.segment) {
    if (!deps.gateway) throw new ContentError(`model unavailable: ${deps.gatewayError ?? "no gateway"}; the creative is unchanged`, 503);
    const sent = await samCopy(original);
    await media.put(at("sent.jpg"), sent, "image/jpeg");
    const { width: sw, height: sh } = await sharp(sent).metadata();
    const object = normalizeObject(opts.object);
    const r = await deps.gateway.call({ kind: "segment", model: SEGMENT_MODEL, prompt: object, image: new Uint8Array(sent), mimeType: "image/jpeg", businessId: creative.businessId });
    diagnostics.object = object;
    diagnostics.segmentation = { outcome: r.outcome, sent: `${sw}x${sh}`, ...(r.outcome === "denied" ? { reason: r.reason, detail: r.detail } : { status: r.status }), output: describeOutput(r.outcome === "denied" ? undefined : r.output) };
    if (r.outcome === "ok" && r.output) {
      await media.put(at("sam-output.json"), r.output, "application/json");
      (diagnostics.segmentation as Record<string, unknown>).savedOutput = at("sam-output.json");
    }
    if (r.outcome === "denied") throw new ContentError(`cutout refused: ${r.reason}: ${r.detail}; the creative is unchanged`, 503);
    if (r.outcome === "failed") throw new ContentError(`cutout failed (status ${r.status}); the creative is unchanged`, 502);
    const seg = await parseSegmentation(r.output, sw!, sh!);
    const cut = await buildCutout(sent, seg, original);
    if (cut.kind === "unavailable") throw notFound(object);
    diagnostics.cutout = { format: seg.format, kind: cut.kind, reason: cut.reason, boxInSent: seg.box, ...(seg.undecodedMask && { undecodedMask: seg.undecodedMask }) };
    cutoutKind = cut.kind;
    await media.put(at("cutout.png"), cut.png, "image/png");
    cutoutPath = at("cutout.png");
    subject = cut.png;
  }

  const scene = creative.media.scene ? await media.get(creative.media.scene) : null;
  const sceneOriginal = creative.media.sceneOriginal ? await media.get(creative.media.sceneOriginal) : null;
  const sceneFacts = sceneOriginal ? await inspectImage(sceneOriginal) : null;
  const sceneXmp = sceneOriginal && sceneFacts?.xmp ? await xmpOf(sceneOriginal) : null;
  const band = (creative.diagnostics.band as Band | undefined) ?? { name: brain.name, headline: offer.headline, price: offer.priceText, note: offer.kind === "discount" ? `Normally ${offer.listPriceText}` : null };
  const parts = { scene, brandColor: brandColor(brain.name), subject: cutoutKind === "unavailable" ? original : subject, subjectKind: cutoutKind === "unavailable" ? ("framed" as const) : ("cutout" as const), band };
  let feedPng: Buffer | null = null;
  for (const kind of ["feed", "story"] as const) {
    const { png } = await carryMetadata(await composite(parts, kind), sceneFacts, sceneXmp);
    await media.put(creative.media[kind], png, "image/png");
    if (kind === "feed") feedPng = png;
  }
  diagnostics.qc = await runCreativeQc(
    deps.gateway,
    { feed: feedPng!, priceText: offer.priceText, object: String(diagnostics.object ?? opts.object), businessId: creative.businessId },
    deps.now,
  );

  let caption = creative.caption;
  let captionLog = creative.captionLog;
  if (opts.caption) {
    const written = await writeCaption(deps, brain, offer, creative.businessId, opts.captionAttempts ?? 2);
    caption = written.caption;
    captionLog = written.log as unknown as Record<string, unknown>;
  }

  return store.updateCreative(creativeId, {
    media: { ...creative.media, cutout: cutoutKind === "unavailable" ? null : cutoutPath },
    cutoutKind,
    diagnostics,
    caption,
    captionLog,
  });
}

/** Re-runs the caption check on a creative's current caption (no model call) and records the result. */
export async function reverifyCaption(store: Storage, creativeId: string): Promise<{ creative: Creative; pass: boolean; checks: unknown[] }> {
  const creative = await store.getCreative(creativeId);
  if (!creative) throw new ContentError("creative not found", 404);
  const brain = (await store.listBrainVersions(creative.businessId)).find((v) => v.version === creative.brainVersion)?.brain;
  const offer = brain ? findOffer(brain, creative.offerId) : null;
  if (!brain || !offer) throw new ContentError("the creative's brain version or offer is gone", 409);
  const verdict = verifyCaption(creative.caption, brain, offer);
  const log = { ...(creative.captionLog ?? {}), reverified: { at: new Date().toISOString(), ...verdict } };
  return { creative: await store.updateCreativeCaption(creativeId, creative.caption, log), ...verdict };
}

/** Owner edits the caption: saved as written, with the verifier's result recorded alongside. */
export async function editCaption(store: Storage, creativeId: string, caption: string): Promise<Creative> {
  const creative = await store.getCreative(creativeId);
  if (!creative) throw new ContentError("creative not found", 404);
  if (creative.status !== "pending_approval") throw new ContentError("creative is already decided", 409);
  const brain = (await store.listBrainVersions(creative.businessId)).find((v) => v.version === creative.brainVersion)?.brain;
  const offer = brain ? findOffer(brain, creative.offerId) : null;
  const verdict = brain && offer ? verifyCaption(caption, brain, offer) : null;
  const log = { ...(creative.captionLog ?? {}), ownerEdit: { text: caption, ...(verdict ?? { pass: null, checks: [] }) } };
  return store.updateCreativeCaption(creativeId, caption.trim(), log);
}

/** Approve (end state in Tier 1) or reject; a second decision changes nothing. */
export async function decideCreative(store: Storage, creativeId: string, decision: "approved" | "rejected"): Promise<{ creative: Creative; changed: boolean }> {
  if (!(await store.getCreative(creativeId))) throw new ContentError("creative not found", 404);
  return store.decideCreative(creativeId, decision);
}
