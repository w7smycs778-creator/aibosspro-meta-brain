import { afterEach, describe, expect, it } from "vitest";
import { LocalStore } from "./storage/local-store";
import { SEED_BRAIN, SEED_BUSINESS_ID } from "./storage/seed";
import { whatsappBusinessWarning } from "./startup";

const stores: LocalStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function seeded(): Promise<LocalStore> {
  const s = LocalStore.memory();
  stores.push(s);
  await s.reset(SEED_BRAIN);
  return s;
}

describe("startup: WhatsApp business check", () => {
  it("no warning when WHATSAPP_BUSINESS_ID (or the seed default) has an approved brain", async () => {
    const s = await seeded();
    expect(await whatsappBusinessWarning(s, { WHATSAPP_BUSINESS_ID: SEED_BUSINESS_ID })).toBeNull();
    expect(await whatsappBusinessWarning(s, {})).toBeNull();
  });

  it("warns, without the value, when the id names no business", async () => {
    const s = await seeded();
    const w = await whatsappBusinessWarning(s, { WHATSAPP_BUSINESS_ID: "b" });
    expect(w).toMatch(/WHATSAPP_BUSINESS_ID does not resolve to a business with an approved brain/);
    expect(w).toContain("length 1");
    expect(w).not.toMatch(/\bb\b/);
  });

  it("warns when the business exists but has no approved brain", async () => {
    const s = await seeded();
    await s.ensureBusiness({ id: "biz_draft_only", name: "Draft only" });
    await s.addBrainVersion("biz_draft_only", SEED_BRAIN);
    expect(await whatsappBusinessWarning(s, { WHATSAPP_BUSINESS_ID: "biz_draft_only" })).toMatch(/approved brain/);
  });
});
