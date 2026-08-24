import { useSyncExternalStore } from "react";
import { api, type FlowCatalog, type FlowShape } from "../api";

/** The flow catalog, shared by everything that renders a typed session: the
 *  start picker, the stage rail, the template editor. One fetch, many readers —
 *  the same reason lib/ai.ts exists rather than a prop threaded through four
 *  components. An empty list reads as "no types", so nothing flashes in before
 *  the bridge has answered — or while the TYPED FLOWS switch is off. */

let snapshot: FlowShape[] = [];
let auto = false;
let asked = false;
const subs = new Set<() => void>();

function publish(cat: FlowCatalog): void {
  snapshot = cat.enabled ? cat.flows : [];
  auto = !!cat.auto;
  subs.forEach((fn) => fn());
}

/** Re-read the catalog. Call after editing a template or flipping the switch. */
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

/** AUTO TYPE on: the picker hides — sessions type themselves off the first
 *  message. The catalog itself stays published for rails and chips. */
export function useFlowsAuto(): boolean {
  return useSyncExternalStore(subscribe, () => auto);
}
