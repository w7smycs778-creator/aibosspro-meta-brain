import { getStore } from "@/lib/storage";
import { SEED_BUSINESS_ID } from "@/lib/storage/seed";
import type { BusinessBrain } from "@/lib/storage/types";
import { errorResponse, json, ownerOnly, readJson } from "@/lib/engine/http";
import { discardDraft, saveDraftEdits } from "@/lib/engine/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ version: string }> };

/** Saves owner edits to a draft: { brain }. */
export async function PUT(req: Request, { params }: Params): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const version = Number((await params).version);
  const brain = (await readJson(req))?.brain as BusinessBrain | undefined;
  if (!Number.isInteger(version) || !brain) return json({ error: "version and brain are required" }, 400);
  try {
    return json({ version: await saveDraftEdits(await getStore(), SEED_BUSINESS_ID, version, brain) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Discards a draft. */
export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const version = Number((await params).version);
  if (!Number.isInteger(version)) return json({ error: "version is required" }, 400);
  try {
    await discardDraft(await getStore(), SEED_BUSINESS_ID, version);
    return json({ discarded: version });
  } catch (err) {
    return errorResponse(err);
  }
}
