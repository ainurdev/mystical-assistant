import { useSyncExternalStore } from "react";
import { api, type AiFeature } from "../api";

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
