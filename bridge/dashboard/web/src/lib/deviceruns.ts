// What Settings › Plugins › DEVICE RUNS (components/hud/DeviceRunsPanel.tsx)
// says about this device: STATE's right-hand text and the SETUP row's button.
// Checked by deviceruns.check.ts.
import type { RivendellDevice } from "../api";
import { hhmm } from "./surfaces.ts";

/** STATE's right-hand text. A teammate's run going now comes first, whatever
 *  the state: it can outlast sharing being switched off. */
export function stateText(d: Pick<RivendellDevice, "share" | "running" | "last_run">): string {
  if (d.running) return "running now";
  switch (d.share.state) {
    case "READY": {
      const r = d.last_run;
      return r ? `idle · last run ${[hhmm(r.at), r.by, r.task].filter(Boolean).join(", ")}` : "idle";
    }
    case "NEEDS_SETUP": return "not shared until it is set up";
    case "XCODE_MISSING": return "not shared until Xcode is installed";
    case "OFF": return "not shared";
    default: return "";
  }
}

/** The SETUP row's button: REMOVE whenever the hidden user is set up (share_state's
 *  "user" check, there with sharing on or off), SET UP for a device that isn't
 *  and has Xcode, else no row. */
export function setupAction(d: Pick<RivendellDevice, "share">): "setup" | "remove" | null {
  if (d.share.checks.some((c) => c.key === "user" && c.ok)) return "remove";
  return d.share.state === "NEEDS_SETUP" ? "setup" : null;
}
