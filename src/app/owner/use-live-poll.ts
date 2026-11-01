"use client";

// React glue for src/lib/ui/live-poll.ts: one poller per component, started on
// mount and stopped on unmount, plus page-wide unsaved-text flags.
import { useEffect, useRef } from "react";
import { setDirty, startPoller } from "@/lib/ui/live-poll";

/** Calls poll every 4 s while the tab is visible and nothing on the page is unsaved. */
export function useLivePoll(poll: () => Promise<unknown>): void {
  const latest = useRef(poll);
  useEffect(() => {
    latest.current = poll;
  });
  useEffect(() => {
    const poller = startPoller({
      poll: () => latest.current(),
      isVisible: () => document.visibilityState === "visible",
      onVisibilityChange: (cb) => {
        document.addEventListener("visibilitychange", cb);
        return () => document.removeEventListener("visibilitychange", cb);
      },
    });
    return () => poller.stop();
  }, []);
}

/** Marks this key as holding unsaved text (pauses polling page-wide) while dirty is true. */
export function useDirty(key: string, dirty: boolean): void {
  useEffect(() => {
    setDirty(key, dirty);
    return () => setDirty(key, false);
  }, [key, dirty]);
}
