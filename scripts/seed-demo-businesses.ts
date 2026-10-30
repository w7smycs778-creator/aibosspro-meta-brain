// Adds the three extra demo businesses (Tel Aviv pilates, Miami detailing,
// Montreal physio) next to Cedar Street Barbers on the LOCAL store. Idempotent:
// an approved brain equal to the seed is left alone. No model calls.
// Run: npm run seed:demo-businesses   (STORAGE_DIR or ./data)
import { resolveBackend } from "../src/lib/storage";
import { LocalStore } from "../src/lib/storage/local-store";
import { DEFAULT_LOCAL_DIR } from "../src/lib/storage";
import { seedDemoBusinesses } from "../src/lib/storage/seed-demo";

async function main() {
  if (resolveBackend() !== "local") throw new Error("STORAGE_BACKEND must be local; this script never touches Supabase");
  const store = LocalStore.open(process.env.STORAGE_DIR?.trim() || DEFAULT_LOCAL_DIR);
  for (const r of await seedDemoBusinesses(store)) console.log(`${r.id}: ${r.name}, approved brain v${r.version}${r.added ? " (added)" : " (unchanged)"}`);
  await store.close();
}

main().catch((err) => {
  console.error(`seed:demo-businesses failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
