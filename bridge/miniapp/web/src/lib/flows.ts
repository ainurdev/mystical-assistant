import { useSyncExternalStore } from "react";
import { api, type FlowCatalog, type FlowShape } from "./api";

/** The flow catalog, shared by the type picker and the stage chip. Mirrors
 *  bridge/dashboard/web/src/lib/flows.ts — one fetch, many readers. An empty
 *  list reads as "no types", which is also what the switch being off looks
 *  like, so nothing flashes in before the bridge has answered. */

let snapshot: FlowShape[] = [];
let auto = false;
let asked = false;
const subs = new Set<() => void>();

function publish(cat: FlowCatalog): void {
  snapshot = cat.enabled ? cat.flows : [];
  auto = !!cat.auto;
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

/** AUTO TYPE on: the picker hides — every prompt classifies itself and the
 *  session follows. The catalog itself stays published for rails and chips. */
export function useFlowsAuto(): boolean {
  return useSyncExternalStore(subscribe, () => auto);
}

/** How much a stage is asking of you, on the ladder the flow gallery draws:
 *  L0 you watch it run, L5 you shape the artifact with it. The number is the
 *  useful part — it says, before you read the card, whether this one wants a
 *  glance or a decision. Derived from the stage's declared `input` rather than
 *  stored, so a flow author picks the interaction and the level follows.
 *
 *  Mirrors the twin under the other surface. Keep them in sync. */
const LADDER: Record<string, { level: number; verb: string }> = {
  approve:  { level: 1, verb: "TAP" },
  arm:      { level: 1, verb: "ARM" },
  pick:     { level: 2, verb: "PICK" },
  refine:   { level: 2, verb: "REFINE" },
  evidence: { level: 3, verb: "EVIDENCE" },
  answer:   { level: 3, verb: "ANSWER" },
  triage:   { level: 4, verb: "TRIAGE" },
  annotate: { level: 5, verb: "CO-EDIT" },
};

export function engagement(input?: string | null): { level: number; verb: string } {
  return (input && LADDER[input]) || { level: 0, verb: "WATCH" };
}
