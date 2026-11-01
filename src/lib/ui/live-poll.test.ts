import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anyDirty, POLL_INTERVAL_MS, setDirty, shouldPoll, startPoller } from "./live-poll";

function harness(over: { visible?: boolean; poll?: () => Promise<unknown> } = {}) {
  let visible = over.visible ?? true;
  const listeners: Array<() => void> = [];
  const poll = vi.fn(over.poll ?? (async () => {}));
  const poller = startPoller({
    poll,
    isVisible: () => visible,
    onVisibilityChange: (cb) => {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
  });
  return {
    poll,
    poller,
    listeners,
    setVisible(v: boolean) {
      visible = v;
      for (const l of [...listeners]) l();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const k of ["a", "b", "panel", "reply:c1", "caption:x", "object"]) setDirty(k, false);
});

describe("shouldPoll", () => {
  it("polls only when the tab is visible, nothing is dirty and no request is in flight", () => {
    expect(shouldPoll({ visible: true, dirty: false, inFlight: false })).toBe(true);
    expect(shouldPoll({ visible: false, dirty: false, inFlight: false })).toBe(false);
    expect(shouldPoll({ visible: true, dirty: true, inFlight: false })).toBe(false);
    expect(shouldPoll({ visible: true, dirty: false, inFlight: true })).toBe(false);
  });
});

describe("dirty registry", () => {
  it("is dirty while any key holds unsaved text, page-wide", () => {
    expect(anyDirty()).toBe(false);
    setDirty("reply:c1", true);
    setDirty("caption:x", true);
    expect(anyDirty()).toBe(true);
    setDirty("reply:c1", false);
    expect(anyDirty()).toBe(true);
    setDirty("caption:x", false);
    expect(anyDirty()).toBe(false);
  });
});

describe("startPoller", () => {
  it("calls the poll once every 4 s while visible", async () => {
    const h = harness();
    expect(POLL_INTERVAL_MS).toBe(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.poll).toHaveBeenCalledTimes(3);
    h.poller.stop();
  });

  it("does not poll while hidden, and refreshes once immediately when the tab becomes visible", async () => {
    const h = harness({ visible: false });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.poll).not.toHaveBeenCalled();
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.poll).toHaveBeenCalledTimes(1);
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.poll).toHaveBeenCalledTimes(1);
    h.poller.stop();
  });

  it("pauses while any text is unsaved and resumes when it is cleared; a focused empty field does not pause", async () => {
    const h = harness();
    setDirty("panel", true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.poll).not.toHaveBeenCalled();
    setDirty("panel", false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.poll).toHaveBeenCalledTimes(1);
    // Focus is not part of the gate: only unsaved text is.
    h.poller.stop();
  });

  it("skips ticks while the previous request is in flight, then resumes", async () => {
    let release!: () => void;
    const h = harness({ poll: () => new Promise<void>((r) => (release = r)) });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.poll).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.poll).toHaveBeenCalledTimes(2);
    h.poller.stop();
  });

  it("ignores a failed poll and keeps polling", async () => {
    const h = harness({ poll: async () => Promise.reject(new Error("network")) });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.poll).toHaveBeenCalledTimes(2);
    h.poller.stop();
  });

  it("stop() clears the timer and the visibility listener", async () => {
    const h = harness();
    expect(h.listeners).toHaveLength(1);
    h.poller.stop();
    expect(h.listeners).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.poll).not.toHaveBeenCalled();
  });
});
