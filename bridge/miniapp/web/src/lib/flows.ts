import { useSyncExternalStore } from "react";
import { api, type FlowCatalog, type FlowShape } from "./api";

/** The flow catalog, shared by the type picker and the stage chip. Mirrors
 *  bridge/dashboard/web/src/lib/flows.ts — one fetch, many readers. An empty
 *  list reads as "no types", which is also what the switch being off looks
 *  like, so nothing flashes in before the bridge has answered. */

let snapshot: FlowShape[] = [];
let asked = false;
const subs = new Set<() => void>();

function publish(cat: FlowCatalog): void {
  snapshot = cat.enabled ? cat.flows : [];
  subs.forEach((fn) => fn());
}

export async function refreshFlows(): Promise<void> {
  try {
    publish(await api.flows());
  } catch {
    /* keep the last answer — a blip shouldn't empty the picker */
  }
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!asked) {
    asked = true;
    void refreshFlows();
  }
  return () => subs.delete(fn);
}

export function useFlows(): FlowShape[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}
