import { getStore } from "@/lib/storage";
import { CEDAR_BRAIN } from "@/lib/storage/seed-cedar";
import { seedDemoBusinesses } from "@/lib/storage/seed-demo";
import { json, ownerOnly } from "@/lib/engine/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wipes business data and reseeds the four demo businesses (Cedar Street first). The spend ledger is kept. */
export async function POST(): Promise<Response> {
  const blocked = ownerOnly();
  if (blocked) return blocked;
  const store = await getStore();
  const { businessId } = await store.reset(CEDAR_BRAIN);
  return json({ businessId, seeded: await seedDemoBusinesses(store) });
}
