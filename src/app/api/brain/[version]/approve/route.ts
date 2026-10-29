import { getStore } from "@/lib/storage";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";
import type { BusinessBrain } from "@/lib/storage/types";
import { errorResponse, json, ownerOnly, readJson } from "@/lib/engine/http";
import { approveDraft } from "@/lib/engine/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approves a draft, optionally with final edits: { brain? }. The engine uses it from the next message. */
export async function POST(req: Request, { params }: { params: Promise<{ version: string }> }): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const version = Number((await params).version);
  if (!Number.isInteger(version)) return json({ error: "version is required" }, 400);
  const brain = (await readJson(req))?.brain as BusinessBrain | undefined;
  try {
    return json({ version: await approveDraft(await getStore(), SEED_BUSINESS_ID, version, brain) });
  } catch (err) {
    return errorResponse(err);
  }
}
