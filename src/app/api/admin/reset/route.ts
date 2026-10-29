import { getStore } from "@/lib/storage";
import { json, ownerOnly } from "@/lib/engine/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wipes business data and reseeds the one synthetic business. The spend ledger is kept. */
export async function POST(): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const store = await getStore();
  return json(await store.reset());
}
