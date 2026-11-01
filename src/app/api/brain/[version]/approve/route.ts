import { getStore } from "@/lib/storage";
import type { BusinessBrain } from "@/lib/storage/types";
import { errorResponse, json, ownerOnly, readJson, requireBusiness } from "@/lib/engine/http";
import { approveDraft } from "@/lib/engine/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ?business=<id>: approves that business's draft, optionally with final edits: { brain? }. The engine uses it from the next message. */
export async function POST(req: Request, { params }: { params: Promise<{ version: string }> }): Promise<Response> {
  const blocked = ownerOnly(req);
  if (blocked) return blocked;
  const store = await getStore();
  const businessId = await requireBusiness(store, req);
  if (businessId instanceof Response) return businessId;
  const version = Number((await params).version);
  if (!Number.isInteger(version)) return json({ error: "version is required" }, 400);
  const brain = (await readJson(req))?.brain as BusinessBrain | undefined;
  try {
    return json({ version: await approveDraft(store, businessId, version, brain) });
  } catch (err) {
    return errorResponse(err);
  }
}
