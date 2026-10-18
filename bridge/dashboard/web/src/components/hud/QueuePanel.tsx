import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Hourglass, Play, X } from "lucide-react";
import type { QueueGroup, QueueItem, RivendellQueueItem, SessionBrief, SessionStatus } from "../../api";
import { api } from "../../api";
import { useIntegrations } from "../../lib/integrations";
import { ago, projectName, projectTint } from "../../lib/surfaces";
import { askConfirm } from "../ui/Ask";
import { LANE_WORD, resolve } from "./SessionsPanel";

const toolBtn = {
  appearance: "none", cursor: "pointer", background: "transparent", color: "var(--txm)",
  border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", fontFamily: "inherit",
  fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px",
} as const;

const section = { fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", padding: "10px 12px 4px" } as const;

const STATE: Record<QueueItem["status"], { text: string; color: string }> = {
  queued: { text: "QUEUED", color: "var(--warn)" },
  running: { text: "RUNNING", color: "var(--acc)" },
  done: { text: "DONE", color: "var(--ok)" },
  failed: { text: "FAILED", color: "var(--err)" },
};

function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ flex: "none", fontSize: "var(--t8)", letterSpacing: 1, padding: "2px 6px",
                   border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`, color }}>{text}</span>
  );
}

function Link({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <button style={toolBtn} title="Open in Rivendell"
      onClick={(e) => { e.stopPropagation(); window.open(href, "_blank", "noopener"); }}>↗</button>
  );
}

/** SESSIONS: every session waiting on another one (bridge/waits.py), hung off
 *  the session it waits on, so a chain nests and the one holding it all up
 *  heads the card. Read from the status map App already polls; acting on a
 *  row hides it until the next poll agrees. */
function Waits({ sessions, status, onOpenSession }: {
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  onOpenSession: (id: string) => void;
}) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const byOn = new Map<string, string[]>();
  for (const [id, st] of status) {
    if (st.state === "waiting" && st.on && !gone.has(id)) byOn.set(st.on, [...(byOn.get(st.on) ?? []), id]);
  }
  const count = [...byOn.values()].reduce((n, w) => n + w.length, 0);
  if (!count) return null;
  const roots = [...byOn.keys()].filter((t) => status.get(t)?.state !== "waiting" || gone.has(t));
  const title = (id: string) => sessions.find((s) => s.id === id)?.title || "untitled session";
  const act = async (id: string, action: "resume" | "cancel") => {
    setGone((g) => new Set(g).add(id));
    try { await api.waitAction(id, action); setError(null); }
    catch {
      setGone((g) => { const n = new Set(g); n.delete(id); return n; });
      setError("The bridge didn't take that — if it keeps failing, restart the bridge.");
    }
  };
  const waiters = (on: string) => (
    <div className="qw-ws">
      {(byOn.get(on) ?? []).map((id) => (
        <div key={id} className="qw-wb">
          <div className="qw-w" title={status.get(id)?.then ? `then ${status.get(id)?.then}` : undefined}>
            <Hourglass className="qw-hg" size={11} strokeWidth={2} aria-hidden />
            <div className="qw-wl">
              <button className="qw-wt" onClick={() => onOpenSession(id)}>{title(id)}</button>
              <span className="qw-age">{ago(status.get(id)?.since ?? null)}</span>
              <span className="qw-acts">
                <button className="qw-ib" title="Resume now — don't wait any longer" onClick={() => act(id, "resume")}>
                  <Play size={11} strokeWidth={2} aria-hidden /></button>
                <button className="qw-ib" title="Cancel the wait" onClick={() => act(id, "cancel")}>
                  <X size={11} strokeWidth={2} aria-hidden /></button>
              </span>
            </div>
            {status.get(id)?.then && <div className="qw-then"><b>THEN</b> {status.get(id)?.then}</div>}
          </div>
          {byOn.has(id) && waiters(id)}
        </div>
      ))}
    </div>
  );
  return (
    <>
      <div className="qw-sect">SESSIONS<span>{count} waiting</span></div>
      {error && <div className="qw-err">{error}</div>}
      {roots.map((t) => {
        const st = status.get(t);
        const v = resolve(st, false);
        const s = sessions.find((x) => x.id === t);
        const needs = v.lane === "ask";
        const n = byOn.get(t)?.length ?? 0;
        return (
          <div key={t} className="qw-card" data-needs={needs || undefined}>
            <div className="qw-t">
              <i className="qw-dot" style={{ background: v.c, boxShadow: `0 0 6px color-mix(in srgb, ${v.c} 45%, transparent)` }} />
              <button className="qw-tt" onClick={() => onOpenSession(t)}>{title(t)}</button>
              <button className="qw-ib qw-open" title="Open this session" onClick={() => onOpenSession(t)}>
                <ArrowUpRight size={12} strokeWidth={2} aria-hidden /></button>
            </div>
            <div className="qw-meta">
              {s && <span style={{ color: projectTint(s.project).color }}>{projectName(s.project)}</span>}
              {s?.branch && <span>⎇ {s.branch.split("/").pop()}</span>}
              <span style={{ color: v.c }}>· {st?.state === "parked" && st.label ? st.label : LANE_WORD[v.lane]}</span>
            </div>
            {needs && st?.label && (
              <div className="qw-ask"><b>Asks:</b> {st.label} Answer it and {n === 1 ? "1 waiting session goes" : `${n} waiting sessions go`} on.</div>
            )}
            {waiters(t)}
          </div>
        );
      })}
    </>
  );
}

/** WAITING — what's waiting on what. Sessions waiting on another session first
 *  (Waits), then Rivendell's jobs held or running on this bridge, then every
 *  session of the open project that still holds queued prompts, with the queue
 *  ops that exist (pause/resume, clear done, bump, remove). Finished prompts
 *  don't show: nothing waits on them. Polls while mounted: Rivendell rows
 *  change with no dashboard event, and the per-session SSE streams are one
 *  session each. The Rivendell half exists only while Rivendell is installed:
 *  its route answers 404 otherwise, so it is not asked. */
export function QueuePanel({ project, sessions, status, onOpenSession }: {
  project: string | null;
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  onOpenSession: (id: string) => void;
}) {
  const plugins = useIntegrations();
  const [queue, setQueue] = useState<RivendellQueueItem[]>([]);
  // Derived, so REMOVE clears the RIVENDELL rows at once instead of leaving the last answer up.
  const jobs = plugins.rivendell ? queue : [];
  const [groups, setGroups] = useState<QueueGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    if (plugins.rivendell) void api.rivendellQueue().then((r) => setQueue(r.queue)).catch(() => {});
    void api.queueAll(project)
      .then((r) => { setGroups(r.sessions); setError(null); })
      .catch(() => { setGroups([]); setError("Queue unavailable"); });
  }, [project, plugins.rivendell]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const op = async (key: string, run: () => Promise<unknown>) => {
    setBusy((b) => new Set(b).add(key));
    try { await run(); load(); } catch { /* the poll reconciles */ }
    finally { setBusy((b) => { const n = new Set(b); n.delete(key); return n; }); }
  };

  const decide = async (it: RivendellQueueItem, accept: boolean) => {
    if (!accept) {
      const ok = await askConfirm(`Reject “${it.label ?? it.slug ?? it.request_id}”? Rivendell asks its requester what to do next.`);
      if (!ok) return;
    }
    await op(`${it.instance_id}|${it.key}`, () =>
      accept ? api.acceptRivendell(it.instance_id, it.key) : api.rejectRivendell(it.instance_id, it.key));
  };

  // What's still waiting: a done prompt is history, a group left with none goes.
  const live = (groups ?? []).map((g) => ({ ...g, items: g.items.filter((it) => it.status !== "done") }))
    .filter((g) => g.items.length > 0);
  const waiting = [...status.values()].some((st) => st.state === "waiting");
  const empty = jobs.length === 0 && live.length === 0 && !waiting;

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>WAITING</span>
        <button style={toolBtn} title="refresh" onClick={load}>⟳</button>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />
      <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: "0 0 10px" }}>
        {error && <div style={{ padding: "18px 12px", fontSize: "var(--t95)", color: "var(--txl)" }}>{error}</div>}
        {!error && empty && groups !== null && (
          <>
            <div style={{ padding: "18px 12px 4px", fontSize: "var(--t95)", color: "var(--txl)" }}>Nothing is waiting.</div>
            <div className="qw-hint">When a session says it will act after another one finishes, it waits here, and wakes up when that one is done.</div>
          </>
        )}
        <Waits sessions={sessions} status={status} onOpenSession={onOpenSession} />
        {jobs.length > 0 && <div style={section}>RIVENDELL</div>}
        {jobs.map((it) => {
          const key = `${it.instance_id}|${it.key}`;
          const working = busy.has(key);
          return (
            <div key={key} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 8,
                                    padding: "7px 12px", borderTop: "1px solid color-mix(in srgb, var(--acc) 6%, transparent)", opacity: working ? 0.5 : 1 }}>
              <Chip text={it.status === "running" ? "RUNNING" : "HELD"} color={it.status === "running" ? "var(--acc)" : "var(--warn)"} />
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--t115)", color: "var(--txh)" }}>
                  {it.label ?? it.slug ?? it.request_id}
                </span>
                <span style={{ display: "flex", gap: 7, fontSize: "var(--t9)", color: "var(--txl)" }}>
                  <span style={{ color: "var(--purple-g)" }}>{it.instance}</span>
                  <span>{it.kind}</span>
                  {it.mode && <span>{it.mode}</span>}
                  <span>{ago(it.created_at)}</span>
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Link href={it.link} />
                {it.status === "running" && it.session_id && (
                  <button style={toolBtn} onClick={() => onOpenSession(it.session_id!)}>OPEN SESSION</button>
                )}
                {it.status === "held" && (
                  <>
                    <button style={{ ...toolBtn, color: "var(--ok)" }} disabled={working} onClick={() => decide(it, true)}>ACCEPT</button>
                    <button style={{ ...toolBtn, color: "var(--err-g)" }} disabled={working} onClick={() => decide(it, false)}>REJECT</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {live.length > 0 && <div style={section}>QUEUED PROMPTS</div>}
        {live.map((g) => (
          <div key={g.session_id}>
            <div style={{ ...section, display: "flex", alignItems: "center", gap: 8 }}>
              <button
                style={{ ...toolBtn, border: "none", padding: 0, letterSpacing: 1.5, fontSize: "var(--t9)", color: "var(--txm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                title="Open this session" onClick={() => onOpenSession(g.session_id)}
              >{(g.title || g.session_id).toUpperCase()}</button>
              <span style={{ marginLeft: "auto", flex: "none", display: "flex", gap: 6 }}>
                {g.items.some((it) => it.status === "failed") && (
                  <button style={toolBtn} disabled={busy.has(g.session_id)}
                    title="Remove done and failed rows (a batch's finished turns are removed from this list only)"
                    onClick={() => op(g.session_id, () => api.queueOp("clear-done", { session_id: g.session_id }))}>
                    CLEAR DONE
                  </button>
                )}
                <button style={toolBtn} disabled={busy.has(g.session_id)}
                  onClick={() => op(g.session_id, () => api.queueOp(g.paused ? "resume" : "pause", { session_id: g.session_id }))}>
                  {g.paused ? "RESUME" : "PAUSE"}
                </button>
              </span>
            </div>
            {g.items.map((it) => (
              <div key={it.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 8,
                                        padding: "7px 12px", borderTop: "1px solid color-mix(in srgb, var(--acc) 6%, transparent)" }}>
                <Chip {...STATE[it.status]} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--t115)", color: it.status === "done" ? "var(--txm)" : "var(--txh)" }}
                      title={it.error ?? it.text}>
                  {it.label ?? it.text}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <Link href={it.link} />
                  {it.status === "queued" && (
                    <>
                      <button style={toolBtn} title="Run this next" disabled={busy.has(it.id)}
                        onClick={() => op(it.id, () => api.queueOp("bump", { session_id: g.session_id, item_id: it.id }))}>▲</button>
                      <button style={{ ...toolBtn, color: "var(--err-g)" }} title="Remove" disabled={busy.has(it.id)}
                        onClick={() => op(it.id, () => api.queueOp("remove", { session_id: g.session_id, item_id: it.id }))}>✕</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
