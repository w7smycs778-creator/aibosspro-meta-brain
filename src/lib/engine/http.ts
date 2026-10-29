import type { Storage } from "../storage/types";
import { SEED_BUSINESS_ID } from "../storage/seed";
import { ownerScreenAllowed } from "./deps";

/** 404 on a hosted deploy: the owner screen and its APIs have no auth yet. */
export function ownerOnly(): Response | null {
  return ownerScreenAllowed() ? null : new Response("Not Found", { status: 404 });
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Maps an OnboardingError (or any error with a numeric status) to a JSON response. */
export function errorResponse(err: unknown): Response {
  const e = err as { message?: string; status?: unknown; details?: Record<string, unknown> };
  if (typeof e?.status === "number") return json({ error: e.message, ...(e.details ?? {}) }, e.status);
  return json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

/**
 * The business an owner-screen request is about: the given id (query
 * ?business= or a body field), else the original demo business. A 404
 * response when no such business exists.
 */
export async function resolveBusiness(store: Storage, id: unknown): Promise<string | Response> {
  const businessId = typeof id === "string" && id.trim() ? id.trim() : SEED_BUSINESS_ID;
  return (await store.getBusiness(businessId)) ? businessId : json({ error: `unknown business ${businessId}` }, 404);
}
