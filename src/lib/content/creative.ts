// Photo -> SAM cutout -> Muse Image scene -> deterministic composite (feed +
// story) -> verified caption -> creative pending owner approval, all for one
// offer from the current approved brain. Every model call goes through the
// gateway and writes a ledger row. Any model step may fail; both images are
// always produced.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import type { EngineDeps } from "../engine/deps";
import { DEFAULT_LOCAL_DIR } from "../storage";
import type { Env } from "../gateway/types";
import type { BusinessBrain, Creative, Storage } from "../storage/types";
import { writeCaption, verifyCaption } from "./caption";
import { brandColor, composite, type Band } from "./composite";
import { findOffer, type Offer } from "./offers";
import { buildCutout, describeOutput, parseSegmentation } from "./segment";

export const SEGMENT_MODEL = "sam-3.1";
export const IMAGE_MODEL = "muse-image-1.0";
/** Longest side of the copy sent to SAM; its size limits are undocumented. */
const SEND_MAX_PX = 1536;
export const MEDIA_FILES = ["original.jpg", "sent.jpg", "cutout.png", "scene.png", "feed.png", "story.png"] as const;

export class ContentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function mediaRoot(env: Env = process.env): string {
  return resolve(env.STORAGE_DIR?.trim() || DEFAULT_LOCAL_DIR, "media");
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
    "No words, no letters, no numbers, no logos, no signs, no people. Square composition.",
  ].join(" ");
}

export type GenerateInput = { businessId: string; photo: Buffer; offerId: string; object?: string; mediaDir?: string };

export async function generateCreative(deps: EngineDeps, input: GenerateInput): Promise<Creative> {
  const { store } = deps;
  const brainVersion = await store.getBrain(input.businessId, { approvedOnly: true });
  if (!brainVersion) throw new ContentError("no approved brain", 409);
  const brain = brainVersion.brain;
  const offer = findOffer(brain, input.offerId);
  if (!offer) throw new ContentError(`offer ${input.offerId} is not in the current approved brain`, 400);

  const id = randomUUID();
  const dir = join(input.mediaDir ?? mediaRoot(), id);
  mkdirSync(dir, { recursive: true });
  const path = (f: (typeof MEDIA_FILES)[number]) => join(dir, f);
  const diagnostics: Record<string, unknown> = { object: input.object?.trim() || "main object" };

  const original = await sharp(input.photo).rotate().jpeg({ quality: 92 }).toBuffer().catch(() => {
    throw new ContentError("the photo could not be read as an image", 400);
  });
  writeFileSync(path("original.jpg"), original);
  const sent = await sharp(original).resize(SEND_MAX_PX, SEND_MAX_PX, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  writeFileSync(path("sent.jpg"), sent);
  const { width: sw, height: sh } = await sharp(sent).metadata();

  // Cutout.
  let cutoutKind: Creative["cutoutKind"] = "unavailable";
  let subject: Buffer = sent;
  let cutoutPath: string | null = null;
  if (deps.gateway) {
    const r = await deps.gateway.call({ kind: "segment", model: SEGMENT_MODEL, prompt: String(diagnostics.object), image: new Uint8Array(sent), mimeType: "image/jpeg", businessId: input.businessId });
    diagnostics.segmentation = { outcome: r.outcome, ...(r.outcome === "denied" ? { reason: r.reason, detail: r.detail } : { status: r.status }), output: describeOutput(r.outcome === "denied" ? undefined : r.output) };
    if (r.outcome === "ok") {
      const seg = await parseSegmentation(r.output, sw!, sh!);
      const cut = await buildCutout(sent, seg, original);
      diagnostics.cutout = { format: seg.format, kind: cut.kind, reason: cut.reason };
      cutoutKind = cut.kind;
      if (cut.kind !== "unavailable") {
        subject = cut.png;
        writeFileSync(path("cutout.png"), cut.png);
        cutoutPath = path("cutout.png");
      }
    }
  }

  // Scene.
  let scene: Buffer | null = null;
  let sceneKind: Creative["sceneKind"] = "flat";
  if (deps.gateway) {
    const prompt = scenePrompt(brain, offer);
    const r = await deps.gateway.call({ kind: "image", model: IMAGE_MODEL, prompt, n: 1, size: "1024x1024", businessId: input.businessId });
    diagnostics.scene = { outcome: r.outcome, prompt, ...(r.outcome === "denied" ? { reason: r.reason, detail: r.detail } : { status: r.status, hasImage: Boolean(r.output) }) };
    if (r.outcome === "ok" && r.output) {
      scene = await sharp(Buffer.from(r.output, "base64")).png().toBuffer().catch(() => null);
      if (scene) {
        writeFileSync(path("scene.png"), scene);
        sceneKind = "generated";
      }
    }
  }

  // Composites: always both sizes, from the same parts.
  const band: Band = { name: brain.name, headline: offer.headline, price: offer.priceText, note: offer.kind === "discount" ? `Normally ${offer.listPriceText}` : null };
  const parts = { scene, brandColor: brandColor(brain.name), subject, subjectKind: cutoutKind === "unavailable" ? ("framed" as const) : ("cutout" as const), band };
  writeFileSync(path("feed.png"), await composite(parts, "feed"));
  writeFileSync(path("story.png"), await composite(parts, "story"));

  const { caption, log } = await writeCaption(deps, brain, offer, input.businessId);

  return store.createCreative({
    businessId: input.businessId,
    offerId: offer.id,
    offer: { ...offer },
    brainVersion: brainVersion.version,
    caption,
    captionLog: log as unknown as Record<string, unknown>,
    media: { original: path("original.jpg"), cutout: cutoutPath, scene: scene ? path("scene.png") : null, feed: path("feed.png"), story: path("story.png") },
    cutoutKind,
    sceneKind,
    diagnostics: { ...diagnostics, band },
  });
}

/** Downscaled copy for SAM: EXIF rotation applied, long side at most 1536 px, JPEG quality 85. The original is never sent. */
export async function samCopy(original: Buffer): Promise<Buffer> {
  return sharp(original).rotate().resize(SEND_MAX_PX, SEND_MAX_PX, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

export type RegenerateOptions = { object: string; segment: boolean; caption: boolean; captionAttempts?: number };

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

  const dir = dirname(creative.media.feed);
  const original = readFileSync(creative.media.original);
  const diagnostics: Record<string, unknown> = { ...creative.diagnostics, regeneratedAt: deps.now().toISOString() };
  let cutoutKind = creative.cutoutKind;
  let cutoutPath = creative.media.cutout;
  let subject: Buffer = cutoutPath ? readFileSync(cutoutPath) : original;

  if (opts.segment && deps.gateway) {
    const sent = await samCopy(original);
    writeFileSync(join(dir, "sent.jpg"), sent);
    const { width: sw, height: sh } = await sharp(sent).metadata();
    const r = await deps.gateway.call({ kind: "segment", model: SEGMENT_MODEL, prompt: opts.object, image: new Uint8Array(sent), mimeType: "image/jpeg", businessId: creative.businessId });
    diagnostics.object = opts.object;
    diagnostics.segmentation = { outcome: r.outcome, sent: `${sw}x${sh}`, ...(r.outcome === "denied" ? { reason: r.reason, detail: r.detail } : { status: r.status }), output: describeOutput(r.outcome === "denied" ? undefined : r.output) };
    if (r.outcome === "ok") {
      const seg = await parseSegmentation(r.output, sw!, sh!);
      const cut = await buildCutout(sent, seg, original);
      diagnostics.cutout = { format: seg.format, kind: cut.kind, reason: cut.reason, boxInSent: seg.box, ...(seg.undecodedMask && { undecodedMask: seg.undecodedMask }) };
      cutoutKind = cut.kind;
      if (cut.kind !== "unavailable") {
        writeFileSync(join(dir, "cutout.png"), cut.png);
        cutoutPath = join(dir, "cutout.png");
        subject = cut.png;
      }
    }
  }

  const scene = creative.media.scene ? readFileSync(creative.media.scene) : null;
  const band = (creative.diagnostics.band as Band | undefined) ?? { name: brain.name, headline: offer.headline, price: offer.priceText, note: offer.kind === "discount" ? `Normally ${offer.listPriceText}` : null };
  const parts = { scene, brandColor: brandColor(brain.name), subject: cutoutKind === "unavailable" ? original : subject, subjectKind: cutoutKind === "unavailable" ? ("framed" as const) : ("cutout" as const), band };
  writeFileSync(creative.media.feed, await composite(parts, "feed"));
  writeFileSync(creative.media.story, await composite(parts, "story"));

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
