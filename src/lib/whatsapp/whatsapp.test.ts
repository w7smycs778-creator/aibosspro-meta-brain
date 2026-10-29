import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";
import { verifySignature } from "./signature";

// after() needs a Next request scope; tests collect the callbacks and run them.
const pending: Array<() => unknown> = [];
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void pending.push(fn) }));

// The engine is mocked here; it has its own tests. Sending goes through the real sender with fetch mocked.
const engine = vi.hoisted(() => ({ handleInbound: vi.fn() }));
vi.mock("@/lib/engine/conversation-service", () => engine);
const ENGINE_REPLY = "[AI assistant] Synthetic engine reply.";

// Durable dedupe writes to a throwaway local store.
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "meta-brain-wa-"));

const { GET, POST } = await import("@/app/api/whatsapp/webhook/route");

// Synthetic values only.
const APP_SECRET = "test-app-secret-0123456789abcdef";
const VERIFY_TOKEN = "test-verify-token-0123456789abcd";
const ACCESS_TOKEN = "test-access-token";
const PHONE_ID = "100000000000001";
const URL_BASE = "https://example.test/api/whatsapp/webhook";

const sign = (body: string, secret = APP_SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

function textEvent(id: string, text = "hello", from = "15550001234") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "200000000000002",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: PHONE_ID },
          messages: [{ id, from, timestamp: "1761600000", type: "text", text: { body: text } }],
        },
      }],
    }],
  });
}

function post(body: string, signature: string | null = sign(body)) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== null) headers["X-Hub-Signature-256"] = signature;
  return POST(new Request(URL_BASE, { method: "POST", headers, body }));
}

async function flush() {
  while (pending.length) await pending.shift()!();
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pending.length = 0;
  vi.stubEnv("META_APP_SECRET", APP_SECRET);
  vi.stubEnv("WHATSAPP_VERIFY_TOKEN", VERIFY_TOKEN);
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", ACCESS_TOKEN);
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PHONE_ID);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  engine.handleInbound.mockReset();
  engine.handleInbound.mockResolvedValue({ replyText: ENGINE_REPLY, outcome: "final" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("verifySignature", () => {
  it("accepts a valid signature over the raw body", () => {
    const body = textEvent("wamid.sig1");
    expect(verifySignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = textEvent("wamid.sig2");
    expect(verifySignature(body.replace("hello", "hellp"), sign(body), APP_SECRET)).toBe(false);
  });

  it("rejects a missing or malformed header and a missing secret", () => {
    const body = textEvent("wamid.sig3");
    expect(verifySignature(body, null, APP_SECRET)).toBe(false);
    expect(verifySignature(body, "sha256=zz", APP_SECRET)).toBe(false);
    expect(verifySignature(body, sign(body), undefined)).toBe(false);
  });
});

describe("GET handshake", () => {
  const get = (token: string) =>
    GET(new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`));

  it("echoes the challenge as plain text on a matching token", async () => {
    const res = get(VERIFY_TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toBe("1158201444");
  });

  it("returns 403 on a wrong verify token", () => {
    expect(get("wrong-token").status).toBe(403);
  });
});

describe("POST events", () => {
  it("returns 401 on a missing signature header and sends nothing", async () => {
    const res = await post(textEvent("wamid.p1"), null);
    expect(res.status).toBe(401);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 on a tampered body", async () => {
    const body = textEvent("wamid.p2");
    const res = await POST(new Request(URL_BASE, {
      method: "POST",
      headers: { "X-Hub-Signature-256": sign(body) },
      body: body.replace("hello", "hellp"),
    }));
    expect(res.status).toBe(401);
  });

  it("passes the message to handleInbound; the engine, not the route, sends the reply", async () => {
    const res = await post(textEvent("wamid.p3", "Do you have Thursday 10:00?"));
    expect(res.status).toBe(200);
    await flush();
    expect(engine.handleInbound).toHaveBeenCalledTimes(1);
    expect(engine.handleInbound).toHaveBeenCalledWith({
      businessId: SEED_BUSINESS_ID,
      channel: "whatsapp",
      externalConversationId: "15550001234",
      senderId: "15550001234",
      text: "Do you have Thursday 10:00?",
      externalEventId: "wamid.p3",
    });
    // Delivery happens inside handleInbound (mocked here), after its last takeover check.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when the engine has no reply", async () => {
    engine.handleInbound.mockResolvedValue({ replyText: null, outcome: "not_active" });
    expect((await post(textEvent("wamid.p4"))).status).toBe(200);
    await flush();
    expect(engine.handleInbound).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replies once to a duplicate message id", async () => {
    const body = textEvent("wamid.dup");
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    await flush();
    expect(engine.handleInbound).toHaveBeenCalledTimes(1);
  });

  it("ignores status updates and non-text messages", async () => {
    const statuses = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.s", status: "read" }] } }] }],
    });
    const image = textEvent("wamid.img").replace('"type":"text"', '"type":"image"');
    expect((await post(statuses)).status).toBe(200);
    expect((await post(image)).status).toBe(200);
    await flush();
    expect(engine.handleInbound).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
