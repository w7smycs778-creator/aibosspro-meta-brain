// Adds Hebrew to the approved brain on the configured store: a new version
// with languages English + Hebrew and the Cedar Street Hebrew service names
// (matched by service id), approved. No model calls. Prints what changed.
// Run: STORAGE_BACKEND=local npx tsx scripts/brain-add-hebrew.ts
import { createStore, SEED_BUSINESS_ID } from "../src/lib/storage";
import { CEDAR_BRAIN } from "../src/lib/storage/seed-cedar";

async function main() {
  const store = await createStore();
  const current = await store.getBrain(SEED_BUSINESS_ID, { approvedOnly: true });
  if (!current) throw new Error("no approved brain");
  const hebrew = new Map(CEDAR_BRAIN.services.map((s) => [s.id, s.localNames]));
  const brain = {
    ...current.brain,
    languages: ["English", "Hebrew"],
    services: current.brain.services.map((s) => ({ ...s, ...(hebrew.get(s.id) && { localNames: hebrew.get(s.id) }) })),
  };
  const draft = await store.addBrainVersion(SEED_BUSINESS_ID, brain, { kind: "seed", text: "Hebrew languages and service names added (night run 2026-10-29)", audioPath: null });
  const approved = await store.approveBrainVersion(SEED_BUSINESS_ID, draft.version);
  console.log(`v${current.version} -> approved v${approved.version}: ${approved.brain.name}, languages ${JSON.stringify(approved.brain.languages)}`);
  for (const s of approved.brain.services) console.log(`  ${s.id}: ${s.name} / ${s.localNames?.he ?? "(no Hebrew name)"}`);
  await store.close();
}

main().catch((err) => {
  console.error(`brain-add-hebrew failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
