// Seeds the hosted demo into Supabase: wipes business data (the store's
// reset: businesses and everything under them), then adds the Cedar Street
// Barbers brain as the approved version. The spend ledger and processed-event
// ids are never touched; the ledger row count is printed before and after.
// Run (after the migrations are applied):
//   npm run store:reset:supabase -- --ref=<project-ref> --yes
import { CEDAR_BRAIN } from "../src/lib/storage/seed-cedar";
import { SEED_BUSINESS_ID } from "../src/lib/storage/seed";
import { SupabaseStore } from "../src/lib/storage/supabase-store";

/** Projects this script must never write to (CRM and another client). */
const FORBIDDEN_REFS = new Set(["rjlaejmmxjmgstsnthjc", "gjkjkmkulajtpcfeupnx"]);

function fail(message: string): never {
  console.error(`store:reset:supabase refused: ${message}`);
  process.exit(1);
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=") as [string, string]));
  const ref = process.env.SUPABASE_URL?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/)?.[1];
  if (!ref) fail("SUPABASE_URL is not https://<ref>.supabase.co");
  if (FORBIDDEN_REFS.has(ref)) fail(`project ${ref} is not the meta-brain project`);
  if (args.get("ref") !== ref) fail(`pass --ref=${ref} to confirm the target project`);
  if (!args.has("yes")) fail("pass --yes to wipe business data and seed the demo brain");

  const store = SupabaseStore.fromEnv();
  await store.ping().catch((err) => fail(`the ledger table is not reachable (are the migrations applied?): ${(err as Error).message}`));
  const ledgerBefore = (await store.listSpend()).length;

  const { businessId } = await store.reset();
  const draft = await store.addBrainVersion(businessId, CEDAR_BRAIN, { kind: "seed", text: null, audioPath: null });
  const approved = await store.approveBrainVersion(businessId, draft.version);
  const business = await store.getBusiness(SEED_BUSINESS_ID);

  console.log(`project ${ref}: business ${business?.id} (WhatsApp default ${business?.whatsappDefaultMode})`);
  console.log(`approved brain v${approved.version}: ${approved.brain.name}, ${approved.brain.timezone}, ${approved.brain.services.length} services, ${approved.brain.discounts.length} discount rule`);
  console.log(`ledger rows before/after: ${ledgerBefore}/${(await store.listSpend()).length}`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
