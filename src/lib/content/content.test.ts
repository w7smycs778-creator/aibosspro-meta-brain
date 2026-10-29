// Content engine and the WhatsApp default-mode setting. Stub dispatchers only.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { bandSvg, composite, SIZES } from "./composite";
import { decideCreative, generateCreative, scenePrompt } from "./creative";
import { findOffer, listOffers } from "./offers";
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
function stub(opts: { segment?: string | null; image?: "ok" | "fail"; captions?: string[] }): Dispatcher & { calls: ModelCall[] } {
  const captions = [...(opts.captions ?? ["Cut plus beard is ₪102 every Tuesday. Book your chair today."])];
  const d = {
    calls: [] as ModelCall[],
    async dispatch(call: ModelCall): Promise<DispatchResult> {
      d.calls.push(call);
      if (call.kind === "segment") return { ok: true, status: 200, retryable: false, units: { kind: "segment", images: 1 }, output: opts.segment ?? undefined };
      if (call.kind === "image") {
        if (opts.image === "fail") return { ok: false, status: 500, retryable: false, units: null, errorBody: "boom" };
        const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#8a5a3b" } }).png().toBuffer();
        return { ok: true, status: 200, retryable: false, units: { kind: "image", images: 1 }, output: png.toString("base64") };
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
      expect(svg).toContain(">₪102<");
      expect(svg).toContain(">Cut plus beard · 15% off · Tuesdays<");
      expect(svg).toContain(">CEDAR STREET BARBERS<");
      const subject = await sharp({ create: { width: 200, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
      const png = await composite({ scene: null, brandColor: "#223344", subject, subjectKind: "cutout", band }, size);
      expect(await sharp(png).metadata()).toMatchObject({ width: SIZES[size].w, height: SIZES[size].h, format: "png" });
    }
    // The scene prompt never carries the price or text instructions to draw it.
    const prompt = scenePrompt(CEDAR, offer);
    expect(prompt).not.toMatch(/₪|102|120|Cedar/);
    expect(prompt).toContain("No words, no letters, no numbers, no logos, no signs, no people");
  });
});

describe("caption verification", () => {
  const offer = findOffer(CEDAR, OFFER_ID)!;
  it("a wrong price fails; the Tuesday discount for the Tuesday offer passes", () => {
    expect(verifyCaption("Cut plus beard for ₪99 this Tuesday. Book now.", CEDAR, offer).pass).toBe(false);
    expect(verifyCaption("Cut plus beard is ₪102 every Tuesday. Book your chair today.", CEDAR, offer).pass).toBe(true);
    expect(verifyCaption("Cut plus beard, 15% off on Tuesdays. Book your chair today.", CEDAR, offer).pass).toBe(true);
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

  it("fall back to a framed original and a flat colour, still producing both images; a caption failing twice is left empty", async () => {
    const store = await cedarStore();
    const d = stub({ segment: "I found a counter.", image: "fail", captions: ["Cut plus beard ₪99. Book now.", "Still ₪99 on Tuesdays. Book."] });
    const c = await generateCreative(deps(store, d), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, mediaDir: dir() });
    expect(c).toMatchObject({ cutoutKind: "unavailable", sceneKind: "flat", caption: "" });
    expect(c.media).toMatchObject({ cutout: null, scene: null });
    expect(c.diagnostics).toMatchObject({ cutout: { format: "unrecognised", kind: "unavailable" }, scene: { outcome: "failed" } });
    expect(c.captionLog).toMatchObject({ final: "empty" });
    expect((c.captionLog as { attempts: unknown[] }).attempts).toHaveLength(2);
    expect(await sharp(c.media.feed).metadata()).toMatchObject({ width: 1080, height: 1080 });
    expect(await sharp(c.media.story).metadata()).toMatchObject({ width: 1080, height: 1920 });
  });

  it("with no model available at all, both images are still produced", async () => {
    const store = await cedarStore();
    const c = await generateCreative(deps(store, null), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, mediaDir: dir() });
    expect(c).toMatchObject({ cutoutKind: "unavailable", sceneKind: "flat", caption: "" });
    expect(existsSync(c.media.feed) && existsSync(c.media.story)).toBe(true);
  });

  it("the media route serves a creative's images by the creative id", async () => {
    const store = await cedarStore();
    const storageDir = dir();
    vi.stubEnv("STORAGE_DIR", storageDir);
    vi.doMock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("../storage")>()), getStore: async () => store }));
    const c = await generateCreative(deps(store, null), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, mediaDir: join(storageDir, "media") });
    const { GET } = await import("@/app/api/content/[id]/media/[file]/route");
    const get = (file: string, id = c.id) => GET(new Request("http://local"), { params: Promise.resolve({ id, file }) });
    const feed = await get("feed.png");
    expect(feed.status).toBe(200);
    expect(await sharp(Buffer.from(await feed.arrayBuffer())).metadata()).toMatchObject({ width: 1080, height: 1080 });
    expect((await get("story.png")).status).toBe(200);
    expect((await get("cutout.png")).status).toBe(404); // no cutout in this fallback creative
    expect((await get("../../meta-brain.sqlite")).status).toBe(404);
    expect((await get("feed.png", "not-a-creative")).status).toBe(404);
    vi.doUnmock("@/lib/storage");
    vi.unstubAllEnvs();
  });

  it("an empty caption reply (reasoning used the budget) gets the second attempt", async () => {
    const store = await cedarStore();
    const d = stub({ segment: null, captions: ["", "Cut plus beard is ₪102 every Tuesday. Book your chair today."] });
    const c = await generateCreative(deps(store, d), { businessId: SEED_BUSINESS_ID, photo: await testPhoto(), offerId: OFFER_ID, mediaDir: dir() });
    expect(c.caption).toBe("Cut plus beard is ₪102 every Tuesday. Book your chair today.");
    expect((c.captionLog as { attempts: Array<{ checks: Array<{ claim: string }> }> }).attempts[0].checks[0].claim).toBe("empty caption");
    expect(d.calls.filter((x) => x.kind === "chat").every((x) => x.kind === "chat" && x.maxOutputTokens === 2_048)).toBe(true);
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
