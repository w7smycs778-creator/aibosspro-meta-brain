import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/**
 * Verifies Meta's X-Hub-Signature-256 header: "sha256=" + hex HMAC-SHA256 of
 * the raw request body keyed with the app secret. The body must be the exact
 * bytes received, before any JSON parsing. Fails closed on a missing secret,
 * a missing header or a malformed header.
 */
export function verifySignature(
  rawBody: Buffer | string,
  header: string | null | undefined,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !header || !header.startsWith(PREFIX)) return false;
  const given = header.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

/** Constant-time string compare; unequal lengths return false. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
