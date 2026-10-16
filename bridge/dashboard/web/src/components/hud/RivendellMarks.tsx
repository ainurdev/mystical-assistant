import { useCallback, useEffect, useState } from "react";
import { api, type RivendellMarks } from "../../api";
import { openSettings } from "../../lib/opensettings";
import { ago, projectName, setProjectMarks } from "../../lib/surfaces";
import { notify } from "./Notifications";

/* Rivendell's client logos and colours, offered to the repos here
   (bridge/projectmarks.py). Two places, both silent without a Rivendell:
   - the notice: once, when a connected Rivendell has marks for repos still
     wearing plain letters. IMPORT & SYNC or NOT NOW. Ignoring it doesn't bring
     it back on the next load: the offer it showed is remembered in this
     browser, and Settings keeps offering;
   - the strip atop SETTINGS ▸ AI MANAGEMENT ▸ Projects: IMPORT & SYNC while not
     following, the follow switch and SYNC NOW once it is.
   Design: docs/superpowers/specs/project-marks.md (03-notice, 04-settings). */

const SEEN = "hud-rivendell-offer";

/** "synced 3m ago", or "synced just now". */
export function synced(at: number): string {
  const a = ago(at);
  return a === "now" ? "synced just now" : `synced ${a} ago`;
}

function list(names: string[], max = 5): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0] ?? "";
}

/** Bring every match in, then say what changed, with UNDO. */
async function importAll(onChanged: () => void) {
  try {
    const r = await api.rivendellMarksAction("import");
    onChanged();
    const n = r.following ?? 0;
    const kept = r.kept ?? [];
    notify("rivendell", `${n} project${n === 1 ? " now wears its" : "s now wear their"} client's logo and colour.`, undefined, {
      sub: [kept.length ? `${list(kept.map(projectName), 3)} kept the mark you gave ${kept.length === 1 ? "it" : "them"}.` : "",
            "A logo or colour that changes in Rivendell follows here on its own."].filter(Boolean).join(" "),
      actions: [
        { label: "UNDO", run: () => void api.rivendellMarksAction("undo").then(onChanged).catch((e) => notify("error", String(e))) },
        { label: "SEE PROJECTS ›", run: () => openSettings("projects") },
      ],
    });
  } catch (e) {
    notify("error", `Rivendell import failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** The one-time notice. Quiet on a bridge without marks, without Rivendell,
 *  while following, and for an offer this browser has already shown. */
export async function offerRivendellMarks(onChanged: () => void): Promise<void> {
  let s: RivendellMarks;
  try { s = await api.rivendellMarks(); } catch { return; }
  const o = s.offer;
  if (!o) return;
  const sig = `${o.count}:${o.clients.join("|")}`;
  try {
    if (localStorage.getItem(SEEN) === sig) return;
    localStorage.setItem(SEEN, sig);
  } catch { /* no storage: show it */ }
  const from = o.clients.length > 1 ? `${o.clients.length} clients — ${list(o.clients)}` : o.clients[0];
  notify("rivendell", `Rivendell has logos and colours for ${o.count} of your project${o.count === 1 ? "" : "s"}.`, undefined, {
    sub: `From ${from}. A mark you set yourself stays yours.`,
    logos: o.logos,
    actions: [
      { label: "IMPORT & SYNC", primary: true, run: () => void importAll(onChanged) },
      { label: "NOT NOW", run: () => void api.rivendellMarksAction("dismiss").catch(() => { /* it just asks again */ }) },
    ],
  });
}

/** The strip atop SETTINGS ▸ Projects. */
export function RivendellStrip() {
  const [s, setS] = useState<RivendellMarks | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async (force = false) => {
    try { setS(await api.rivendellMarks(force)); } catch { setS(null); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const changed = useCallback(async () => {
    try { setProjectMarks((await api.projects()).marks); } catch { /* the 10s poll catches up */ }
    await reload();
  }, [reload]);

  if (!s?.asked) return null;
  if (!s.available) {
    const e = s.errors[0];
    if (!e) return null;
    return (
      <div className="ps-riv ps-riv-dim"><i /><div>
        <small>{e.error === "not_deployed"
          ? "Rivendell can't share client logos yet: it needs the GET /plugin/projects route."
          : `Rivendell didn't answer for client logos: ${e.detail}`}</small>
      </div></div>
    );
  }
  const matched = Object.keys(s.matches).length;
  if (!matched) return null;
  const clients = new Set(Object.values(s.matches).map((m) => m.client)).size;
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try { await fn(); await changed(); } catch (e) { notify("error", String(e)); } finally { setBusy(false); }
  };
  if (!s.sync) {
    return (
      <div className="ps-riv"><i /><div>
        <b>Rivendell has logos and colours for {matched} project{matched === 1 ? "" : "s"}</b>
        <small>from {clients} client{clients === 1 ? "" : "s"} · a mark you set yourself stays yours</small>
      </div>
        <button type="button" className="ps-btn ps-pri" disabled={busy}
          onClick={() => { setBusy(true); void importAll(changed).finally(() => setBusy(false)); }}>IMPORT &amp; SYNC</button>
      </div>
    );
  }
  return (
    <div className="ps-riv"><i /><div>
      <b>Logos and colours follow Rivendell</b>
      <small>{s.following} project{s.following === 1 ? "" : "s"} from {clients} client{clients === 1 ? "" : "s"}
        {s.synced_at ? ` · ${synced(s.synced_at)}` : ""}{s.unmatched ? ` · ${s.unmatched} have no client logo` : ""}</small>
    </div>
      <button type="button" className="ps-btn" disabled={busy}
        onClick={act(() => api.rivendellMarksAction("sync", { on: true }))}>SYNC NOW</button>
      <button type="button" className="ps-tog" data-on aria-label="stop following Rivendell" disabled={busy}
        title="stop following: every mark stays as it is"
        onClick={act(() => api.rivendellMarksAction("sync", { on: false }))} />
    </div>
  );
}
