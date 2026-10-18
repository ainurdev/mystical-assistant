// What Settings › Plugins › DEVICE RUNS (components/hud/DeviceRunsPanel.tsx)
// says about this device: STATE's right-hand text and the SETUP row's buttons,
// and the choices of CLAUDE ACCOUNT FOR DEVICE RUNS. Checked by deviceruns.check.ts.
import type { AccountInfo, RivendellDevice } from "../api";
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
    case "XCODE_MISSING":
      return d.share.checks.some((c) => c.key === "xcode" && c.ok)
        ? "not shared until an iOS Simulator runtime is installed"
        : "not shared until Xcode is installed";
    case "OFF": return "not shared";
    default: return "";
  }
}

/** The SETUP row's buttons: SET UP for a device that needs it and has Xcode
 *  (NEEDS_SETUP), or that is READY with a run helper older than Mystical's
 *  (`outdated`: it stays shared, SET UP only updates the helper), and REMOVE
 *  whenever anything of Set up's is here (share_state's `installed`, a setup cut
 *  short too), sharing on or off. None: no row. */
export function setupActions(d: Pick<RivendellDevice, "share">): ("setup" | "remove")[] {
  const out: ("setup" | "remove")[] = [];
  if (d.share.state === "NEEDS_SETUP" || (d.share.state === "READY" && d.share.outdated)) out.push("setup");
  if (d.share.installed) out.push("remove");
  return out;
}

/** CLAUDE ACCOUNT FOR DEVICE RUNS: the logins a run can go out under (not a
 *  disabled one), the one picked (`picked` null is the default login), and
 *  whether that one is gone from this Mystical, kept as a choice so the pick
 *  still shows. `def` is the default login's slot: picking it saves null. */
export function accountChoices(logins: Pick<AccountInfo, "slot" | "email" | "alias" | "disabled" | "default">[],
  picked: number | null) {
  const def = logins.find((a) => a.default)?.slot ?? 1;
  const slot = picked ?? def;
  const options = logins.filter((a) => !a.disabled).map((a) => ({
    slot: a.slot, label: `A${a.slot} · ${a.alias || a.email || "unknown"}${a.default ? " · default" : ""}`,
  }));
  const gone = !options.some((o) => o.slot === slot);
  return { slot, def, gone, options: gone ? [...options, { slot, label: `A${slot} · not in this Mystical` }] : options };
}
