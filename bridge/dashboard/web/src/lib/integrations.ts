import { useSyncExternalStore } from "react";
import { api, type Integration } from "../api";

/** Which bundled integrations are installed (Rivendell, Claude Design), shared
 *  by everything that has to hide itself while its plugin isn't
 *  and stop calling routes that would 404 — the RIVENDELL poll above all. One
 *  fetch, many readers, the shape of lib/ai.ts. Unknown reads as off, so a
 *  plugin's UI never flashes in before the bridge has answered. */

let snapshot: Record<string, boolean> = {};
let asked = false;
const subs = new Set<() => void>();

function publish(next: Record<string, boolean>): void {
  snapshot = next;
  subs.forEach((fn) => fn());
}

const flags = (list: Integration[]) => Object.fromEntries(list.map((p) => [p.id, p.installed]));

/** Re-read the install flags. Call after anything that could flip one. */
export async function refreshIntegrations(): Promise<void> {
  try {
    publish(flags((await api.integrations()).plugins));
  } catch (e) {
    // A bridge older than this dashboard 404s "not found": it has no install step
    // and runs them all, so show them all.
    if (e instanceof Error && e.message === "not found") {
      publish({ rivendell: true, design: true });
    }
    /* any other failure keeps the last answer — a blip shouldn't blank the tabs */
  }
}

/** The settings page already holds the fresh list its POST returned; handing it
 *  over saves a round-trip and switches the tabs in the same frame. */
export function setIntegrations(list: Integration[]): void {
  asked = true;
  publish(flags(list));
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!asked) {
    asked = true;
    void refreshIntegrations();
  }
  return () => subs.delete(fn);
}

export function useIntegrations(): Record<string, boolean> {
  return useSyncExternalStore(subscribe, () => snapshot);
}
