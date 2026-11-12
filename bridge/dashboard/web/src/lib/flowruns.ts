/** A flow's run defaults (model, mode, effort, trim) live on the bridge (bridge/flowsettings.py),
 *  so every browser and both apps send the same. The box names the fields as PRESET does
 *  (lib/kinds KindRun: perm, ponytail); the bridge as its settings do (mode, trim). This is the
 *  translation both ways, and the one-time carry-over of the kind presets a browser kept itself.
 *  Pure: the caller hands in the send and the drop. */
import type { FlowChange } from "../api.ts";
import type { KindRun } from "./kinds.ts";

interface BridgeRun { model: string; mode: string; effort: string; trim: string }

/** Each flow's bridge default as PRESET names it; {} until the bridge answers (the built-ins hold). */
export function flowRuns(flows: { id: string; run: BridgeRun }[] | undefined): Record<string, KindRun> {
  return Object.fromEntries((flows ?? []).map((f) => [f.id, { model: f.run.model, perm: f.run.mode, effort: f.run.effort, ponytail: f.run.trim }]));
}

/** PRESET's "Save as <Flow>'s preset": one change per run row (POST /local/flows takes one at a time). */
export function saveRun(flow: string, r: KindRun): FlowChange[] {
  return ([["model", r.model], ["mode", r.perm], ["effort", r.effort], ["trim", r.ponytail]] as const)
    .map(([key, value]) => ({ flow, key, value }));
}

/** Sends a browser's saved kind presets once and drops them when the bridge has answered.
 *  The bridge takes them only if no browser's were taken yet, and only for flows with no saved
 *  run, so a second browser's answer is still "done". A refusal keeps them for the next load. */
export async function carryPresets(saved: Record<string, Partial<KindRun>> | undefined,
  send: (b: FlowChange) => Promise<unknown>, drop: () => void): Promise<void> {
  if (!saved || Object.keys(saved).length === 0) return;
  await send({ presets: saved as Record<string, Record<string, string>> });
  drop();
}
