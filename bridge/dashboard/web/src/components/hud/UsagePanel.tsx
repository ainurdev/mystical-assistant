import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { api, type WeeklyReport } from "../../api";
import { projectName, projectTint } from "../../lib/surfaces";
import { useStickyFlag } from "../../lib/prefs";
import { notify } from "./Notifications";
import { TabKick } from "./TabKick";
import { WeekGrid } from "./WeekGrid";
import { daysOf, dur, fmtTokens, pct, timesheet } from "../../lib/week";

/** The USAGE tab (drafts/usage-rail): where the week went. It replaced the week
 *  report that hung off the brand cap as a popover over the sessions list.
 *
 *  What each login has left lives in the composer's PROFILE and MODEL menus;
 *  this tab's limits and Logins fold repeated them and went (drafts/usage-time).
 *  Your week leads (day x hour grid, two numbers each for today and the
 *  week, one stacked bar for where it went); no battery, since the rail's
 *  ring already says what's left. The week is bridge/report.py's:
 *  worktrees already folded into their repo, days, failures by outcome.
 *
 *  Time and tokens, never dollars (9f612a4). "Agent time" because turn wall
 *  time adds up across parallel sessions, so a day can hold 48h of it. */

const POLL_MS = 60_000;
const TOP = 5;   // projects named in the legend before "N more"


function Fold({ title, em, acts, closed, onToggle, children }: {
  title: ReactNode; em?: ReactNode; acts?: ReactNode; closed: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className="gp-fold">
      <div className="gp-fh" role="button" aria-expanded={!closed} onClick={onToggle}>
        {closed ? <ChevronRight size={12} strokeWidth={2} /> : <ChevronDown size={12} strokeWidth={2} />}
        <b>{title}</b>
        {em != null && <em>{em}</em>}
        {acts && <span className="gp-acts" onClick={(e) => e.stopPropagation()}>{acts}</span>}
      </div>
      {!closed && children}
    </div>
  );
}

export function UsagePanel({ onOpenProject }: { onOpenProject: (rel: string) => void }) {
  const [back, setBack] = useState(0);
  const [rep, setRep] = useState<WeeklyReport | null>(null);
  // A bridge still running pre-restart code has no /local/report route: say
  // "restart" instead of spinning forever.
  const [stale, setStale] = useState(false);
  const [more, setMore] = useState(false);   // "N more" opens the legend in place
  const [stClosed, setStClosed] = useStickyFlag("usage-stopped-closed");
  const [tkClosed, setTkClosed] = useStickyFlag("usage-tokens-closed");

  useEffect(() => {
    let live = true;
    setRep(null);

    const load = () => api.report(back)
      .then((r) => { if (live) { setRep(r); setStale(false); } })
      .catch(() => { if (live) setStale(true); });
    void load();
    const id = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, [back]);

  const days = rep ? daysOf(rep) : [];
  const today = new Date().toLocaleDateString("sv-SE");
  const t = rep?.totals;
  const stops = (rep?.failures ?? []).filter((f) => f.code !== "delivered");   // a delivered answer reached you
  const td = days.find((d) => d.key === today);
  const vs = !back && rep && t && rep.prev.elapsed > 0 ? `${pct(t.elapsed, rep.prev.elapsed)} vs last` : "";
  // Five segments at most: the tail folds into one grey "N more".
  const shown = rep ? (rep.projects.length > TOP && !more ? rep.projects.slice(0, TOP - 1) : rep.projects) : [];
  const rest = rep ? rep.projects.slice(shown.length) : [];
  const restT = rest.reduce((n, p) => n + p.elapsed, 0);
  const cards: [string | number, string][] = t ? (back
    ? [[t.turns, "turns"], [dur(t.elapsed), "agent time"], [t.sessions, "sessions"], [days.filter((d) => d.turns).length, "days active"]]
    : [[td?.turns ?? 0, "turns today"], [dur(td?.elapsed ?? 0), "agent time today"], [t.turns, "turns this week"], [dur(t.elapsed), `this week${vs ? ` · ${vs}` : ""}`]]) : [];

  const copy = () => {
    if (!rep) return;
    void navigator.clipboard?.writeText(timesheet(rep))
      .then(() => notify("info", "Copied the week as a markdown table."))
      .catch(() => notify("error", "Couldn't reach the clipboard."));
  };

  const body = () => {
    if (stale) return <div className="us-note">the bridge needs a restart before it can answer this</div>;
    if (!rep || !t) return <div className="us-note">reading…</div>;
    return (
      <>
        <WeekGrid hours={rep.hours} back={back} />
        <div className="us-cards">{cards.map(([n, l]) => <div key={l}><b>{n}</b><small>{l}</small></div>)}</div>
        {rep.projects.length > 0 ? (
          <>
            <div className="us-lbl us-went">WHERE IT WENT</div>
            <div className="us-stack">
              {shown.map((p) => <i key={p.project} title={projectName(p.project) || "No project"} style={{ flex: p.elapsed, background: projectTint(p.project).color }} />)}
              {restT > 0 && <i title={`${rest.length} more`} style={{ flex: restT, background: "var(--txl)" }} />}
            </div>
            <div className="us-lg">
              {shown.map((p) => {
                const root = p.project.replace(/\/+$/, "") === "";
                return (
                  <button key={p.project} type="button" disabled={root} title={p.project} onClick={() => onOpenProject(p.project)}>
                    <i style={{ background: projectTint(p.project).color }} /><span>{projectName(p.project) || "No project"}</span><b>{dur(p.elapsed)}</b>
                  </button>
                );
              })}
              {rest.length > 0 && <button type="button" onClick={() => setMore(true)}><i style={{ background: "var(--txl)" }} /><span>{rest.length} more</span><b>{dur(restT)}</b></button>}
            </div>
          </>
        ) : <div className="us-note">nothing ran {back ? "last" : "this"} week</div>}
      </>
    );
  };

  const seg = (
    <>
    {rep && rep.projects.length > 0 && <button className="gp-ib" title="copy the week as a timesheet (markdown)" onClick={copy}><Copy size={13} /></button>}
    <span className="us-seg">
      <button type="button" aria-pressed={back === 0} onClick={() => setBack(0)}>This</button>
      <button type="button" aria-pressed={back > 0} onClick={() => setBack(1)}>Last</button>
    </span>
    </>
  );

  return (
    <div className="panel gp us" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <TabKick name="USAGE" tools={seg} />
      <div className="mscroll" style={{ flex: 1, minHeight: 0 }}>
        {body()}

        {stops.length > 0 && (
          <Fold title="Stopped turns" em={stops.reduce((n, f) => n + f.n, 0)} closed={stClosed} onToggle={() => setStClosed((v) => !v)}>
            <div className="us-kv">
              {stops.map((f) => (
                <div key={f.code} data-code={f.code}>
                  <span>{f.label.charAt(0) + f.label.slice(1).toLowerCase()}</span>
                  <i><i style={{ width: `${(100 * f.n) / stops[0].n}%` }} /></i>
                  <em>{f.n}</em>
                </div>
              ))}
            </div>
          </Fold>
        )}

        {t?.tokens && (
          <Fold title="Tokens" em={`${fmtTokens(t.tokens.in + t.tokens.out)} in + out`} closed={tkClosed} onToggle={() => setTkClosed((v) => !v)}>
            <div className="us-tok">
              <div><span>in</span><em>{fmtTokens(t.tokens.in)}</em></div>
              <div><span>out</span><em>{fmtTokens(t.tokens.out)}</em></div>
              <div><span>cache written</span><em>{fmtTokens(t.tokens.cache_w)}</em></div>
              <div><span>cache read</span><em>{fmtTokens(t.tokens.cache_r)}</em></div>
            </div>
            <div className="us-note">
              {Math.round((100 * t.tokens.cache_r) / Math.max(1, t.tokens.in + t.tokens.out + t.tokens.cache_w + t.tokens.cache_r))}% of
              {back ? " last" : " this"} week's tokens were cache reads.
            </div>
          </Fold>
        )}
      </div>
    </div>
  );
}
