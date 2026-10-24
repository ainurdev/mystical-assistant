import { useEffect, useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown, ChevronRight, Clock, Copy, GitBranch, Hourglass, LayoutGrid, MessageSquare, Sparkles, TriangleAlert } from "lucide-react";
import { api, type AccountInfo, type UsageBucket, type WeeklyReport } from "../../api";
import { fmtReset, hhmm, projectName, projectTint, useClock12 } from "../../lib/surfaces";
import { useStickyFlag } from "../../lib/prefs";
import { slotHue } from "../../lib/profiles";
import { ProjectTile } from "../ui/ProjectTile";
import { notify } from "./Notifications";
import { daysOf, dur, fmtTokens, leftOf, pct, timesheet, tone } from "../../lib/week";

/** The USAGE tab (drafts/usage-rail): what the login this chat spends has left,
 *  then where the week went. It replaced the week report that hung off the
 *  brand cap as a popover over the sessions list.
 *
 *  Limits come first because they are what decides whether you can keep
 *  working. The readout is the GIT tab's (`.gp-ro`): % left with a fuel line
 *  (fill = left), the refills under it, and a pace line once the bridge has
 *  an hour of readings (usage.pace). The week is bridge/report.py's: worktrees
 *  already folded into their repo, days, failures by outcome.
 *
 *  Time and tokens, never dollars (9f612a4). "Agent time" because turn wall
 *  time adds up across parallel sessions, so a day can hold 48h of it. */

const POLL_MS = 60_000;
const TOP = 6;   // projects shown before "N more"

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;


/** A refill time: the clock within a day, with the weekday past that. */
function when(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) / 1000 : NaN;
  if (!isFinite(t)) return "—";
  return t - Date.now() / 1000 < 86400 ? hhmm(t)
    : `${new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short" })} ${hhmm(t)}`;
}

const span = (s: number) => {
  const m = Math.max(0, Math.round(s / 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

const THEN: Record<string, string> = {
  auto: "Then this chat moves to another login on its own.",
  ask: "Then this chat stops and asks which login to use.",
  wait: "Then this chat waits for the refill.",
};

/** Why a login shows no meter, or null when it has one. */
function noMeter(a: AccountInfo): string | null {
  if (a.disabled) return "switched off";
  if (!a.logged_in) return "signed out — sign in again from Settings ▸ Accounts";
  if (a.left === null) return "no reading while it sits idle — it reads again on its next turn";
  return null;
}

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

function Cell({ icon, value, label, t, fuel, title }: {
  icon: ReactNode; value: ReactNode; label: string; t?: string; fuel?: number; title?: string;
}) {
  return (
    <div className={`gp-roc${t ? ` ${t}` : ""}`} title={title}>
      <b>{icon}<span>{value}</span></b><span>{label}</span>
      {fuel !== undefined && <i className="us-fuel"><i style={{ width: `${fuel}%` }} /></i>}
    </div>
  );
}

/** The login this chat spends: each window's % left, when it refills, and the pace. */
function Limits({ a, policy }: { a: AccountInfo; policy: string }) {
  const why = noMeter(a);
  if (why) return <div className="gp-rd"><div className="us-sub">{why}</div></div>;
  const cells: { icon: ReactNode; label: string; b: UsageBucket }[] = [];
  if (a.five_hour) cells.push({ icon: <Hourglass size={14} strokeWidth={2.2} />, label: "5-hour left", b: a.five_hour });
  if (a.seven_day) cells.push({ icon: <CalendarDays size={14} strokeWidth={2.2} />, label: "week left", b: a.seven_day });
  for (const l of a.limits ?? []) {
    if (l.kind === "weekly_scoped" && l.scope?.model?.display_name)
      cells.push({ icon: <Sparkles size={14} strokeWidth={2.2} />, label: `${l.scope.model.display_name} week`, b: l });
  }
  const h5 = a.five_hour, wk = a.seven_day;
  const out = a.runs_out_at ? Date.parse(a.runs_out_at) / 1000 : NaN;
  const refill = h5?.resets_at ? Date.parse(h5.resets_at) / 1000 : NaN;
  return (
    <div className="gp-rd">
      <div className="gp-ro" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}>
        {cells.map(({ icon, label, b }) => {
          const left = leftOf(b);
          return <Cell key={label} icon={icon} value={<>{left}<small>%</small></>} label={label} t={tone(left, b.severity)}
            fuel={left} title={`${label}: ${left}% left, refills ${when(b.resets_at)}`} />;
        })}
      </div>
      <div className="us-sub">
        {h5 && <span data-tone={tone(leftOf(h5), h5.severity) || undefined}>
          5-hour refills at <b>{when(h5.resets_at)}</b> · in <em className="us-rst">{fmtReset(h5.resets_at)}</em></span>}
        {wk && <span>week refills <b>{when(wk.resets_at)}</b> · in <em className="us-rst">{fmtReset(wk.resets_at)}</em></span>}
      </div>
      {isFinite(out) && isFinite(refill) && (
        <div className="us-pace">
          <TriangleAlert size={13} strokeWidth={2} />
          <span>At this pace the 5-hour window runs out about <b>{hhmm(out)}</b>, <b>{span(refill - out)}</b> before
            it refills. {THEN[policy] ?? ""}</span>
        </div>
      )}
    </div>
  );
}

function Logins({ accounts, spend }: { accounts: AccountInfo[]; spend: number | null }) {
  return (
    <div>
      {accounts.map((a) => {
        const why = noMeter(a);
        const win = (tag: string, b: UsageBucket | null) => {
          if (!b) return null;
          const left = leftOf(b);
          return (
            <span key={tag} className="us-w" data-tone={tone(left, b.severity) || undefined} title={`refills ${when(b.resets_at)}`}>
              <i>{tag}</i><span className="us-bar"><span style={{ width: `${left}%` }} /></span><b>{left}%</b>
              <em className="us-rst">{fmtReset(b.resets_at)}</em>
            </span>
          );
        };
        return (
          <div key={a.slot} className="us-login">
            <span className="us-slot" style={{ background: slotHue(String(a.slot)) }}>{a.slot}</span>
            <div className="us-lm">
              <div className="us-l1">
                <span>{a.alias || a.email || `login ${a.slot}`}</span>
                {a.plan && <span className="us-plan">{a.plan}</span>}
                {a.slot === spend ? <span className="us-tag">THIS CHAT</span> : a.default ? <span className="us-tag" data-ok="">DEFAULT</span> : null}
              </div>
              {why ? <span className="us-why" data-dead={!a.logged_in || undefined}>{why}</span>
                : <div className="us-ws">{win("5H", a.five_hour)}{win("WK", a.seven_day)}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function UsagePanel({ accounts, spend, policy, onOpenProject }: {
  accounts: AccountInfo[];
  /** The login this chat spends (models.spendingSlot); null for another agent. */
  spend: number | null;
  /** What this chat does when that login runs out: ask | auto | wait. */
  policy: string;
  onOpenProject: (rel: string) => void;
}) {
  useClock12();   // refill times answer to the header clock's 12H switch
  const [back, setBack] = useState(0);
  const [rep, setRep] = useState<WeeklyReport | null>(null);
  // A bridge still running pre-restart code has no /local/report route: say
  // "restart" instead of spinning forever (the SpendPanel posture).
  const [stale, setStale] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const [lgClosed, setLgClosed] = useStickyFlag("usage-logins-closed");
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

  const me = accounts.find((a) => a.slot === spend) ?? null;
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
        {me && (
          <span className="gp-branch" title={`this chat spends ${me.email ?? `login ${me.slot}`}`}>
            <span className="us-slot" style={{ background: slotHue(String(me.slot)) }}>{me.slot}</span><span>{(me.alias || me.email || `login ${me.slot}`).split("@")[0]}</span>
          </span>
        )}
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)", flex: "none" }} />
      <div className="mscroll" style={{ flex: 1, minHeight: 0 }}>
        {me && <div className="gp-rdw"><Limits a={me} policy={policy} /></div>}

        {accounts.length > 1 && (
          <Fold title="Logins" em={accounts.length} closed={lgClosed} onToggle={() => setLgClosed((v) => !v)}>
            <Logins accounts={accounts} spend={spend} />
          </Fold>
        )}

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
