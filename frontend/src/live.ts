import { useEffect, useRef } from "react";
import { api, getToken } from "./api";

// Live updates (live.py): one shared watcher asks the server every ~2 s whether
// friends, groups or money changed, and tells subscribed pages to reload.
// So when User A creates a goal, User B's open Groups page updates by itself.

export type Topic = "friends" | "groups" | "money";
type Versions = { boot: number } & Record<Topic, number>;

const POLL_MS = 2000;
const listeners = new Set<{ topics: Topic[]; fn: () => void }>();
let last: Versions | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;

async function check() {
  if (document.visibilityState === "visible" && getToken()) {
    try {
      const v = await api<Versions>("GET", "/api/live");
      if (last) {
        const restarted = v.boot !== last.boot;
        const changed = (["friends", "groups", "money"] as Topic[]).filter((t) => restarted || v[t] !== last![t]);
        if (changed.length) listeners.forEach((l) => l.topics.some((t) => changed.includes(t)) && l.fn());
      }
      last = v;
    } catch {
      /* offline for a moment: try again next round */
    }
  }
  timer = setTimeout(check, POLL_MS);
}

function start() {
  if (running) return;
  running = true;
  check();
  // Coming back to the tab: check right away instead of waiting.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && (clearTimeout(timer), check()));
}

/** Call `onChange` whenever another user (or you, in another tab) changes one of these topics. */
export function useLive(topics: Topic[], onChange: () => void) {
  const fn = useRef(onChange);
  fn.current = onChange;
  const key = topics.join(",");
  useEffect(() => {
    start();
    const entry = { topics: key.split(",") as Topic[], fn: () => fn.current() };
    listeners.add(entry);
    return () => {
      listeners.delete(entry);
    };
  }, [key]);
}
