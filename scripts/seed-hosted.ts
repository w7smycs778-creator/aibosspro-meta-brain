// Aligns the hosted (Supabase) demo data with the repo seed: Cedar Street
// Barbers gets its business name and a new approved brain from CEDAR_BRAIN
// (English + Hebrew), and the three other demo businesses are added with
// seedDemoBusinesses. No model calls.
// Dry run (default): prints the row changes, then rehearses them twice on an
// in-memory copy of the hosted rows; the second pass must change nothing.
// --apply: writes to Supabase, re-reads the rows and prints them.
// Run: STORAGE_BACKEND=supabase npx tsx --env-file=.env scripts/seed-hosted.ts [--apply]
import { createStore, resolveBackend, SEED_BUSINESS_ID } from "../src/lib/storage";
import { upgradeBrain } from "../src/lib/storage/brain";
import { LocalStore } from "../src/lib/storage/local-store";
import { CEDAR_BRAIN } from "../src/lib/storage/seed-cedar";
import { DEMO_BUSINESSES, seedDemoBusinesses } from "../src/lib/storage/seed-demo";
import type { BusinessBrain, Storage } from "../src/lib/storage/types";

const same = (a: BusinessBrain, b: BusinessBrain) => JSON.stringify(upgradeBrain(a)) === JSON.stringify(upgradeBrain(b));

/** The changes apply() would make, one line each; empty when the store already matches. */
async function plan(store: Storage): Promise<string[]> {
  const out: string[] = [];
  const cedar = await store.getBusiness(SEED_BUSINESS_ID);
  if (!cedar) throw new Error(`${SEED_BUSINESS_ID} not found; this script does not create it`);
  if (cedar.name !== CEDAR_BRAIN.name) out.push(`businesses ${SEED_BUSINESS_ID}: name "${cedar.name}" -> "${CEDAR_BRAIN.name}"`);
  const versions = await store.listBrainVersions(SEED_BUSINESS_ID);
  const approved = await store.getBrain(SEED_BUSINESS_ID, { approvedOnly: true });
  if (!approved || !same(approved.brain, CEDAR_BRAIN)) {
    const next = (versions[0]?.version ?? 0) + 1;
    out.push(`brain_versions ${SEED_BUSINESS_ID}: insert v${next} "${CEDAR_BRAIN.name}" languages ${JSON.stringify(CEDAR_BRAIN.languages)}, approved (was v${approved?.version ?? "-"} ${JSON.stringify(approved?.brain.languages ?? null)})`);
    if (approved) {
      const a = upgradeBrain(approved.brain) as Record<string, unknown>;
      const b = upgradeBrain(CEDAR_BRAIN) as Record<string, unknown>;
      const fields = Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      out.push(`  fields that change: ${fields.join(", ")}`);
    }
  }
  for (const { id, brain } of DEMO_BUSINESSES.slice(1)) {
    const current = await store.getBrain(id, { approvedOnly: true });
    if (!(await store.getBusiness(id))) out.push(`businesses ${id}: insert "${brain.name}", whatsapp_default_mode AUTO`);
    if (!current || !same(current.brain, brain)) {
      const next = ((await store.listBrainVersions(id))[0]?.version ?? 0) + 1;
      out.push(`brain_versions ${id}: insert v${next} "${brain.name}" languages ${JSON.stringify(brain.languages)}, ${brain.services.length} services, approved`);
    }
  }
  return out;
}

async function apply(store: Storage): Promise<void> {
  const cedar = await store.getBusiness(SEED_BUSINESS_ID);
  if (!cedar) throw new Error(`${SEED_BUSINESS_ID} not found`);
  if (cedar.name !== CEDAR_BRAIN.name) await store.updateBusinessSettings(SEED_BUSINESS_ID, { name: CEDAR_BRAIN.name });
  const approved = await store.getBrain(SEED_BUSINESS_ID, { approvedOnly: true });
  if (!approved || !same(approved.brain, CEDAR_BRAIN)) {
    const draft = await store.addBrainVersion(SEED_BUSINESS_ID, CEDAR_BRAIN, { kind: "seed", text: "Hosted seed aligned with CEDAR_BRAIN (English + Hebrew), 2026-11-01", audioPath: null });
    await store.approveBrainVersion(SEED_BUSINESS_ID, draft.version);
  }
  await seedDemoBusinesses(store);
}

type Snapshot = Array<{ id: string; name: string; mode: string; versions: Array<{ v: number; name: string; languages: string[]; approved: boolean; approvedAt: string | null }> }>;

async function snapshot(store: Storage): Promise<Snapshot> {
  const out: Snapshot = [];
  for (const b of await store.listBusinesses()) {
    const versions = (await store.listBrainVersions(b.id)).map((v) => ({ v: v.version, name: v.brain.name, languages: v.brain.languages, approved: v.approved, approvedAt: v.approvedAt }));
    out.push({ id: b.id, name: b.name, mode: b.whatsappDefaultMode, versions });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function print(snap: Snapshot, indent = "  ") {
  for (const b of snap) {
    console.log(`${indent}${b.id} "${b.name}" ${b.mode}`);
    for (const v of b.versions) console.log(`${indent}  v${v.v} "${v.name}" ${JSON.stringify(v.languages)} ${v.approved ? "approved" : "draft"}`);
  }
}

const rowCount = (s: Snapshot) => `${s.length} businesses, ${s.reduce((n, b) => n + b.versions.length, 0)} brain_versions`;

/** Copies the hosted businesses and brain versions (same version numbers) into a throwaway store. */
async function mirror(hosted: Storage): Promise<LocalStore> {
  const mem = LocalStore.memory();
  for (const b of await hosted.listBusinesses()) {
    await mem.ensureBusiness({ id: b.id, name: b.name, whatsappDefaultMode: b.whatsappDefaultMode });
    for (const v of (await hosted.listBrainVersions(b.id)).reverse()) {
      const added = await mem.addBrainVersion(b.id, v.brain, v.source ?? undefined);
      if (added.version !== v.version) throw new Error(`mirror ${b.id}: got v${added.version}, expected v${v.version}`);
      if (v.approved) await mem.approveBrainVersion(b.id, v.version);
    }
  }
  return mem;
}

/** Strips approvedAt: the mirror's approval times differ from the hosted ones. */
const shape = (s: Snapshot) => JSON.stringify(s.map((b) => ({ ...b, versions: b.versions.map(({ approvedAt: _, ...v }) => v) })));

async function rehearse(hosted: Storage, before: Snapshot): Promise<void> {
  const mem = await mirror(hosted);
  const start = await snapshot(mem);
  if (shape(start) !== shape(before)) throw new Error("rehearsal: the in-memory copy does not match the hosted rows");
  await apply(mem);
  const first = await snapshot(mem);
  const left = await plan(mem);
  await apply(mem);
  const second = await snapshot(mem);
  const cedar1 = first.find((b) => b.id === SEED_BUSINESS_ID)!.versions[0];
  const cedar2 = second.find((b) => b.id === SEED_BUSINESS_ID)!.versions[0];
  console.log(`\nREHEARSAL (in-memory copy of the hosted rows; Supabase untouched)`);
  console.log(`  before:       ${rowCount(start)}`);
  console.log(`  after pass 1: ${rowCount(first)}`);
  console.log(`  after pass 2: ${rowCount(second)}`);
  console.log(`  plan after pass 1: ${left.length ? left.join(" | ") : "no changes"}`);
  console.log(`  pass 2 identical to pass 1 (rows, versions, approval times): ${JSON.stringify(first) === JSON.stringify(second)}`);
  console.log(`  ${SEED_BUSINESS_ID} newest v${cedar2.v} approvedAt unchanged by pass 2: ${cedar1.v === cedar2.v && cedar1.approvedAt === cedar2.approvedAt}`);
  console.log(`  result after pass 1:`);
  print(first, "    ");
  await mem.close();
  if (left.length || JSON.stringify(first) !== JSON.stringify(second)) throw new Error("rehearsal: not idempotent");
}

async function main() {
  const live = process.argv.includes("--apply");
  if (resolveBackend() !== "supabase") throw new Error("STORAGE_BACKEND must be supabase; this script aligns the hosted store");
  const store = await createStore();
  const before = await snapshot(store);
  console.log(`HOSTED NOW: ${rowCount(before)}`);
  print(before);
  const changes = await plan(store);
  console.log(`\nCHANGES (${changes.length ? "to apply" : "none"}):`);
  for (const c of changes) console.log(`  ${c}`);
  console.log(`  env WHATSAPP_BUSINESS_ID=${SEED_BUSINESS_ID} (production; set by hand in B4, not by this script)`);
  if (!live) {
    await rehearse(store, before);
    console.log("\nDRY RUN: nothing written. Re-run with --apply to write.");
  } else {
    await apply(store);
    const after = await snapshot(store);
    console.log(`\nAPPLIED. HOSTED AFTER (re-read): ${rowCount(after)}`);
    print(after);
    const left = await plan(store);
    console.log(`plan after apply: ${left.length ? left.join(" | ") : "no changes"}`);
  }
  await store.close();
}

main().catch((err) => {
  console.error(`seed-hosted failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
