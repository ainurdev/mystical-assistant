import { useState } from "react";
import { GitPullRequest, Smartphone, Square } from "lucide-react";
import { api, type SessionBrief } from "../api";
import { useChatChrome } from "../lib/chatchrome";
import { plateStatus } from "../lib/devicerun";
import { hhmm, useClock12 } from "../lib/surfaces";
import { askConfirm } from "./ui/Ask";
import { notify } from "./hud/Notifications";

/** A teammate's device run's mark where a project's tile would be: the tile
 *  itself (.ptile, so every theme draws it its own way), in the device-run blue,
 *  with a phone on it. */
export function DeviceTile() {
  return <b className="ptile" aria-hidden data-kind="icon" style={{ ["--pc" as string]: "var(--info)" }}><Smartphone /></b>;
}

/** What sits where the composer would, for a teammate's device run
 *  (lib/devicerun): the composer's TABS shell (the title tab it is handed, the
 *  run's state as the right-hand tab, the card) holding what the run is, never a
 *  box to type in. The bridge refuses a run in this session anyway; this is
 *  what says so. `ended` is when the run's last event landed: the session's
 *  `updated` stays at its start. */
export function DeviceRunPlate({ s, working, ended }: { s: SessionBrief; working: boolean; ended?: number }) {
  const { lead } = useChatChrome();
  const h12 = useClock12();
  const [stopping, setStopping] = useState(false);
  const d = s.device;
  const by = d?.by || "A teammate";
  const outcome = d?.outcome ?? null;
  // No outcome yet is a run the bridge hasn't closed (plateStatus).
  const live = working || !outcome;
  const end = ended ?? s.updated;
  const status = plateStatus(working, outcome, Math.round((end - (s.created ?? s.updated)) / 60));
  const stop = async () => {
    if (!(await askConfirm(`Stop ${by}'s run on this device? ${by} gets it back as failed.`))) return;
    setStopping(true);   // the helper's stop takes up to a minute: one press is enough
    try {
      await api.stopDeviceRun(s.id);
    } catch (e) {
      const msg = (e as Error).message;
      // An older bridge has no such route, so its 404 is the generic one.
      notify("error", msg === "not found" ? "Restart Mystical to stop runs from here." : msg);
      setStopping(false);
    }
  };
  return (
    <div className="composer" data-pb="tabs"
      style={{ flex: "none", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", padding: "11px 16px", background: "color-mix(in srgb, var(--panel) 88%, transparent)" }}>
      <div className="pb-tabs pb-lead">
        {lead}
        <div className="ctrl-ctx">
          <span aria-hidden style={{ color: live ? "var(--info)" : outcome === "done" ? "var(--ok)" : "var(--err)" }}>
            {live ? "●" : outcome === "done" ? "✓" : "✕"}
          </span>
          {status}
        </div>
      </div>
      <div className="cmdbox pb-card"
        style={{ position: "relative", display: "flex", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", background: "color-mix(in srgb, var(--panel2) 70%, transparent)", padding: "10px 13px", fontFamily: "'JetBrains Mono',monospace" }}>
        <div className="drp-ro">
          <b>Read only.</b>{" "}
          {live
            ? <>{by}'s run on this device, as <code>mysticalruns</code>. It runs at low priority, keeps going through Mystical restarts and updates, and your sessions never wait for it.</>
            : <>{by}'s run finished at {hhmm(end, h12)} and the report went back to {d?.by ? d.by.split(" ")[0] : "them"}. This view is kept for 7 days.</>}
        </div>
        <div className="drp-chips">
          <span className="drp-chip">
            <span className="drp-av" aria-hidden>{by.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
            {by}
          </span>
          {d?.repo && (
            <span className="drp-chip" title={d.repo}>
              <GitPullRequest size={13} strokeWidth={1.8} aria-hidden />
              {d.repo.split("/").pop()}{d.pr != null && ` #${d.pr}`}
              {d.sha && <code>{d.sha.slice(0, 7)}</code>}
            </span>
          )}
          {live && (
            <button type="button" className="act-alt drp-stop" onClick={() => void stop()} disabled={stopping}>
              <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden />STOP RUN
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
