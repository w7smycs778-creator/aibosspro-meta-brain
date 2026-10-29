// Wipes business data on the configured backend and reseeds the synthetic
// business. The spend ledger and processed-event ids are kept.
// Run: npm run store:reset
import { createStore, resolveBackend } from "../src/lib/storage";

async function main() {
  const store = await createStore();
  const { businessId } = await store.reset();
  console.log(`reset ${resolveBackend()} store: seeded ${businessId}`);
  await store.close();
}

main().catch((err) => {
  console.error(`store:reset failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
