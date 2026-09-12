import { useEffect, useRef, useState } from "react";
import { api, type DevServerInfo, type GitCommit, type GitStatus,
         type NextBoard, type NextItem, type NextKind } from "../api";
import { hairline } from "../lib/shell";
import { ago } from "../lib/surfaces";

/** The fresh-session screen's one instrument: where this project stands, and
 *  four questions the bridge can answer about it.
 *
 *  Scope is the point. The board behind it is machine-wide, but nothing on this
 *  screen is about another repo, so every read and every refresh names this
 *  project — one scout per press instead of one per repo touched this week.
 *
 *  The status line reads git directly rather than taking the same numbers out
 *  of the board's facts: they must be there before anything has been scouted,
 *  and whether or not the NEXT-UP BOARD switch is on. */

const TABS: { id: NextKind; label: string; blurb: string }[] = [
  { id: "next", label: "NEXT", blurb: "what is worth finishing here" },
  { id: "review", label: "REVIEW", blurb: "what is wrong in what changed" },
  { id: "research", label: "RESEARCH", blurb: "what has not been decided yet" },
  { id: "polish", label: "POLISH", blurb: "where the UI drifts from the system" },
];
const EFFORT: Record<NextItem["effort"], string> = { small: "·", medium: "··", large: "···" };

export function FreshPanel({ project, branch, run, onOpenRun, onStart }: {
  project: string;
  branch?: string | null;
  run?: DevServerInfo | null;
  onOpenRun?: () => void;
  onStart: (item: NextItem) => void;
}) {
  const [kind, setKind] = useState<NextKind>("next");
  const [git, setGit] = useState<GitStatus | null>(null);
  const [commit, setCommit] = useState<GitCommit | null>(null);
  const [board, setBoard] = useState<NextBoard | null>(null);
  /** Which (project, kind) a scout is running for, or null. Scoped rather than a
   *  bare boolean so switching tabs mid-scout doesn't show SCOUTING… on a tab
   *  nothing is scouting — and so the flag can still be cleared by the poll that
   *  set it, whichever tab happens to be on screen when it finishes. */
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [runCmd, setRunCmd] = useState<string | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [runErr, setRunErr] = useState("");
  const poll = useRef<number | null>(null);

  const scope = `${project}|${kind}`;
  const busy = busyScope === scope;
  // Always the scope on screen right now. A ref, not state: an in-flight poll
  // must compare against the CURRENT value, not the one it captured at click.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    let live = true;
    setGit(null); setCommit(null); setRunCmd(undefined);
    api.git(project, branch || undefined).then((g) => live && setGit(g)).catch(() => {});
    api.gitLog(project, 1, branch || undefined)
      .then((r) => live && setCommit(r.commits[0] ?? null)).catch(() => {});
    api.projectSettings({ project })
      .then((s) => live && setRunCmd(s.run_cmd)).catch(() => {});
    return () => { live = false; };
  }, [project, branch]);

  useEffect(() => {
    let live = true;
    setBoard(null);
    api.nextBoard({ project, kind }).then((b) => live && setBoard(b)).catch(() => {});
    return () => { live = false; };
  }, [project, kind]);

  // The poll outlives a tab switch on purpose: it is the only thing that can
  // clear its own busy scope, and its writes are already scope-guarded. Only
  // unmounting stops it.
  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);

  useEffect(() => { setStarting(false); }, [run?.status, run?.pid]);

  async function refresh() {
    const mine = { project, kind }, mineScope = scope;
    setBusyScope(mineScope);
    await api.refreshNext(mine).catch(() => null);
    if (poll.current) window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      const b = await api.nextBoard(mine).catch(() => null);
      // Clearing the interval stops future ticks, never one already in flight —
      // so a late answer is dropped here rather than landing on another tab.
      if (b && scopeRef.current === mineScope) setBoard(b);
      if (b && !b.refreshing) {
        if (poll.current) window.clearInterval(poll.current);
        poll.current = null;
        setBusyScope((cur) => (cur === mineScope ? null : cur));
      }
    }, 3000);
  }

  async function dismiss(id: string) {
    setBoard((b) => (b ? { ...b, items: b.items.filter((i) => i.id !== id) } : b));
    await api.dismissNext(id, { project, kind }).catch(() => {});
  }

  async function startRun() {
    if (starting) return;
    setStarting(true); setRunErr("");
    try {
      const r = await api.server("start", { project });
      if (r.server?.status !== "running") {
        setRunErr(r.message || "didn't start"); setStarting(false);
      }
    } catch (e) {
      setRunErr((e as Error).message || "start failed"); setStarting(false);
    }
  }

  const runSlot = run?.status === "running" ? null
    : runCmd ? "run" : runCmd === null && onOpenRun ? "setup" : null;
  const items = board?.items ?? [];
  const [lead, ...rest] = items;

  return (
    <div style={{ width: "min(560px, 100%)", textAlign: "left",
                  border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)" }}>
      {/* status line — free facts, always present */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                    fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txd)",
                    borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }}>
        <span style={{ color: "var(--txm)", flex: "none" }}>⎇ {git?.branch || branch || "—"}</span>
        {!!git?.dirty && <><span style={hairline(11)} /><span>{git.dirty} dirty</span></>}
        {!!git?.ahead && <><span style={hairline(11)} /><span>{git.ahead} ahead</span></>}
        <span style={{ flex: 1 }} />
        {runSlot === "run" && (
          <button type="button" onClick={() => void startRun()} disabled={starting}
            title={runErr || `start ${runCmd}`}
            style={{ appearance: "none", flex: "none", cursor: starting ? "default" : "pointer",
                     fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
                     padding: "3px 9px", background: "transparent",
                     border: `1px solid color-mix(in srgb, ${runErr ? "var(--err) 45%" : "var(--acc) 30%"}, transparent)`,
                     color: runErr ? "var(--err)" : starting ? "var(--txd)" : "var(--acc)" }}>
            {starting ? "STARTING…" : runErr ? "FAILED" : "▸ RUN"}
          </button>
        )}
        {runSlot === "setup" && (
          <button type="button" onClick={onOpenRun}
            title="No run command saved for this project — set one in its TERMINAL tab"
            style={{ appearance: "none", flex: "none", cursor: "pointer", fontFamily: "inherit",
                     fontSize: "var(--t9)", letterSpacing: 1.5, padding: 0, border: 0,
                     background: "transparent", color: "var(--txd)" }}>
            SET UP RUN
          </button>
        )}
      </div>
      {commit && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "0 12px 9px",
                      fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txd)",
                      borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }}
             title={`${commit.sha.slice(0, 7)} · ${commit.author}`}>
          <span style={{ letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>LAST</span>
          <span style={{ color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden",
                         textOverflow: "ellipsis", minWidth: 0 }}>{commit.subject}</span>
          <span style={{ flex: "none" }}>{ago(commit.ts)}</span>
        </div>
      )}

      {/* the four questions */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "8px 12px 0" }}>
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setKind(t.id)} title={t.blurb}
            style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent",
                     fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
                     padding: "4px 8px", color: kind === t.id ? "var(--acc)" : "var(--txd)",
                     borderBottom: `1px solid ${kind === t.id ? "var(--acc)" : "transparent"}` }}>
            {t.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {board?.enabled !== false && (
          <button type="button" onClick={() => void refresh()} disabled={busy}
            title="Scouts this repo, for this question only. Nothing moved since last time, nothing spent."
            style={{ appearance: "none", cursor: busy ? "default" : "pointer",
                     border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
                     background: "transparent", color: busy ? "var(--txd)" : "var(--txm)",
                     fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
                     padding: "3px 9px" }}>
            {busy ? "SCOUTING…" : "↻"}
          </button>
        )}
      </div>

      <div style={{ padding: "12px" }}>
        {board?.enabled === false && (
          <div style={{ fontSize: "var(--t95)", color: "var(--txl)", lineHeight: 1.7, marginBottom: 12 }}>
            Scouting is off, so this is the plain heuristic order and costs nothing.
            Switch NEXT-UP BOARD on in Settings → AI to have a scout read this repo.
          </div>
        )}
        {!items.length && (
          <div style={{ fontSize: "var(--t10)", color: "var(--txd)", lineHeight: 1.8 }}>
            {board === null ? "Reading…"
              : `Nothing yet — ↻ asks this repo ${TABS.find((t) => t.id === kind)!.blurb}.`}
          </div>
        )}
        {lead && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: "var(--t12)", color: "var(--txb)", overflowWrap: "anywhere" }}>
                {lead.title}
              </div>
              <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 4, lineHeight: 1.7 }}>
                {lead.why}
              </div>
              <div style={{ fontSize: "var(--t9)", color: "var(--txd)", marginTop: 5, letterSpacing: 0.5 }}>
                {EFFORT[lead.effort] ?? "··"}{lead.evidence ? ` · ${lead.evidence}` : ""}
              </div>
            </div>
            <button type="button" onClick={() => onStart(lead)}
              style={{ appearance: "none", cursor: "pointer", flex: "none",
                       border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
                       background: "transparent", color: "var(--txm)", fontFamily: "inherit",
                       fontSize: "var(--t9)", letterSpacing: 1.5, padding: "4px 10px" }}>
              ▸ START
            </button>
            <button type="button" onClick={() => void dismiss(lead.id)} title="Not this — until the repo moves"
              style={{ appearance: "none", cursor: "pointer", flex: "none", border: 0,
                       background: "transparent", color: "var(--txd)", fontFamily: "inherit",
                       fontSize: "var(--t9)", padding: "4px 2px" }}>
              ✕
            </button>
          </div>
        )}
        {rest.map((it) => (
          <div key={it.id} style={{ display: "flex", gap: 10, alignItems: "baseline", marginTop: 10,
                                    borderTop: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
                                    paddingTop: 10 }}>
            <span style={{ minWidth: 0, flex: 1, fontSize: "var(--t10)", color: "var(--txm)",
                           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {it.title}
            </span>
            <button type="button" onClick={() => onStart(it)}
              style={{ appearance: "none", cursor: "pointer", flex: "none", border: 0,
                       background: "transparent", color: "var(--txd)", fontFamily: "inherit",
                       fontSize: "var(--t9)", letterSpacing: 1.5, padding: 0 }}>
              ▸ START
            </button>
            <button type="button" onClick={() => void dismiss(it.id)} title="Not this — until the repo moves"
              style={{ appearance: "none", cursor: "pointer", flex: "none", border: 0,
                       background: "transparent", color: "var(--txd)", fontFamily: "inherit",
                       fontSize: "var(--t9)", padding: "0 2px" }}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
