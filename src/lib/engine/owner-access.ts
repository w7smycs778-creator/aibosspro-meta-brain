// Owner access on a hosted deploy. OWNER_ACCESS_TOKEN unset: local only, as
// before (Vercel answers 404). Set: a request on Vercel also passes with the
// owner cookie (set by src/proxy.ts from /owner?token=...) or an
// Authorization bearer. Local dev passes without either.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Env } from "../gateway/types";

export const OWNER_COOKIE = "owner_access";
/** 30 days; the owner opens /owner?token=... again after that. */
export const OWNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function ownerToken(env: Env = process.env): string | null {
  return env.OWNER_ACCESS_TOKEN?.trim() || null;
}

/** The cookie holds a hash of the token, never the token itself. */
export function ownerCookieValue(token: string): string {
  return createHash("sha256").update(`owner:${token}`).digest("hex");
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when the given token equals OWNER_ACCESS_TOKEN (false when unset). */
export function tokenMatches(given: string | null | undefined, env: Env = process.env): boolean {
  const token = ownerToken(env);
  return !!token && typeof given === "string" && sameText(given.trim(), token);
}

export type OwnerCredentials = { cookie?: string | null; authorization?: string | null };

export function ownerAllowed(creds: OwnerCredentials = {}, env: Env = process.env): boolean {
  if (!env.VERCEL) return true;
  const token = ownerToken(env);
  if (!token) return false;
  if (creds.cookie && sameText(creds.cookie, ownerCookieValue(token))) return true;
  const bearer = creds.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return tokenMatches(bearer, env);
}

/** Reads the owner cookie out of a Cookie header. */
export function cookieFrom(header: string | null | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === OWNER_COOKIE) return rest.join("=") || null;
  }
  return null;
}

export function requestAllowed(req: Request, env: Env = process.env): boolean {
  return ownerAllowed({ cookie: cookieFrom(req.headers.get("cookie")), authorization: req.headers.get("authorization") }, env);
}
