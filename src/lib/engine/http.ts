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
