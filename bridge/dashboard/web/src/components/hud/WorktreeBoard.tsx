import { useMemo, useState } from "react";
import { api, type GitStatus, type SessionBrief, type SessionStatus, type Worktree } from "../../api";
import { ago, surfaceFor } from "../../lib/surfaces";

/* Worktree-centric board: one card per branch (main checkout + each linked
   worktree under .worktrees), with that branch's sessions nested inside. New
   branch → new worktree → a session running in it. Replaces the worktree/session
   columns that used to live in the Overview tab. */

interface Props {
  project: string;
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  worktrees: Worktree[];
  git: GitStatus | null;
  selectedBranch: string;
  setSelectedBranch: (b: string) => void;
  onSelectSession: (s: SessionBrief) => void;
  onNewSession: (rel: string) => void;
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string) => void;
  onRefreshWt: () => void;
  onTerminal: (branch: string) => void;
}

function SessionRow({ s, st, onClick }: { s: SessionBrief; st: SessionStatus | undefined; onClick: () => void }) {
  const surf = surfaceFor(s.origin);
  const state = st?.state ?? "idle";
  const sc = state === "working" ? "#8fd9a8" : state === "awaiting" ? "#e3c279" : state === "live" ? "#6fb5ff" : "#5a6f6a";
  return (
    <div onClick={onClick} style={{ border: "1px solid rgba(127,233,216,.12)", marginBottom: 6, display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", cursor: "pointer" }}>
      <span style={{ fontSize: 9, letterSpacing: 1, color: surf.color, border: `1px solid ${surf.color}`, padding: "3px 4px", flex: "none", width: 30, textAlign: "center" }}>{surf.code}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "#cfe9e3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title || "untitled"}</div>
        <div style={{ fontSize: 9.5, color: "#3c544f", marginTop: 2 }}>{ago(s.updated)}</div>
      </div>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: sc, flex: "none" }} />
    </div>
  );
}

export function WorktreeBoard({
  project, sessions, status, worktrees, git, selectedBranch, setSelectedBranch,
  onSelectSession, onNewSession, onWorktreeSession, onRefreshWt, onTerminal,
}: Props) {
  const cur = git?.branch || "main";
  const [newBranch, setNewBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");

  // group every session under the branch of its run dir (worktree branch, else cur)
  const byBranch = useMemo(() => {
    const m = new Map<string, SessionBrief[]>();
    for (const s of sessions) {
      const b = s.branch || worktrees.find((w) => w.path === s.cwd)?.branch || cur;
      const arr = m.get(b); if (arr) arr.push(s); else m.set(b, [s]);
    }
    return m;
  }, [sessions, worktrees, cur]);

  const cards = useMemo(() => {
    const mains = worktrees.filter((w) => w.is_main);
    const links = worktrees.filter((w) => !w.is_main);
    const ordered = [...mains, ...links];
    if (ordered.length) return ordered;
    // not a multi-worktree repo (or status unavailable) → a single synthetic card
    return [{ path: project, rel: project, branch: cur, head: "", detached: false, is_main: true }] as Worktree[];
  }, [worktrees, project, cur]);

  async function remove(w: Worktree) {
    setBusy(true);
    try {
      const r = await api.worktreeRemove(project, w.path, w.branch, true);
      setBanner(r.ok ? `Removed worktree ${w.branch}` : `Failed: ${r.output}`);
      onRefreshWt();
    } finally { setBusy(false); }
    setTimeout(() => setBanner(""), 4000);
  }
  function createWt() {
    const b = newBranch.trim().replace(/\s+/g, "-");
    if (!b) return;
    onWorktreeSession(project, b, true, selectedBranch || cur);
    setNewBranch("");
  }

  return (
    <div className="mscroll" style={{ flex: 1, minHeight: 0, animation: "mslide .3s ease both" }}>
      {banner && (
        <div style={{ border: "1px solid rgba(127,233,216,.35)", background: "rgba(127,233,216,.06)", color: "#bfe6de", fontSize: 10.5, padding: "8px 11px", marginBottom: 12, fontFamily: "'JetBrains Mono',monospace" }}>▸ {banner}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#3c544f" }}>WORKTREES</span>
        <span style={{ fontSize: 8.5, color: "#6f6088" }}>{worktrees.filter((w) => !w.is_main).length} LINKED</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: "#6f938d", fontFamily: "'JetBrains Mono',monospace" }}>●{git?.dirty ?? 0} ↑{git?.ahead ?? 0} ↓{git?.behind ?? 0}</span>
      </div>

      {cards.map((w) => {
        const focused = w.branch === selectedBranch;
        const isMain = w.is_main;
        const sess = byBranch.get(w.branch) ?? [];
        const accent = focused ? "#7fe9d8" : "rgba(127,233,216,.32)";
        return (
          <div key={w.path} onClick={() => setSelectedBranch(w.branch)} data-ctx-type="branch" data-ctx-id={w.branch} data-ctx-label={w.branch}
            style={{ border: `1px solid ${accent}`, borderLeft: `2px solid ${accent}`, background: focused ? "rgba(127,233,216,.05)" : "transparent", padding: "11px 13px", marginBottom: 10, cursor: "pointer" }}>
            {/* card header */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "#7fe9d8", flex: "none" }}>⎇</span>
              <span style={{ flex: 1, minWidth: 0, fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: focused ? "#dff8f2" : "#cfe9e3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.branch}</span>
              {isMain
                ? <span style={{ fontSize: 8, letterSpacing: 1, color: "#06100e", background: "#7fe9d8", padding: "2px 6px", flex: "none" }}>{w.branch === cur ? "MAIN · HEAD" : "MAIN"}</span>
                : <span style={{ fontSize: 8, letterSpacing: 1, color: "#7fe9d8", flex: "none" }}>WORKTREE</span>}
              <span style={{ fontSize: 8.5, color: "#3c544f", flex: "none" }}>{sess.length} SESS</span>
            </div>
            {!isMain && <div style={{ marginTop: 6, fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#5a6f6a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={w.path}>{w.path}</div>}

            {/* nested sessions */}
            <div style={{ marginTop: 10 }}>
              {sess.map((s) => (
                <SessionRow key={s.id} s={s} st={status.get(s.id)} onClick={() => onSelectSession(s)} />
              ))}
              {sess.length === 0 && <div style={{ fontSize: 10.5, color: "#3c544f", padding: "2px 2px 6px" }}>No sessions on this branch.</div>}
            </div>

            {/* card actions */}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 }}>
              <button onClick={(e) => { e.stopPropagation(); isMain ? onNewSession(project) : onWorktreeSession(project, w.branch, false); }}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(185,166,255,.4)", background: "rgba(185,166,255,.06)", color: "#cbb8ff", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "5px 10px", display: "flex", alignItems: "center", gap: 5 }}><span style={{ fontSize: 12 }}>+</span>NEW SESSION</button>
              <button onClick={(e) => { e.stopPropagation(); onTerminal(w.branch); }}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.3)", background: "transparent", color: "#bfe6de", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "5px 10px", display: "flex", alignItems: "center", gap: 5 }}>⌗ TERMINAL</button>
              {!isMain && (
                <button onClick={(e) => { e.stopPropagation(); void remove(w); }} disabled={busy} title="delete worktree + branch"
                  style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(224,137,122,.28)", background: "transparent", color: "#9a6f68", fontFamily: "inherit", fontSize: 11, padding: "4px 9px", flex: "none", marginLeft: "auto", lineHeight: 1 }}>✕</button>
              )}
            </div>
          </div>
        );
      })}

      {/* new worktree */}
      <div style={{ border: "1px solid rgba(185,166,255,.25)", background: "rgba(185,166,255,.04)", padding: "9px 11px", marginTop: 4 }}>
        <div style={{ fontSize: 8, letterSpacing: 1, color: "#6f6088", marginBottom: 7 }}>NEW BRANCH → WORKTREE + SESSION · FROM <span style={{ color: "#cbb8ff" }}>{selectedBranch || cur}</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontSize: 13, color: "#b9a6ff", flex: "none" }}>⎇</span>
          <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createWt(); }}
            placeholder="new branch name…" style={{ flex: 1, minWidth: 0, background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "6px 9px" }} />
          <button onClick={createWt} style={{ appearance: "none", cursor: "pointer", border: "1px solid #b9a6ff", background: "rgba(185,166,255,.14)", color: "#e7deff", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "7px 11px", flex: "none" }}>▸ OPEN</button>
        </div>
      </div>
    </div>
  );
}
