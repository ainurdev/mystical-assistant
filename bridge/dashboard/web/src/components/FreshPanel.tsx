import { useEffect, useRef, useState } from "react";
import { api, type DevServerInfo, type GitCommit, type GitStatus,
         type SessionBrief, type SessionStatus } from "../api";
import { localRows, mergeable, mergeClause } from "../lib/freshlocal";
import { hairline } from "../lib/shell";
import { ago } from "../lib/surfaces";
import { LANE_WORD, resolve } from "./hud/SessionsPanel";

/** The fresh-session screen's one instrument: where this project stands, and
 *  what is open off its default branch.
 *
 *  It used to end in a NEXT / REVIEW / RESEARCH / POLISH board that a scout
 *  filled. No session was ever started from it (0 of 346 by 2026-10-23), while
 *  about one first prompt in nine was "clean up local, then …" or "merge the
 *  idle branches into main". So the board became LOCAL — each branch off the
 *  default one with the state of its newest session, in the sessions panel's
 *  own words and colours — and two starters that write those prompts for you.
 *  A starter never sends: it goes in front of the prompt box's draft.
 *
 *  The status line reads git directly rather than taking the same numbers out
 *  of any board: they must be there the moment the screen opens. */

/** The panel's own rules, at the weights lib/shell.ts fixes for every theme:
 *  22% accent is the floor a light ground (FLINT's daylight) still shows. */
const RULE = "color-mix(in srgb, var(--acc) 22%, transparent)";
/** Past this many rows the rest is a count: a repo can hold hundreds of branches. */
const MAX_ROWS = 8;

/** What App hands the panel: the sessions and their states it already holds,
 *  and the two things a row or a starter can do. */
export interface FreshLocal {
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  done: Set<string>;
  /** Put a starter in front of the prompt box's draft (lib/freshlocal startWith). */
  onStart: (clause: string, open: boolean) => void;
  onOpen: (sessionId: string) => void;
}

export function FreshPanel({ project, branch, run, onOpenRun, local }: {
  project: string;
  branch?: string | null;
  run?: DevServerInfo | null;
  onOpenRun?: () => void;
  local: FreshLocal;
}) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [commit, setCommit] = useState<GitCommit | null>(null);
  const [tree, setTree] = useState<{ branches: string[]; def: string; held: Set<string>; merged: Set<string> } | null>(null);
  const [runCmd, setRunCmd] = useState<string | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [runErr, setRunErr] = useState("");

  // Another project's facts are never shown for this one. A branch named late
  // (the session New made landing under its fresh screen) keeps what's drawn
  // until its own facts land, or the panel would fold and grow back.
  const drawn = useRef(project);
  useEffect(() => {
    let live = true;
    if (drawn.current !== project) {
      drawn.current = project;
      setGit(null); setCommit(null); setRunCmd(undefined); setTree(null);
    }
    api.git(project, branch || undefined).then((g) => live && setGit(g)).catch(() => {});
    api.gitLog(project, 1, branch || undefined)
      .then((r) => live && setCommit(r.commits[0] ?? null)).catch(() => {});
    api.projectSettings({ project })
      .then((s) => live && setRunCmd(s.run_cmd)).catch(() => {});
    Promise.all([api.branches(project), api.worktrees(project)])
      .then(([b, w]) => live && setTree({
        branches: b.branches, def: b.default, merged: new Set(w.merged),
        held: new Set(w.worktrees.filter((t) => !t.is_main).map((t) => t.branch)),
      })).catch(() => {});
    return () => { live = false; };
  }, [project, branch]);

  useEffect(() => { setStarting(false); }, [run?.status, run?.pid]);

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
  const view = (id: string) => resolve(local.status.get(id), local.done.has(id));
  const rows = tree ? localRows(tree.branches, tree.def, tree.held, tree.merged,
    local.sessions.filter((s) => s.project === project),
    (id) => !["done", "idle"].includes(view(id).lane)) : [];
  const busy = rows.filter((r) => r.busy).length;
  const merged = rows.filter((r) => !r.busy && r.merged).length;
  const merge = mergeable(rows);
  // Every branch name in one column width, so the states line up down the list.
  const brw = Math.min(28, Math.max(0, ...rows.slice(0, MAX_ROWS).map((r) => r.branch.length)));

  return (
    <div style={{ width: "min(560px, 100%)", textAlign: "left",
                  border: `1px solid ${RULE}` }}>
      {/* status line — free facts, always present */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                    fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txd)",
                    borderBottom: `1px solid ${RULE}` }}>
        <span style={{ color: "var(--txm)", flex: "none" }}>⎇ {git?.branch || branch || "—"}</span>
        {!!git?.dirty && <><span style={hairline(11)} /><span>{git.dirty} dirty</span></>}
        {!!git?.ahead && <><span style={hairline(11)} /><span>{git.ahead} ahead</span></>}
        <span style={{ flex: 1 }} />
        {runSlot === "run" && (
          <button type="button" onClick={() => void startRun()} disabled={starting}
            title={runErr || `start ${runCmd}`} className="caps"
            style={{ appearance: "none", flex: "none", cursor: starting ? "default" : "pointer",
                     fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
                     padding: "3px 9px", background: "transparent",
                     border: `1px solid color-mix(in srgb, ${runErr ? "var(--err) 45%" : "var(--acc) 30%"}, transparent)`,
                     color: runErr ? "var(--err)" : starting ? "var(--txd)" : "var(--acc)" }}>
            {starting ? "Starting…" : runErr ? "Failed" : "▸ Run"}
          </button>
        )}
        {runSlot === "setup" && (
          <button type="button" className="caps" onClick={onOpenRun}
            title="No run command saved for this project — set one in its TERMINAL tab"
            style={{ appearance: "none", flex: "none", cursor: "pointer", fontFamily: "inherit",
                     fontSize: "var(--t9)", letterSpacing: 1.5, padding: 0, border: 0,
                     background: "transparent", color: "var(--txd)" }}>
            Set up run
          </button>
        )}
      </div>
      {commit && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "9px 12px",
                      fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txd)",
                      borderBottom: tree ? `1px solid ${RULE}` : undefined }}
             title={`${commit.sha.slice(0, 7)} · ${commit.author}`}>
          <span className="caps" style={{ letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>Last</span>
          <span style={{ color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden",
                         textOverflow: "ellipsis", minWidth: 0 }}>{commit.subject}</span>
          <span style={{ flex: "none" }}>{ago(commit.ts)}</span>
        </div>
      )}

      {/* LOCAL — what is open off the default branch */}
      {tree && (
        <div style={{ fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txd)",
                      padding: rows.length ? "10px 0 7px" : "10px 0",
                      borderBottom: rows.length ? `1px solid ${RULE}` : undefined }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "0 12px 5px" }}>
            <span className="caps" style={{ letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>Local</span>
            <span>{rows.length
              ? [`${rows.length} branch${rows.length === 1 ? "" : "es"} off ${tree.def}`, busy && `${busy} working`,
                 merged && `${merged} merged`, rows.length - busy - merged && `${rows.length - busy - merged} idle`]
                .filter(Boolean).join(" · ")
              : `only ${tree.def} · nothing to merge or clean`}</span>
          </div>
          {rows.slice(0, MAX_ROWS).map((r) => {
            const v = r.session && view(r.session.id);
            const [glyph, word, c] = r.busy && v ? ["●", LANE_WORD[v.lane], v.c]
              : r.merged ? ["✓", "merged", "var(--txl)"]
              : r.session ? ["◆", `done ${ago(r.session.updated)}`, "var(--ask)"]
              : ["○", "no session", "var(--txl)"];
            const s = r.session;
            const cells = <>
              <span style={{ color: c }}>{glyph}</span>
              <span style={{ color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.branch}</span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                <span style={{ color: c }}>{word}</span>{s && ` · ${s.title || "untitled session"}`}
              </span>
            </>;
            const row = { display: "grid", gridTemplateColumns: `12px ${brw}ch minmax(0, 1fr)`, columnGap: 10,
                          alignItems: "baseline", padding: "3px 12px", fontSize: "var(--t95)", color: "var(--txd)" };
            return s ? (
              <button key={r.branch} type="button" className="fresh-row" onClick={() => local.onOpen(s.id)}
                title={`open “${s.title || "untitled session"}”`}
                style={{ ...row, appearance: "none", width: "100%", border: 0, background: "transparent",
                         textAlign: "left", fontFamily: "inherit", cursor: "pointer" }}>{cells}</button>
            ) : (
              <div key={r.branch} style={row} title={r.held ? "checked out in a worktree, no session yet" : undefined}>{cells}</div>
            );
          })}
          {rows.length > MAX_ROWS && (
            <div style={{ padding: "3px 12px 0 34px", color: "var(--txl)" }}>+{rows.length - MAX_ROWS} more</div>
          )}
        </div>
      )}

      {/* the openers you type most, as starters — shown only when there is something to do */}
      {rows.length > 0 && tree && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 12px 12px",
                      fontFamily: "var(--mono)", fontSize: "var(--t9)" }}>
          <span className="caps" style={{ letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>Start with</span>
          <button type="button" style={STARTER} onClick={() => local.onStart("clean up local", true)}
            title="puts “clean up local, then” in front of your prompt">
            clean up local, then …
          </button>
          {merge.length > 0 && (
            <button type="button" style={STARTER} onClick={() => local.onStart(mergeClause(merge, tree.def), false)}
              title={`puts “${mergeClause(merge, tree.def)}” in front of your prompt`}>
              merge {merge.length} branch{merge.length === 1 ? "" : "es"} into {tree.def}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const STARTER = {
  appearance: "none", cursor: "pointer", flex: "none", whiteSpace: "nowrap",
  border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
  background: "transparent", color: "var(--txm)", fontFamily: "inherit",
  fontSize: "var(--t9)", letterSpacing: 0.5, padding: "4px 10px",
} as const;
