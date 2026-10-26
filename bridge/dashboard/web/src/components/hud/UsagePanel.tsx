import { useEffect, useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown, ChevronRight, Clock, Copy, GitBranch, LayoutGrid, MessageSquare } from "lucide-react";
import { api, type WeeklyReport } from "../../api";
import { projectName, projectTint } from "../../lib/surfaces";
import { useStickyFlag } from "../../lib/prefs";
import { ProjectTile } from "../ui/ProjectTile";
import { notify } from "./Notifications";
import { daysOf, dur, fmtTokens, pct, timesheet } from "../../lib/week";

/** The USAGE tab (drafts/usage-rail): where the week went. It replaced the week
 *  report that hung off the brand cap as a popover over the sessions list.
 *
 *  What each login has left lives in the composer's PROFILE and MODEL menus;
 *  this tab's limits and Logins fold repeated them and went (drafts/usage-time).
 *  The readout is the GIT tab's (`.gp-ro`). The week is bridge/report.py's:
 *  worktrees already folded into their repo, days, failures by outcome.
 *
 *  Time and tokens, never dollars (9f612a4). "Agent time" because turn wall
 *  time adds up across parallel sessions, so a day can hold 48h of it. */

const POLL_MS = 60_000;
const TOP = 6;   // projects shown before "N more"

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;


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

function Cell({ icon, value, label, t }: { icon: ReactNode; value: ReactNode; label: string; t?: string }) {
  return (
    <div className={`gp-roc${t ? ` ${t}` : ""}`}>
      <b>{icon}<span>{value}</span></b><span>{label}</span>
    </div>
  );
}

export function UsagePanel({ onOpenProject }: { onOpenProject: (rel: string) => void }) {
  const [back, setBack] = useState(0);
  const [rep, setRep] = useState<WeeklyReport | null>(null);
  // A bridge still running pre-restart code has no /local/report route: say
  // "restart" instead of spinning forever.
  const [stale, setStale] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const [wkClosed, setWkClosed] = useStickyFlag("usage-week-closed");
  const [pjClosed, setPjClosed] = useStickyFlag("usage-projects-closed");
  const [stClosed, setStClosed] = useStickyFlag("usage-stopped-closed");
  const [tkClosed, setTkClosed] = useStickyFlag("usage-tokens-closed");

  useEffect(() => {
    let live = true;
    setRep(null);
    setPick(null);
    const load = () => api.report(back)
      .then((r) => { if (live) { setRep(r); setStale(false); } })
      .catch(() => { if (live) setStale(true); });
    void load();
    const id = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, [back]);

  const days = rep ? daysOf(rep) : [];
  const today = new Date().toLocaleDateString("sv-SE");
  const peak = Math.max(...days.map((d) => d.elapsed), 1);
  const day = pick !== null ? days[pick] : null;
  const t = rep?.totals;
  const share = (n: number) => (t?.elapsed ? Math.round((100 * n) / t.elapsed) : 0);
  const top = rep?.projects[0]?.elapsed || 1;
  const stops = (rep?.failures ?? []).filter((f) => f.code !== "delivered");   // a delivered answer reached you
  const range = rep ? `${new Date(rep.since * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${
    new Date((rep.until - 43200) * 1000).toLocaleDateString(undefined, { day: "numeric" })}` : "";

  const copy = () => {
    if (!rep) return;
    void navigator.clipboard?.writeText(timesheet(rep))
      .then(() => notify("info", "Copied the week as a markdown table."))
      .catch(() => notify("error", "Couldn't reach the clipboard."));
  };

  const week = () => {
    if (stale) return <div className="us-note">the bridge needs a restart before it can answer this</div>;
    if (!rep || !t) return <div className="us-note">reading…</div>;
    if (!rep.projects.length) return <div className="us-note">nothing ran {back ? "last" : "this"} week</div>;
    return (
      <div className="gp-rd">
        <div className="gp-ro">
          <Cell icon={<Clock size={14} strokeWidth={2.2} />} value={dur(day ? day.elapsed : t.elapsed)} label="agent time" t="on" />
          <Cell icon={<MessageSquare size={14} strokeWidth={2.2} />} value={day ? day.turns : t.turns} label="turns" />
          {day ? <Cell icon={<LayoutGrid size={14} strokeWidth={2.2} />} value={`${share(day.elapsed)}%`} label="of the week" />
            : <Cell icon={<LayoutGrid size={14} strokeWidth={2.2} />} value={t.sessions} label="sessions" />}
        </div>
        <div className="us-sub">
          {day ? <span>{day.date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} · <b>{day.turns}</b> turns · <b>{dur(day.elapsed)}</b> agent time</span>
            : rep.prev.turns > 0 ? <span>vs the week before: {rep.prev.elapsed > 0 && <><b>{pct(t.elapsed, rep.prev.elapsed)}</b> time · </>}<b>{pct(t.turns, rep.prev.turns)}</b> turns</span>
            : null}
        </div>
        <div className="us-days">
          {days.map((d) => {
            const future = d.key > today;
            return (
              <button key={d.key} type="button" className="us-day" disabled={future}
                data-today={d.key === today || undefined} data-future={future || undefined}
                data-pick={pick === d.i || undefined} data-dim={(pick !== null && pick !== d.i) || undefined}
                title={`${d.key} — ${plural(d.turns, "turn")} · ${dur(d.elapsed)}`}
                onClick={() => setPick((p) => (p === d.i ? null : d.i))}>
                <em>{future ? "" : d.elapsed ? dur(d.elapsed) : "0"}</em>
                <i style={{ height: future ? 4 : Math.max(3, Math.round((d.elapsed / peak) * 46)) }} />
                <span>{d.label}</span>
              </button>
            );
          })}
        </div>
        <div className="us-today">
          <CalendarDays size={12} strokeWidth={2} />
          {day ? <span>tap the day again for the whole week</span>
            : back ? <span>tap a day for its numbers</span>
            : <span>today <b>{days.find((d) => d.key === today)?.turns ?? 0}</b> turns · <b>{dur(days.find((d) => d.key === today)?.elapsed ?? 0)}</b> agent time</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="panel gp us" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="gp-head">
        <span className="gp-title">USAGE</span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)", flex: "none" }} />
      <div className="mscroll" style={{ flex: 1, minHeight: 0 }}>
        <Fold title={back ? "Last week" : "This week"} em={range} closed={wkClosed} onToggle={() => setWkClosed((v) => !v)}
          acts={
            <span className="us-seg">
              <button type="button" aria-pressed={back === 0} onClick={() => setBack(0)}>This</button>
              <button type="button" aria-pressed={back === 1} onClick={() => setBack(1)}>Last</button>
            </span>
          }>
          {week()}
        </Fold>

        {rep && rep.projects.length > 0 && (
          <Fold title="Projects" em={rep.projects.length} closed={pjClosed} onToggle={() => setPjClosed((v) => !v)}
            acts={<button className="gp-ib" title="copy the week as a timesheet (markdown)" onClick={copy}><Copy size={13} /></button>}>
            <div className="us-plist">
              {(all ? rep.projects : rep.projects.slice(0, TOP)).map((p) => {
                const root = p.project.replace(/\/+$/, "") === "";
                return (
                  <div key={p.project} className="us-prow" role={root ? undefined : "button"} tabIndex={root ? undefined : 0}
                    title={`${p.project}${p.models.length ? ` — ${p.models.join(", ")}` : ""}`}
                    onClick={root ? undefined : () => onOpenProject(p.project)}
                    onKeyDown={root ? undefined : (e) => { if (e.key === "Enter") onOpenProject(p.project); }}>
                    <ProjectTile project={p.project} />
                    <span className="us-pn">{projectName(p.project) || "No project"}</span>
                    <span className="us-pt">{dur(p.elapsed)}</span>
                    <span className="us-pm">
                      {plural(p.sessions, "session")} · {plural(p.turns, "turn")}
                      {p.worktrees?.length ? ` · ${plural(p.worktrees.length, "worktree")}` : ""}
                    </span>
                    <span className="us-ps">{share(p.elapsed)}%</span>
                    <i className="us-pbar"><i style={{ width: `${(100 * p.elapsed) / top}%`, ["--pc" as string]: projectTint(p.project).color }} /></i>
                    {!!p.worktrees?.length && (
                      <div className="us-wt">
                        {p.worktrees.map((w) => (
                          <div key={w.project} title={w.project}>
                            <GitBranch size={11} strokeWidth={2} /><span>{w.branch}</span><em>{dur(w.elapsed)}</em>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {rep.projects.length > TOP && (
                <button type="button" className="us-more" onClick={() => setAll((v) => !v)}>
                  {all ? "show less ↑" : `${rep.projects.length - TOP} more ↓`}
                </button>
              )}
            </div>
          </Fold>
        )}

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
