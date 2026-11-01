import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { demoContext, loadFixture, openDemoStore, GOLDEN_CLOCK } from "./demo";
import { runGolden } from "./golden";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("golden scenario REPLAY", () => {
  it("reproduces the recorded run offline: every invariant holds and every recorded call is used", async () => {
    const fixture = loadFixture();
    expect(fixture, "fixtures/replay/golden.json").not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "meta-brain-golden-"));
    dirs.push(dir);
    const store = await openDemoStore(join(dir, "store"));
    const ctx = demoContext({ mode: "REPLAY", store, env: {}, fixture: fixture!, runCapUsd: 1, maxCalls: 40, clock: GOLDEN_CLOCK, traceDir: join(dir, "traces") });
    const inv = await runGolden(ctx, {}, () => {});
    await store.close();
    expect(inv.filter((i) => !i.pass)).toEqual([]);
    expect(inv.map((i) => i.name)).toContain("verifier blocked at least one reply");
  }, 60_000);
});
