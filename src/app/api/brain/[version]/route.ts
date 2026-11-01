import { getStore } from "@/lib/storage";
import type { BusinessBrain } from "@/lib/storage/types";
import { errorResponse, json, ownerOnly, readJson, requireBusiness } from "@/lib/engine/http";
import { discardDraft, saveDraftEdits } from "@/lib/engine/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ version: string }> };

/** ?business=<id>: saves owner edits to that business's draft: { brain }. */
export async function PUT(req: Request, { params }: Params): Promise<Response> {
  const blocked = ownerOnly(req);
  if (blocked) return blocked;
  const store = await getStore();
  const businessId = await requireBusiness(store, req);
  if (businessId instanceof Response) return businessId;
  const version = Number((await params).version);
  const brain = (await readJson(req))?.brain as BusinessBrain | undefined;
  if (!Number.isInteger(version) || !brain) return json({ error: "version and brain are required" }, 400);
  try {
    return json({ version: await saveDraftEdits(store, businessId, version, brain) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** ?business=<id>: discards that business's draft. */
export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  const blocked = ownerOnly(req);
  if (blocked) return blocked;
  const store = await getStore();
  const businessId = await requireBusiness(store, req);
  if (businessId instanceof Response) return businessId;
  const version = Number((await params).version);
  if (!Number.isInteger(version)) return json({ error: "version is required" }, 400);
  try {
    await discardDraft(store, businessId, version);
    return json({ discarded: version });
  } catch (err) {
    return errorResponse(err);
  }
}
