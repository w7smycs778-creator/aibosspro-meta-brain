// Content engine and the WhatsApp default-mode setting. Stub dispatchers only.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleInbound } from "../engine/conversation-service";
import { DEMO_CLOCK } from "../engine/demo-script";
import type { EngineDeps } from "../engine/deps";
import { SpendGateway } from "../gateway/gateway";
import { StoreSpendLedger } from "../gateway/ledger";
import { MOCK_MODEL, MOCK_PRICES, MockModelClient } from "../gateway/mock-client";
import { usdToNano } from "../gateway/money";
import { PRICES } from "../gateway/pricing";
import type { DispatchResult, Dispatcher, ModelCall } from "../gateway/types";
import { LocalStore } from "../storage/local-store";
import { SEED_BRAIN, SEED_BUSINESS_ID } from "../storage/seed";
import type { BusinessBrain } from "../storage/types";
import { verifyCaption } from "./caption";
import { bandSvg, composite, SIZES, splitLine } from "./composite";
import { measure, textPath, visualOrder } from "./text";
import { decideCreative, generateCreative, regenerateCreative, samCopy, scenePrompt } from "./creative";
import { MEDIA_BUCKET, SupabaseMediaStore } from "./media-store";
import { findOffer, listOffers } from "./offers";
import { DEMO_BUSINESSES } from "../storage/seed-demo";
import { buildCutout, parseSegmentation } from "./segment";

const dirs: string[] = [];
const stores: LocalStore[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "meta-brain-content-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Cedar Street Barbers as approved live on 2026-10-29: Cut plus beard ₪120, 15% off on Tuesdays -> ₪102. */
const CEDAR: BusinessBrain = {
  ...SEED_BRAIN,
  name: "Cedar Street Barbers",
  currency: "ILS",
  tone: { adjectives: ["warm", "short", "relaxed"], example: "Come in, take a seat." },
  services: [
    { id: "classic_cut", name: "Classic cut", durationMin: 30, priceCents: 8_000, currency: "ILS" },
    { id: "skin_fade", name: "Skin fade", durationMin: 40, priceCents: 9_000, currency: "ILS" },
    { id: "cut_plus_beard", name: "Cut plus beard", durationMin: 50, priceCents: 12_000, currency: "ILS" },
  ],
  discounts: [
    { id: "discount_1", description: "Cut plus beard is 15% off on Tuesdays", percentOff: 15, amountOffCents: null, serviceIds: ["cut_plus_beard"], weekdays: ["tue"], conditions: "" },
  ],
};
const OFFER_ID = "discount:discount_1:cut_plus_beard";

async function cedarStore(): Promise<LocalStore> {
  const s = LocalStore.open(dir());
  stores.push(s);
  await s.reset();
  const v = await s.addBrainVersion(SEED_BUSINESS_ID, CEDAR);
  await s.approveBrainVersion(SEED_BUSINESS_ID, v.version);
  return s;
}

/** COCO run-length counts (column-major, background first) for a row-major alpha buffer. */
function encodeRle(alpha: Uint8Array, h: number, w: number): number[] {
  const counts: number[] = [];
  let current = 0;
  let run = 0;
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      const v = alpha[y * w + x] > 127 ? 1 : 0;
      if (v === current) run++;
      else {
        counts.push(run);
        current = v;
        run = 1;
      }
    }
  counts.push(run);
  return counts;
}

const W = 400;
const H = 600;
async function testPhoto(): Promise<Buffer> {
  // A grey frame with a darker "product" in the middle.
  const product = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#333333" } }).png().toBuffer();
  return sharp({ create: { width: W, height: H, channels: 3, background: "#cccccc" } }).composite([{ input: product, left: 100, top: 150 }]).jpeg().toBuffer();
}
function rectAlpha(): Uint8Array {
  const a = new Uint8Array(W * H);
  for (let y = 150; y < 450; y++) for (let x = 100; x < 300; x++) a[y * W + x] = 255;
  return a;
}

/** Answers segment, image and chat calls; any part can be made to fail. */
/** SAM tokens with a box (no decodable mask) inside the 400x600 test photo: a "box" cutout. */
const BOX_SEGMENT = "<0f>0<|box;x1=100;y1=150;x2=300;y2=450;w=400;h=600|><|mask;x=0;y=0;data=301,201,!!~|>";
/** What SAM returned for the owner photos it found nothing in (2026-11-01): an empty message. */
const EMPTY_SEGMENT = JSON.stringify([{ type: "message", id: "msg_synthetic", role: "assistant", content: [{ type: "output_text", text: "", annotations: [], logprobs: [] }], status: "completed" }]);

function stub(opts: { segment?: string | null; image?: "ok" | "fail"; imageBytes?: Buffer; headers?: Record<string, string>; captions?: string[] }): Dispatcher & { calls: ModelCall[] } {
  const captions = [...(opts.captions ?? ["Cut plus beard is ₪102 every Tuesday. Book your chair today."])];
  const d = {
    calls: [] as ModelCall[],
    async dispatch(call: ModelCall): Promise<DispatchResult> {
      d.calls.push(call);
      if (call.kind === "segment") return { ok: true, status: 200, retryable: false, units: { kind: "segment", images: 1 }, output: opts.segment === undefined ? BOX_SEGMENT : (opts.segment ?? undefined) };
      if (call.kind === "image") {
        if (opts.image === "fail") return { ok: false, status: 500, retryable: false, units: null, errorBody: "boom" };
        const png = opts.imageBytes ?? (await sharp({ create: { width: 64, height: 64, channels: 3, background: "#8a5a3b" } }).png().toBuffer());
        return { ok: true, status: 200, retryable: false, units: { kind: "image", images: 1 }, output: png.toString("base64"), ...(opts.headers && { responseHeaders: opts.headers }) };
      }
      return { ok: true, status: 200, retryable: false, units: { kind: "chat", promptTokens: 50, cachedTokens: 0, completionTokens: 30 }, output: captions.shift() ?? "" };
    },
  };
  return d;
}
const LIMITS = { hardCapNano: usdToNano(1), creditBalanceNano: usdToNano(150), bufferNano: usdToNano(20) };
const deps = (store: LocalStore, dispatcher: Dispatcher | null): EngineDeps => ({
  store,
  gateway: dispatcher ? new SpendGateway({ ledger: new StoreSpendLedger(store, LIMITS), dispatcher, prices: { ...PRICES, ...MOCK_PRICES } }) : null,
  model: MOCK_MODEL,
  now: () => DEMO_CLOCK,
});

describe("offers", () => {
  it("are computed from the approved brain by code", () => {
    const offer = findOffer(CEDAR, OFFER_ID)!;
    expect(offer).toMatchObject({
      kind: "discount",
      serviceName: "Cut plus beard",
      listPriceCents: 12_000,
      offerPriceCents: 10_200,
      priceText: "₪102",
      listPriceText: "₪120",
      condition: "Tuesdays",
      weekdays: ["tue"],
      label: "Cut plus beard, 15% off Tuesdays -> ₪102",
      headline: "Cut plus beard · 15% off · Tuesdays",
    });
    expect(listOffers(CEDAR).map((o) => o.id)).toEqual(["service:classic_cut", "service:skin_fade", "service:cut_plus_beard", OFFER_ID]);
    expect(findOffer(CEDAR, "service:classic_cut")).toMatchObject({ priceText: "₪80", condition: null });
  });
});

describe("composite", () => {
  it("renders the offer price exactly, by code, in both sizes", async () => {
    const offer = findOffer(CEDAR, OFFER_ID)!;
    const band = { name: CEDAR.name, headline: offer.headline, price: offer.priceText, note: `Normally ${offer.listPriceText}` };
    for (const size of ["feed", "story"] as const) {
      const svg = bandSvg(band, size);
      // Drawn as glyph paths from the bundled fonts: no <text>, so no system font is ever needed.
      expect(svg).not.toMatch(/<text|font-family/);
      expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(4);
      // The price path is exactly the bundled-font rendering of the code-computed price.
      expect(svg.match(/<path [^>]*fill="#ffd166"[^>]*>/g)).toHaveLength(1);
      expect(measure("₪102", 100, 800).missing).toEqual([]);
      const subject = await sharp({ create: { width: 200, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
      const png = await composite({ scene: null, brandColor: "#223344", subject, subjectKind: "cutout", band }, size);
      expect(await sharp(png).metadata()).toMatchObject({ width: SIZES[size].w, height: SIZES[size].h, format: "png" });
    }
    // The scene prompt never carries the price or text instructions to draw it.
    const prompt = scenePrompt(CEDAR, offer);
    expect(prompt).not.toMatch(/₪|102|120|Cedar/);
    expect(prompt).toContain("No text of any kind: no words, no letters, no numbers, no logos, no signage, no labels, no people");
  });
});

describe("caption verification", () => {
  const offer = findOffer(CEDAR, OFFER_ID)!;
  it("a wrong price fails; the Tuesday discount for the Tuesday offer passes", () => {
    expect(verifyCaption("Cut plus beard for ₪99 this Tuesday. Book now.", CEDAR, offer).pass).toBe(false);
    expect(verifyCaption("Cut plus beard is ₪102 every Tuesday. Book your chair today.", CEDAR, offer).pass).toBe(true);
    expect(verifyCaption("Cut plus beard, 15% off on Tuesdays. Book your chair today.", CEDAR, offer).pass).toBe(true);
  });
  it('"normally <list price>" next to the discounted price is tied to the offer, not left for review', () => {
    const live = "Cut plus beard, 50 min, ₪102 only on Tuesdays (normally ₪120).\nCome in, take a seat - we've got you.";
    const v = verifyCaption(live, CEDAR, offer);
    expect(v.pass).toBe(true);
    expect(v.checks.some((c) => c.inconclusive)).toBe(false);
    expect(v.checks).toContainEqual(expect.objectContaining({ rule: "service_price", claim: "Cut plus beard ₪120 (normally)", pass: true }));
    expect(verifyCaption("Cut plus beard ₪102 only on Tuesdays (normally ₪90).", CEDAR, offer).pass).toBe(false);
  });

  it("a discounted price without its day, another service, or a wrong percent fails", () => {
    expect(verifyCaption("Cut plus beard is ₪102 this week. Book now.", CEDAR, offer).pass).toBe(false);
    expect(verifyCaption("Cut plus beard is ₪102 on Wednesday. Book now.", CEDAR, offer).pass).toBe(false);
    expect(verifyCaption("Cut plus beard ₪102 on Tuesdays, and a Skin fade too. Book now.", CEDAR, offer).checks).toContainEqual(expect.objectContaining({ rule: "offer", claim: "Skin fade", pass: false }));
    expect(verifyCaption("20% off Cut plus beard on Tuesdays. Book now.", CEDAR, offer).pass).toBe(false);
  });
});

describe("segmentation parsing", () => {
  it("reads a JSON run-length mask and cuts the subject out", async () => {
    const photo = await testPhoto();
    const raw = JSON.stringify([{ type: "message", content: [{ masks: [{ counts: encodeRle(rectAlpha(), H, W), size: [H, W] }], boxes: [[100, 150, 300, 450]] }] }]);
    const seg = await parseSegmentation(raw, W, H);
    expect(seg.format).toBe("json+rle-mask");
    const cut = await buildCutout(photo, seg);
    expect(cut.kind).toBe("mask");
    const meta = await sharp(cut.png).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([200, 300, true]);
  });
  it("reads token boxes, rejects implausible masks, and reports unrecognised output", async () => {
    const photo = await testPhoto();
    const boxed = await parseSegmentation("<box>100, 150, 300, 450</box>", W, H);
    expect(boxed).toMatchObject({ format: "tokens+box", box: [100, 150, 300, 450] });
    expect((await buildCutout(photo, boxed)).kind).toBe("box");
    const everything = new Uint8Array(W * H).fill(255);
    const whole = await parseSegmentation(JSON.stringify({ mask: { counts: encodeRle(everything, H, W), size: [H, W] } }), W, H);
    expect((await buildCutout(photo, whole)).kind).toBe("unavailable");
    expect((await parseSegmentation("I found a counter.", W, H)).format).toBe("unrecognised");
  });
});

describe("SAM 3.1 masks decoded with @meta-sam/parser (fixtures/sam/mug-output.txt, live response for the synthetic mug, 2026-10-29)", () => {
  const MUG = readFileSync(join(process.cwd(), "fixtures/sam/mug-output.txt"), "utf8");

  it("decodes the saved mug mask to a 216x241 binary raster whose filled area sits inside the box", async () => {
    const seg = await parseSegmentation(MUG, 640, 480);
    expect(seg.format).toBe("sam-tokens+lossless-mask");
    // Half-open box from the parser: x2=470, y2=370 in the token are inclusive corners.
    expect(seg.box).toEqual([230, 155, 471, 371]);
    const m = seg.boxMask!;
    expect([m.height, m.width, m.raster.length]).toEqual([216, 241, 216 * 241]);
    expect([...new Set(m.raster)].sort()).toEqual([0, 1]);
    let on = 0;
    for (const v of m.raster) on += v;
    expect(on / m.raster.length).toBeGreaterThan(0.5); // the mug fills most of its box
    expect(on / m.raster.length).toBeLessThan(0.95);
    // The raster covers the box exactly (box-local), so every filled pixel is inside the box.
    expect([m.width, m.height]).toEqual([seg.box![2] - seg.box![0], seg.box![3] - seg.box![1]]);
    // Wrapped in the Responses API output structure, as the dispatcher passes it; and scaled to a half-size image.
    const wrapped = JSON.stringify([{ type: "message", role: "assistant", content: [{ type: "output_text", text: MUG, annotations: [] }], status: "completed" }]);
    expect(await parseSegmentation(wrapped, 640, 480)).toMatchObject({ format: "json+sam-tokens+lossless-mask", box: [230, 155, 471, 371] });
    expect((await parseSegmentation(MUG, 320, 240)).box).toEqual([115, 77.5, 235.5, 185.5]);
  });

  it("builds a transparent cutout from the decoded mask at the original resolution, feathered", async () => {
    const original = await sharp({ create: { width: 1280, height: 960, channels: 3, background: "#777777" } }).jpeg().toBuffer();
    const sent = await sharp(original).resize(640, 480).jpeg().toBuffer();
    const cut = await buildCutout(sent, await parseSegmentation(MUG, 640, 480), original);
    expect(cut.kind).toBe("mask");
    expect(cut.reason).toMatch(/SAM mask 216x241 decoded/);
    const meta = await sharp(cut.png).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([482, 432, true]);
    const { data } = await sharp(cut.png).raw().toBuffer({ resolveWithObject: true });
    const alphas = new Set<number>();
    for (let i = 3; i < data.length; i += 4) alphas.add(data[i]);
    expect(alphas.has(0) && alphas.has(255)).toBe(true);
    expect([...alphas].some((a) => a > 0 && a < 255)).toBe(true); // feathered edge
  });

  /** Pixels at least 4 px inside the mask (nearest-neighbour mask scaled to the cutout, eroded). */
  async function interiorAlpha(cutPng: Buffer, raster: Uint8Array, mw: number, mh: number): Promise<number[]> {
    const { data, info } = await sharp(cutPng).raw().toBuffer({ resolveWithObject: true });
    const nn = await sharp(Buffer.from(raster.map((v) => (v ? 255 : 0))), { raw: { width: mw, height: mh, channels: 1 } })
      .resize(info.width, info.height, { fit: "fill", kernel: "nearest" })
      .extractChannel(0)
      .raw()
      .toBuffer();
    const out: number[] = [];
    for (let y = 4; y < info.height - 4; y++)
      for (let x = 4; x < info.width - 4; x++) {
        let inside = true;
        for (let d = -4; d <= 4 && inside; d += 2) if (!nn[(y + d) * info.width + x] || !nn[y * info.width + x + d]) inside = false;
        if (inside) out.push(data[(y * info.width + x) * 4 + 3]);
      }
    return out;
  }

  it("regression: the alpha buffer keeps the decoder's stride (no stripes, no shear)", async () => {
    // A 79x193 mask whose left half is on, scaled up 3.71875x as for the demo photo.
    const mw = 79;
    const mh = 193;
    const raster = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < 40; x++) raster[y * mw + x] = 1;
    const sent = await sharp({ create: { width: mw, height: mh, channels: 3, background: "#555555" } }).jpeg().toBuffer();
    const original = await sharp({ create: { width: 294, height: 718, channels: 3, background: "#555555" } }).jpeg().toBuffer();
    const cut = await buildCutout(sent, { alpha: null, box: [0, 0, mw, mh], format: "test", boxMask: { raster, width: mw, height: mh } }, original);
    expect(cut.kind).toBe("mask");
    const { data, info } = await sharp(cut.png).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([294, 718, 4]);
    // Every row agrees: opaque on the left, clear on the right. A stride error makes rows disagree.
    for (let y = 10; y < info.height - 10; y += 7) {
      expect(data[(y * info.width + Math.round(info.width * 0.2)) * 4 + 3], `row ${y} left`).toBeGreaterThanOrEqual(250);
      expect(data[(y * info.width + Math.round(info.width * 0.8)) * 4 + 3], `row ${y} right`).toBeLessThanOrEqual(5);
    }
  });

  it("regression: the interior of a decoded mask is opaque (alpha >= 250 for at least 95% of interior pixels)", async () => {
    const original = await sharp({ create: { width: 1280, height: 960, channels: 3, background: "#777777" } }).jpeg().toBuffer();
    const sent = await sharp(original).resize(640, 480).jpeg().toBuffer();
    const seg = await parseSegmentation(MUG, 640, 480);
    const cut = await buildCutout(sent, seg, original);
    const interior = await interiorAlpha(cut.png, seg.boxMask!.raster, seg.boxMask!.width, seg.boxMask!.height);
    expect(interior.length).toBeGreaterThan(1_000);
    expect(interior.filter((a) => a >= 250).length / interior.length).toBeGreaterThanOrEqual(0.95);
  });

  it("falls back to the box crop with a vignette when a mask does not decode", async () => {
    // Same response with the mask payload damaged.
    const broken = MUG.replace(/(data=216,241,~)(.{40})/, (_m, head) => `${head}${"\u0000".repeat(40)}`);
    const seg = await parseSegmentation(broken, 640, 480);
    expect(seg.boxMask).toBeUndefined();
    expect(seg.box).not.toBeNull();
    const original = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#777777" } }).jpeg().toBuffer();
    const cut = await buildCutout(original, seg, original);
    expect(cut.kind).toBe("box");
  });

  it("sends SAM a copy with EXIF rotation applied and the long side at 1536", async () => {
    const big = await sharp({ create: { width: 3213, height: 5712, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    expect(await sharp(await samCopy(big)).metadata()).toMatchObject({ width: 864, height: 1536, format: "jpeg" });
  });
});

describe("creatives", () => {
  it("are generated as PENDING_APPROVAL with both images, and approval is idempotent", async () => {
    const store = await cedarStore();
    const media = dir();
    const segment = JSON.stringify([{ masks: [{ counts: encodeRle(rectAlpha(), H, W), size: [H, W] }] }]);
    const d = stub({ segment });
    const c = await generateCreative(deps(store, d), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: media });

    expect(c).toMatchObject({ status: "pending_approval", offerId: OFFER_ID, brainVersion: 2, cutoutKind: "mask", sceneKind: "generated", caption: "Cut plus beard is ₪102 every Tuesday. Book your chair today." });
    expect(c.captionLog).toMatchObject({ final: "verified" });
    expect(c.offer).toMatchObject({ priceText: "₪102" });
    for (const file of [c.media.original, c.media.cutout!, c.media.scene!, c.media.feed, c.media.story]) expect(existsSync(file)).toBe(true);
    expect(await sharp(c.media.feed).metadata()).toMatchObject({ width: 1080, height: 1080 });
    expect(await sharp(c.media.story).metadata()).toMatchObject({ width: 1080, height: 1920 });
    expect(d.calls.map((x) => x.kind)).toEqual(["segment", "image", "chat"]);
    expect(d.calls[0]).toMatchObject({ model: "sam-3.1", prompt: "clippers", mimeType: "image/jpeg" });
    expect(d.calls[1]).toMatchObject({ model: "muse-image-1.0", n: 1, size: "1024x1024" });
    expect((await store.listSpend()).map((r) => r.model)).toEqual(["sam-3.1", "muse-image-1.0", MOCK_MODEL]);

    expect(await decideCreative(store, c.id, "approved")).toMatchObject({ changed: true, creative: { status: "approved" } });
    expect(await decideCreative(store, c.id, "approved")).toMatchObject({ changed: false, creative: { status: "approved" } });
    expect(await decideCreative(store, c.id, "rejected")).toMatchObject({ changed: false, creative: { status: "approved" } });
  });

  it("no cutout means no creative: SAM finding nothing gives the owner a clear message and no image call is made", async () => {
    const store = await cedarStore();
    for (const segment of [EMPTY_SEGMENT, "I found a counter."]) {
      const d = stub({ segment });
      await expect(generateCreative(deps(store, d), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "  Clipers  ", mediaDir: dir() })).rejects.toMatchObject({
        status: 422,
        message: "Couldn't find 'clipers' in the photo — try one simple word like clippers.",
      });
      expect(d.calls.map((x) => x.kind)).toEqual(["segment"]);
    }
    expect(await store.listCreatives(SEED_BUSINESS_ID)).toEqual([]);
  });

  it("the object text is trimmed, lower-cased and single-spaced before it is sent; an empty one is refused", async () => {
    const store = await cedarStore();
    const d = stub({});
    await generateCreative(deps(store, d), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "  Hair   CLIPPER ", mediaDir: dir() });
    expect(d.calls[0]).toMatchObject({ kind: "segment", prompt: "hair clipper" });
    await expect(generateCreative(deps(store, stub({})), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "   ", mediaDir: dir() })).rejects.toMatchObject({ status: 400 });
  });

  it("a failed or unavailable model produces no creative, with the reason", async () => {
    const store = await cedarStore();
    await expect(generateCreative(deps(store, null), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir() })).rejects.toMatchObject({ status: 503 });
    const failing: Dispatcher = { dispatch: async () => ({ ok: false, status: 500, retryable: false, units: null, errorBody: "boom" }) };
    await expect(generateCreative(deps(store, failing), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir() })).rejects.toMatchObject({ status: 502 });
    expect(await store.listCreatives(SEED_BUSINESS_ID)).toEqual([]);
  });

  it("a failed scene and a caption failing twice still give both images (flat colour, empty caption)", async () => {
    const store = await cedarStore();
    const d = stub({ image: "fail", captions: ["Cut plus beard ₪99. Book now.", "Still ₪99 on Tuesdays. Book."] });
    const c = await generateCreative(deps(store, d), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir() });
    expect(c).toMatchObject({ cutoutKind: "box", sceneKind: "flat", caption: "" });
    expect(c.media).toMatchObject({ scene: null });
    expect(c.captionLog).toMatchObject({ final: "empty" });
    expect(await sharp(c.media.feed).metadata()).toMatchObject({ width: 1080, height: 1080 });
    expect(await sharp(c.media.story).metadata()).toMatchObject({ width: 1080, height: 1920 });
  });

  it("the media route serves a creative's images by the creative id", async () => {
    const store = await cedarStore();
    const storageDir = dir();
    vi.stubEnv("STORAGE_DIR", storageDir);
    vi.doMock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("../storage")>()), getStore: async () => store }));
    const c = await generateCreative(deps(store, stub({ image: "fail" })), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: join(storageDir, "media") });
    const { GET } = await import("@/app/api/content/[id]/media/[file]/route");
    const get = (file: string, id = c.id) => GET(new Request("http://local"), { params: Promise.resolve({ id, file }) });
    const feed = await get("feed.png");
    expect(feed.status).toBe(200);
    expect(await sharp(Buffer.from(await feed.arrayBuffer())).metadata()).toMatchObject({ width: 1080, height: 1080 });
    expect((await get("story.png")).status).toBe(200);
    expect((await get("cutout.png")).status).toBe(200);
    expect((await get("scene.png")).status).toBe(404); // the scene call failed in this creative
    expect((await get("../../meta-brain.sqlite")).status).toBe(404);
    expect((await get("feed.png", "not-a-creative")).status).toBe(404);
    vi.doUnmock("@/lib/storage");
    vi.unstubAllEnvs();
  });

  it("an empty caption reply (reasoning used the budget) gets the second attempt", async () => {
    const store = await cedarStore();
    const d = stub({ captions: ["", "Cut plus beard is ₪102 every Tuesday. Book your chair today."] });
    const c = await generateCreative(deps(store, d), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir() });
    expect(c.caption).toBe("Cut plus beard is ₪102 every Tuesday. Book your chair today.");
    expect((c.captionLog as { attempts: Array<{ checks: Array<{ claim: string }> }> }).attempts[0].checks[0].claim).toBe("empty caption");
    expect(d.calls.filter((x) => x.kind === "chat").every((x) => x.kind === "chat" && x.maxOutputTokens === 2_048)).toBe(true);
  });

  it("regenerate rebuilds a pending creative in place: new cutout, existing scene, one caption attempt", async () => {
    const store = await cedarStore();
    const first = await generateCreative(deps(store, stub({})), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir() });
    expect(first.cutoutKind).toBe("box");
    const sceneBefore = readFileSync(first.media.scene!);
    const feedBefore = readFileSync(first.media.feed);

    // The test photo is 400x600; scale the mug box into it as SAM would for this image.
    const segment = "<0f>0<|box;x1=100;y1=150;x2=300;y2=450;w=400;h=600|><|mask;x=0;y=0;data=301,201,!!~|>";
    const d = stub({ segment, captions: ["Cut plus beard is ₪102 every Tuesday. Book your chair today."] });
    const c = await regenerateCreative(deps(store, d), first.id, { object: "hair clipper", segment: true, caption: true, captionAttempts: 1 });

    expect(c).toMatchObject({ id: first.id, offerId: OFFER_ID, brainVersion: 2, status: "pending_approval", cutoutKind: "box", sceneKind: "generated" });
    expect(c.caption).toBe("Cut plus beard is ₪102 every Tuesday. Book your chair today.");
    expect(d.calls.map((x) => x.kind)).toEqual(["segment", "chat"]); // no new image call
    expect(d.calls[0]).toMatchObject({ prompt: "hair clipper", mimeType: "image/jpeg" });
    expect(readFileSync(first.media.scene!).equals(sceneBefore)).toBe(true);
    expect(c.diagnostics).toMatchObject({ object: "hair clipper" });
    expect(existsSync(c.media.cutout!)).toBe(true);
    // Half-open box from the official parser: the token's x2/y2 are inclusive corners.
    expect(c.diagnostics).toMatchObject({ cutout: { format: "sam-tokens+box", boxInSent: [100, 150, 301, 451] } });
    expect(await sharp(c.media.story).metadata()).toMatchObject({ width: 1080, height: 1920 });
  });

  it("refuses an offer that is not in the current approved brain", async () => {
    const store = await cedarStore();
    await expect(generateCreative(deps(store, null), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: "service:gone", mediaDir: dir() })).rejects.toMatchObject({ status: 400 });
  });
});

describe("WhatsApp default mode", () => {
  it("the demo business starts WhatsApp conversations in AUTO; the setting is per business and persisted", async () => {
    const store = await cedarStore();
    expect((await store.getBusiness(SEED_BUSINESS_ID))!.whatsappDefaultMode).toBe("AUTO");
    const d = deps(store, new MockModelClient([{ text: "Hi." }, { text: "never" }]));
    const wa = (ext: string, id: string) => ({ businessId: SEED_BUSINESS_ID, channel: "whatsapp" as const, externalConversationId: ext, senderId: ext, text: "hi", externalEventId: id });
    expect(await handleInbound(wa("15550003333", "w1"), d)).toMatchObject({ mode: "AUTO", outcome: "final" });
    await store.updateBusinessSettings(SEED_BUSINESS_ID, { whatsappDefaultMode: "HUMAN" });
    expect(await handleInbound(wa("15550004444", "w2"), d)).toMatchObject({ mode: "HUMAN", outcome: "not_active" });
    // Panel conversations are unchanged: still AUTO on the demo business.
    expect(await handleInbound({ ...wa("panel-x", "p1"), channel: "panel" }, deps(store, new MockModelClient([{ text: "Hi." }])))).toMatchObject({ mode: "AUTO" });
  });
});

const XMP = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:source>synthetic-test-generator</dc:source></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
/** Same shape as Muse Image's XMP (2026-11-01): one IPTC DigitalSourceType attribute. */
const MUSE_LIKE_XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></rdf:RDF></x:xmpmeta>';

/** In-memory stand-in for the Supabase Storage client surface the media store uses. */
function fakeSupabaseStorage() {
  const files = new Map<string, Buffer>();
  const buckets = new Set<string>();
  const storage = {
    getBucket: async (name: string) => ({ data: buckets.has(name) ? { name } : null, error: null }),
    createBucket: async (name: string, opts: { public: boolean }) => {
      buckets.add(name);
      expect(opts.public).toBe(false);
      return { data: { name }, error: null };
    },
    from: (bucket: string) => ({
      upload: async (path: string, body: Buffer) => (files.set(`${bucket}/${path}`, Buffer.from(body)), { data: { path }, error: null }),
      download: async (path: string) => {
        const b = files.get(`${bucket}/${path}`);
        return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: "not found" } };
      },
      createSignedUrl: async (path: string, seconds: number) => ({ data: { signedUrl: `https://storage.example/sign/${bucket}/${path}?expires=${seconds}` }, error: null }),
    }),
  };
  return { files, buckets, client: { storage } as never };
}

describe("media provenance and hosted media", () => {
  it("keeps the Muse output bytes untouched, records headers and metadata, and carries XMP only when the export has it", async () => {
    const store = await cedarStore();
    const raw = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#8a5a3b" } }).withXmp(XMP).png().toBuffer();
    const c = await generateCreative(deps(store, stub({ imageBytes: raw, headers: { "x-request-id": "req_synthetic_42", "content-type": "application/json" } })), {
      businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir(),
    });
    expect(readFileSync(c.media.sceneOriginal!).equals(raw)).toBe(true);
    const manifest = JSON.parse(readFileSync(c.media.manifest!, "utf8"));
    expect(manifest.museImage).toMatchObject({ requested: true, status: 200, providerRequestId: "req_synthetic_42", responseHeaders: { "x-request-id": "req_synthetic_42" } });
    expect(manifest.museImage.original).toMatchObject({ format: "png", xmp: true, exif: false, c2pa: false, sha256: createHash("sha256").update(raw).digest("hex") });
    expect(manifest.preserved.feed).toEqual({ xmp: true, digitalSourceType: null, notCarried: [] });
    expect((await sharp(c.media.feed).metadata()).xmp?.toString()).toContain("synthetic-test-generator");
    for (const a of manifest.assets) expect(createHash("sha256").update(readFileSync(join(dirname(c.media.feed), a.file))).digest("hex")).toBe(a.sha256);
  });

  it("claims nothing that was not received: no headers, no metadata", async () => {
    const store = await cedarStore();
    const c = await generateCreative(deps(store, stub({})), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir() });
    const manifest = JSON.parse(readFileSync(c.media.manifest!, "utf8"));
    expect(manifest.museImage).toMatchObject({ responseHeaders: null, providerRequestId: null });
    expect(manifest.museImage.original).toMatchObject({ xmp: false, exif: false, iptc: false, c2pa: false });
    expect(manifest.preserved.feed).toEqual({ xmp: false, digitalSourceType: null, notCarried: [] });
  });

  it("with the Supabase store, every file goes to the private bucket and nothing is written to disk", async () => {
    const store = await cedarStore();
    const fake = fakeSupabaseStorage();
    const media = new SupabaseMediaStore(fake.client);
    const localDir = dir();
    const c = await generateCreative(deps(store, stub({})), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", media, mediaDir: localDir });
    expect(fake.buckets.has(MEDIA_BUCKET)).toBe(true);
    for (const r of [c.media.original, c.media.feed, c.media.story, c.media.scene!, c.media.sceneOriginal!, c.media.manifest!]) {
      expect(r.startsWith(`supabase://${MEDIA_BUCKET}/`)).toBe(true);
      expect(fake.files.has(r.slice("supabase://".length))).toBe(true);
    }
    expect(readdirSync(localDir)).toEqual([]);
    expect(await media.signedUrl(c.media.feed)).toMatch(/^https:\/\/storage\.example\/sign\/creative-media\/.+feed\.png\?expires=300$/);
  });
});


describe("SupabaseMediaStore.fromEnv", () => {
  it("constructs on this Node without a WebSocket (realtime is never used)", () => {
    expect(() => SupabaseMediaStore.fromEnv({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-placeholder" })).not.toThrow();
  });
});

describe("digital source type on exports", () => {
  it("the original keeps trainedAlgorithmicMedia byte for byte; exports say compositeWithTrainedAlgorithmicMedia, confirmed on re-read, and the manifest records both", async () => {
    const store = await cedarStore();
    const raw = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#8a5a3b" } }).withXmp(MUSE_LIKE_XMP).png().toBuffer();
    const c = await generateCreative(deps(store, stub({ imageBytes: raw })), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir() });
    expect(readFileSync(c.media.sceneOriginal!).equals(raw)).toBe(true);
    for (const f of [c.media.feed, c.media.story]) {
      const x = (await sharp(f).metadata()).xmp!.toString();
      expect(x).toContain("digitalsourcetype/compositeWithTrainedAlgorithmicMedia");
      expect(x).not.toContain("digitalsourcetype/trainedAlgorithmicMedia");
    }
    const m = JSON.parse(readFileSync(c.media.manifest!, "utf8"));
    expect(m.preserved.feed.digitalSourceType).toMatchObject({
      received: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
      written: "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
      verified: true,
    });
    expect(m.preserved.feed.digitalSourceType.reason).toMatch(/owner's photo/);
  });

  it("writes no digital source type when Meta sent none", async () => {
    const store = await cedarStore();
    const c = await generateCreative(deps(store, stub({})), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir() });
    const m = JSON.parse(readFileSync(c.media.manifest!, "utf8"));
    expect(m.preserved.feed.digitalSourceType).toBeNull();
    expect((await sharp(c.media.feed).metadata()).xmp).toBeUndefined();
  });
});

describe("bundled-font text", () => {
  it("every character any demo business can put on a band has a glyph; Hebrew is laid out right to left", () => {
    for (const { brain } of DEMO_BUSINESSES) {
      for (const o of listOffers(brain)) {
        for (const t of [brain.name.toUpperCase(), o.headline, o.priceText, `Normally ${o.listPriceText ?? ""}`]) {
          for (const w of [600, 700, 800] as const) expect(measure(t, 50, w).missing, `${t} @${w}`).toEqual([]);
        }
      }
    }
    expect(visualOrder("שיעור פרטי").join("")).toBe("יטרפ רועיש");
    expect(visualOrder("ב-₪102 בלבד").join("")).toBe("דבלב ₪102-ב");
    expect(visualOrder("Cut plus beard").join("")).toBe("Cut plus beard");
  });

  it("a long offer line wraps at the separator nearest its middle, and every line fits the band", () => {
    expect(splitLine("Massage thérapeutique · 15% off · Tuesdays")).toEqual(["Massage thérapeutique ·", "15% off · Tuesdays"]);
    const svg = bandSvg({ name: "Clinique Physio Érable", headline: "Massage thérapeutique · 15% off · Tuesdays", price: "85 $ CA", note: "Normally 100 $ CA" }, "feed");
    expect((svg.match(/<path [^>]*fill="#ffffff"(?![^>]*fill-opacity)[^>]*>/g) ?? []).length).toBe(2);
    const short = textPath({ text: "Évaluation en physiothérapie · 15 % de rabais · mardis", cx: 540, y: 100, size: 72, maxWidth: 1000, weight: 700, fill: "#fff" });
    expect(short.width).toBeLessThanOrEqual(1000);
    expect(() => textPath({ text: "\u{1F600}", cx: 0, y: 0, size: 20, maxWidth: 100, weight: 700, fill: "#fff" })).toThrow(/no glyph/);
  });
});

describe("regenerate without a cutout", () => {
  it("SAM finding nothing on regenerate leaves the creative unchanged and tells the owner", async () => {
    const store = await cedarStore();
    const first = await generateCreative(deps(store, stub({})), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, object: "clippers", mediaDir: dir() });
    await expect(regenerateCreative(deps(store, stub({ segment: EMPTY_SEGMENT })), first.id, { object: "Mug", segment: true, caption: false })).rejects.toMatchObject({
      status: 422,
      message: "Couldn't find 'mug' in the photo — try one simple word like clippers.",
    });
    expect(await store.getCreative(first.id)).toMatchObject({ cutoutKind: "box", media: { cutout: first.media.cutout } });
  });
});

