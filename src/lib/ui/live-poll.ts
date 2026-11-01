// Owner-page live refresh, framework-free so it can be tested without a DOM.
// A poll runs every 4 s only while the tab is visible, no text on the page is
// unsaved, and the previous request has settled. Focus alone never pauses it.
// A failed poll is ignored; the next tick tries again.

export const POLL_INTERVAL_MS = 4_000;

export type PollGate = { visible: boolean; dirty: boolean; inFlight: boolean };

export function shouldPoll(g: PollGate): boolean {
  return g.visible && !g.dirty && !g.inFlight;
}

/** Page-wide unsaved-text registry: any key set dirty pauses every poller on the page. */
const dirtyKeys = new Set<string>();

export function setDirty(key: string, dirty: boolean): void {
  if (dirty) dirtyKeys.add(key);
  else dirtyKeys.delete(key);
}

export function anyDirty(): boolean {
  return dirtyKeys.size > 0;
}

export type PollerDeps = {
  poll: () => Promise<unknown>;
  isVisible: () => boolean;
  /** Subscribes to visibility changes; returns the unsubscribe function. */
  onVisibilityChange: (cb: () => void) => () => void;
  intervalMs?: number;
};

export function startPoller(deps: PollerDeps): { stop(): void; tick(): Promise<void> } {
  let inFlight = false;
  const tick = async () => {
    if (!shouldPoll({ visible: deps.isVisible(), dirty: anyDirty(), inFlight })) return;
    inFlight = true;
    try {
      await deps.poll();
    } catch {
      // Ignored: the page keeps what it shows and the next tick retries.
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalMs ?? POLL_INTERVAL_MS);
  // Coming back to the tab refreshes at once instead of waiting for the next tick.
  const unsubscribe = deps.onVisibilityChange(() => {
    if (deps.isVisible()) void tick();
  });
  return {
    tick,
    stop() {
      clearInterval(timer);
      unsubscribe();
    },
  };
}
