import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type AiFeature, type GraphInstall } from "../api";

/** Which model-spending extras are on, shared by everything that has to hide
 *  itself while its switch is off (the next-up board). One fetch, many readers —
 *  prop-drilling
 *  this through Terminal → Transcript → RunStream would touch four files to say
 *  one boolean. Unknown reads as off, so a feature's UI never flashes in before
 *  the bridge has answered. */

let snapshot: Record<string, boolean> = {};
let asked = false;
const subs = new Set<() => void>();

function publish(features: AiFeature[]): void {
  snapshot = Object.fromEntries(features.map((f) => [f.key, f.enabled]));
  subs.forEach((fn) => fn());
}

/** Re-read the switches. Call after anything that could flip one. */
export async function refreshAiFeatures(): Promise<void> {
  try {
    publish((await api.aiFeatures()).features);
  } catch {
    /* keep the last answer — a blip shouldn't blank the tabs */
  }
}

/** The settings panel already holds the fresh list its POST returned; handing it
 *  over saves a round-trip and switches the tabs in the same frame. */
export function setAiFeatures(features: AiFeature[]): void {
  asked = true;
  publish(features);
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!asked) {
    asked = true;
    void refreshAiFeatures();
  }
  return () => subs.delete(fn);
}

export function useAiFeatures(): Record<string, boolean> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** graphify, the tool PROJECT MAP runs on: is it on the bridge machine, and the
 *  install offered wherever a map switch would otherwise switch on nothing (the
 *  Extras card, a repo's Project map row, the MAP tab). The caller flips its own
 *  switch as Install is pressed, so a page closed mid-install still ends up on;
 *  this only follows the install, polling while one runs, even one another page
 *  started. `installed` is null until the bridge answers, and stays null on a
 *  bridge too old for the route, so callers keep drawing their switch. */
export function useGraphify() {
  const [st, setSt] = useState<GraphInstall | null>(null);
  const [gen, setGen] = useState(0);   // install() bumps it to follow the run it started
  useEffect(() => {
    let live = true;
    let t = 0;
    const read = () => void api.graphInstall()
      .then((s) => {
        if (!live) return;
        setSt(s);
        if (s.state === "running") t = window.setTimeout(read, 1500);
      })
      .catch(() => { /* an older bridge has no route: the switch stays as it was */ });
    read();
    return () => { live = false; window.clearTimeout(t); };
  }, [gen]);
  return {
    installed: st ? st.installed : null,
    installing: st?.state === "running",
    error: st?.state === "error" ? st.error ?? "" : "",
    install: () => {
      setSt({ installed: false, state: "running" });
      void api.installGraphify()
        .then(() => setGen((g) => g + 1))
        .catch((e: Error) => setSt({ installed: false, state: "error", error: e.message }));
    },
  };
}
