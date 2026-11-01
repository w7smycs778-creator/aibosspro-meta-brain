import { describe, expect, it, vi } from "vitest";
import { recordingFetch, replayFetch, ReplayMismatchError, type Exchange } from "./recorder";

const body = (bookingId: string) => JSON.stringify({ model: "m", messages: [{ role: "tool", content: JSON.stringify({ bookingId }) }] });

describe("demo recorder", () => {
  it("records path, parsed request, response, headers (no cookies), latency and request id; never request headers", async () => {
    const inner = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "x-request-id": "req_1", "set-cookie": "s=1" } }));
    const seen: Exchange[] = [];
    const f = recordingFetch(inner as unknown as typeof fetch, (e) => seen.push(e));
    const res = await f("https://api.example/v1/chat/completions", { method: "POST", headers: { Authorization: "secret-header" }, body: body("11111111-1111-1111-1111-111111111111") });
    expect(await res.json()).toEqual({ ok: 1 });
    expect(seen[0]).toMatchObject({ seq: 1, path: "/v1/chat/completions", providerRequestId: "req_1", response: { status: 200 } });
    expect(seen[0].response!.headers).not.toHaveProperty("set-cookie");
    expect(JSON.stringify(seen[0])).not.toContain("secret-header");
    expect(seen[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("replays in order, matching requests with random ids normalized, and refuses a changed request", async () => {
    const seen: Exchange[] = [];
    const rec = recordingFetch((async () => new Response("{\"a\":1}", { status: 200 })) as unknown as typeof fetch, (e) => seen.push(e));
    await rec("https://api.example/v1/chat/completions", { method: "POST", body: body("11111111-1111-1111-1111-111111111111") });

    const replay = replayFetch(seen);
    const r = await replay("https://replay.invalid/v1/chat/completions", { method: "POST", body: body("22222222-2222-2222-2222-222222222222") });
    expect(await r.text()).toBe("{\"a\":1}");
    expect(replay.remaining()).toBe(0);
    await expect(replay("https://replay.invalid/v1/chat/completions", { method: "POST", body: body("x") })).rejects.toBeInstanceOf(ReplayMismatchError);

    const changed = replayFetch(seen);
    await expect(changed("https://replay.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) })).rejects.toThrow(/differs from the recording/);
  });
});
