// Resets the LOCAL store to a clean demo: business data wiped (conversations,
// bookings, approvals, creatives, brain versions), Cedar Street Barbers seeded
// as approved brain v1 plus the three other demo businesses, the spend ledger
// and processed-event ids kept. The
// database is backed up next to itself first. Files under media/ and audio/
// are left in place. Local backend only.
// Run: npm run demo:reset -- --yes            (STORAGE_DIR or ./data)
//      npm run demo:reset -- --if-missing      (seed only when no database exists yet)
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_LOCAL_DIR, resolveBackend, SEED_BUSINESS_ID } from "../src/lib/storage";
import { LOCAL_DB_FILE, LocalStore } from "../src/lib/storage/local-store";
import { CEDAR_BRAIN } from "../src/lib/storage/seed-cedar";
import { seedDemoBusinesses } from "../src/lib/storage/seed-demo";

function fail(message: string): never {
  console.error(`demo:reset refused: ${message}`);
  process.exit(1);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (resolveBackend() !== "local") fail("STORAGE_BACKEND must be local; this script never touches Supabase");
  const dir = resolve(process.env.STORAGE_DIR?.trim() || DEFAULT_LOCAL_DIR);
  const file = join(dir, LOCAL_DB_FILE);
  const exists = existsSync(file);
  if (args.has("--if-missing") && exists) {
    console.log(`demo:reset: ${file} exists, kept as is (run npm run demo:reset -- --yes to start clean)`);
    return;
  }
  if (exists && !args.has("--yes") && !args.has("--if-missing")) fail(`pass --yes to wipe the business data in ${file}`);

  const store = LocalStore.open(dir);
  if (exists) {
    const backup = join(dir, `meta-brain.pre-demo-reset-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
    await store.backup(backup);
    console.log(`backup: ${backup}`);
  }
  const ledgerBefore = (await store.listSpend()).length;
  await store.reset(CEDAR_BRAIN);
  for (const r of await seedDemoBusinesses(store)) console.log(`seeded ${r.id}: ${r.name} v${r.version}`);
  const brain = await store.getBrain(SEED_BUSINESS_ID, { approvedOnly: true });
  const conversations = await store.listConversations(SEED_BUSINESS_ID);
  const bookings = await store.listBookings(SEED_BUSINESS_ID);
  const creatives = await store.listCreatives(SEED_BUSINESS_ID);
  console.log(`store ${dir}: approved brain v${brain?.version} ${brain?.brain.name} (${brain?.brain.languages.join(", ")})`);
  console.log(`conversations ${conversations.length}, bookings ${bookings.length}, creatives ${creatives.length}, ledger rows before/after ${ledgerBefore}/${(await store.listSpend()).length}`);
  await store.close();
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
