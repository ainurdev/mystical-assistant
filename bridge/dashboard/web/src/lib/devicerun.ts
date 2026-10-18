// A teammate's device run on this device (bridge/device_view.py): a read-only
// session of origin "device-run:<instance>", listed under PLUGINS ▸ DEVICE RUNS
// (components/hud/SessionsPanel.tsx) and opened with components/DeviceRunPlate.tsx
// where the composer would be. Checked by devicerun.check.ts.
import type { SessionBrief } from "../api";
import { ago } from "./surfaces.ts";

/** Is this the origin of a teammate's device run's session? */
export const isDeviceRun = (origin?: string | null): boolean => !!origin?.startsWith("device-run:");

/** The DEVICE RUNS row's figure: while the run goes, how long it has been going
 *  (from `created`, which nothing moves); after, ✓ for done or ✕ for failed,
 *  stopped and cancelled, and the row's age, as every other row has it. */
export function rowAge(s: SessionBrief, working: boolean, now: number): { text: string; tone: "run" | "ok" | "bad" | "idle" } {
  if (working) return { text: ago(s.created ?? s.updated, now), tone: "run" };
  const o = s.device?.outcome;
  if (!o) return { text: ago(s.updated, now), tone: "idle" };
  return { text: `${o === "done" ? "✓" : "✕"} ${ago(s.updated, now)}`, tone: o === "done" ? "ok" : "bad" };
}

/** The plate's status tab: DONE, FAILED, STOPPED or CANCELLED and the minutes
 *  once it ends. No outcome yet is a run the bridge hasn't closed. */
export function plateStatus(working: boolean, outcome: string | null, minutes: number): string {
  return working || !outcome ? "RUNNING · LOW PRIORITY" : `${outcome.toUpperCase()} · ${minutes} MIN`;
}

/** The plate's line once the run is over, true to how it ended: a stopped run
 *  went back failed, and a run Rivendell cancelled sent nothing back. `to` is
 *  who the report goes to, `at` the time it ended. */
export function endedLine(outcome: string, by: string, to: string, at: string): string {
  const how = outcome === "done" ? `${by}'s run finished at ${at} and the report went back to ${to}.`
    : outcome === "stopped" ? `You stopped ${by}'s run at ${at}, and ${to} got it back as failed.`
    : outcome === "cancelled" ? `${by}'s run was cancelled at ${at}, so no report went back.`
    : `${by}'s run failed at ${at} and the error went back to ${to}.`;
  return `${how} This view is kept for 7 days.`;
}

/** Open a session in the chat column from anywhere (Settings' OPEN ›). App
 *  moves the transcript only, never the bridge's active project. */
export function openSession(id: string) {
  window.dispatchEvent(new CustomEvent("hud:open-session", { detail: id }));
}
