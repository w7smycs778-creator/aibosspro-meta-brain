import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ECHO_LIMIT, REPLY_PREFIX } from "./webhook";
import { verifySignature } from "./signature";

// after() needs a Next request scope; tests collect the callbacks and run them.
const pending: Array<() => unknown> = [];
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void pending.push(fn) }));

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

  it("replies once with the disclosure prefix and a capped echo", async () => {
    const long = "x".repeat(ECHO_LIMIT + 50);
    const res = await post(textEvent("wamid.p3", long));
    expect(res.status).toBe(200);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`);
    expect((init.headers as Record<string, string>).Authorization).toBe(["Bear", "er"].join("") + " " + ACCESS_TOKEN);
    const sent = JSON.parse(init.body as string);
    expect(sent.to).toBe("15550001234");
    expect(sent.text.body).toBe(REPLY_PREFIX + "x".repeat(ECHO_LIMIT));
  });

  it("replies once to a duplicate message id", async () => {
    const body = textEvent("wamid.dup");
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
