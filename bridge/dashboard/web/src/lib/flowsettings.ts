import { useSyncExternalStore } from "react";
import { api, type FlowChange, type FlowSettings } from "../api";
import { refreshAiFeatures } from "./ai";

/** The FLOWS sheet's settings (bridge/flowsettings.py), one fetch shared by the box and its sheet,
 *  as lib/ai shares the AI switches. Kept on the bridge, so a change made in another browser or app
 *  shows the next time the sheet opens (it re-reads then). null until the bridge has answered. */

let snapshot: FlowSettings | null = null;
let asked = false;
const subs = new Set<() => void>();

function publish(s: FlowSettings): void {
  snapshot = s;
  subs.forEach((fn) => fn());
}

export async function refreshFlowSettings(): Promise<void> {
  try {
    publish(await api.flows());
  } catch {
    /* an older bridge, or a blip: keep the last answer */
  }
}

/** One change; FLOWS, AUTO PICKS and SMART ZONE are AI switches too, so those re-read. */
export async function changeFlows(body: FlowChange): Promise<void> {
  publish(await api.setFlows(body));
  if ("key" in body && !("flow" in body)) void refreshAiFeatures();
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!asked) {
    asked = true;
    void refreshFlowSettings();
  }
  return () => subs.delete(fn);
}

export function useFlowSettings(): FlowSettings | null {
  return useSyncExternalStore(subscribe, () => snapshot);
}
