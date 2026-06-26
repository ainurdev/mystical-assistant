import { useEffect, useState } from "react";
import type { GitBadge, SessionBrief, SessionStatus, Worktree } from "../../api";
import { api } from "../../api";
import { ago, projectTint, surfaceFor } from "../../lib/surfaces";

export interface ProjectGroup {
  rel: string;
  name: string;
  badge?: GitBadge;
  sessions: SessionBrief[];
  running: boolean;
}

interface Props {
  groups: ProjectGroup[];
  status: Map<string, SessionStatus>;
  selectedSessionId: string | null;
  onSelectProject: (rel: string) => void;
  onSelectSession: (s: SessionBrief) => void;
  onAnalyze: (rel: string) => void;
  onNewSession: (rel: string) => void;
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string) => void;
  onCreateProject: (name: string, prompt: string) => void;
}

const STATUS_VIEW: Record<string, { c: string; l: string }> = {
  working: { c: "#8fd9a8", l: "WORK" },
  awaiting: { c: "#e3c279", l: "WAIT" },
  live: { c: "#6fb5ff", l: "LIVE" },
  idle: { c: "#5a6f6a", l: "IDLE" },
};

function statusView(s: SessionStatus | undefined) {
  return STATUS_VIEW[s?.state ?? "idle"] ?? STATUS_VIEW.idle;
}

function ProjectCard({
  g, status, selectedSessionId, active, onSelectProject, onSelectSession, onAnalyze,
  onNewSession, onWorktreeSession,
}: {
  g: ProjectGroup;
  active: boolean;
} & Omit<Props, "groups" | "onCreateProject">) {
  const tint = projectTint(g.rel);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [parent, setParent] = useState<string>("");
  const [newBranch, setNewBranch] = useState("");
  const badge = g.badge;
  const dirty = badge?.dirty ?? 0;

  // Lazily load branches + worktrees the first time the picker opens, so we can
  // offer existing branches and map worktree sessions to their branch.
  useEffect(() => {
    if (!pickerOpen || branches.length) return;
    let live = true;
    void api.branches(g.rel).then((b) => {
      if (!live) return;
      setBranches(b.branches);
      setParent(b.current || b.branches[0] || "main");
    }).catch(() => {});
    void api.worktrees(g.rel).then((w) => { if (live) setWorktrees(w.worktrees); }).catch(() => {});
    return () => { live = false; };
  }, [pickerOpen, g.rel, branches.length]);

  function branchForSession(s: SessionBrief): string {
    const wt = worktrees.find((w) => w.path === s.cwd);
    return wt?.branch || badge?.branch || "main";
  }

  return (
    <div
      data-ctx-type="project" data-ctx-id={g.rel} data-ctx-label={g.name}
      style={{ border: "1px solid rgba(127,233,216,.08)", borderLeft: `2px solid ${active ? "#7fe9d8" : "transparent"}`, background: active ? "rgba(127,233,216,.06)" : "transparent", marginBottom: 9, animation: "mfadeup .4s ease both" }}
    >
      <button onClick={() => onSelectProject(g.rel)}
        style={{ width: "100%", appearance: "none", border: 0, background: "transparent", cursor: "pointer", fontFamily: "inherit", textAlign: "left", padding: "9px 10px 6px", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: g.running ? "#8fd9a8" : dirty > 0 ? "#e3c279" : "#3c544f", flex: "none" }} />
        <span style={{ fontSize: 12.5, color: "#dff8f2", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
        {g.running && <span style={{ fontSize: 9, letterSpacing: 1, color: "#8fd9a8", border: "1px solid rgba(143,217,168,.3)", padding: "1px 5px", flex: "none" }}>LIVE</span>}
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 11px 7px 20px", fontSize: 10, color: "#6f938d" }}>
        <span style={{ color: "#7fe9d8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>⎇ {badge?.branch || "—"}</span>
        <span style={{ display: "flex", gap: 8, flex: "none", fontFamily: "'JetBrains Mono',monospace" }}>
          <span style={{ color: dirty > 0 ? "#e3c279" : "#3c544f" }}>●{dirty}</span>
          <span>↑{badge?.ahead ?? 0}</span>
          <span>↓{badge?.behind ?? 0}</span>
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 10px 9px 20px" }}>
        <span style={{ fontSize: 9, letterSpacing: ".5px", color: "#6f938d", flex: 1 }}>{g.sessions.length} SESSIONS</span>
        <button onClick={() => onAnalyze(g.rel)}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.3)", background: "rgba(127,233,216,.06)", color: "#bfe6de", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "4px 10px" }}>ANALYZE ▸</button>
      </div>

      {g.sessions.length > 0 ? (
        <div style={{ borderTop: "1px solid rgba(127,233,216,.07)", padding: "6px 8px 7px", display: "flex", flexDirection: "column", gap: 3, background: "rgba(7,13,13,.25)" }}>
          {g.sessions.map((s) => {
            const on = s.id === selectedSessionId;
            const sv = statusView(status.get(s.id));
            const surf = surfaceFor(s.origin);
            return (
              <div key={s.id} onClick={() => onSelectSession(s)}
                data-ctx-type="session" data-ctx-id={s.id} data-ctx-label={s.title || "session"}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", cursor: "pointer", borderLeft: `2px solid ${on ? "#7fe9d8" : "transparent"}`, background: on ? "rgba(127,233,216,.13)" : "transparent", transition: "background .2s ease" }}>
                <span style={{ width: on ? 7 : 5, height: on ? 7 : 5, borderRadius: "50%", background: sv.c, flex: "none" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: on ? "#eafff9" : "#aeccc6", fontWeight: on ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title || "untitled session"}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                    <span title="surface" style={{ fontSize: 8, letterSpacing: 1, color: surf.color, border: `1px solid ${surf.color}`, padding: "0 4px", flex: "none" }}>{surf.code}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 8, color: "#a78bf0", border: "1px solid rgba(185,166,255,.24)", padding: "0 4px", maxWidth: 110, minWidth: 0 }}>
                      <span style={{ flex: "none" }}>⎇</span>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{branchForSession(s)}</span>
                    </span>
                    <span style={{ fontSize: 8, letterSpacing: 1, color: sv.c, flex: "none" }}>{sv.l}</span>
                    <span style={{ fontSize: 8.5, color: "#3c544f", flex: "none", marginLeft: "auto" }}>{ago(s.updated)}</span>
                  </div>
                </div>
                {on && <span style={{ fontSize: 8, letterSpacing: 1, color: "#7fe9d8", flex: "none" }}>● ON</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ borderTop: "1px solid rgba(127,233,216,.07)", padding: "7px 10px 8px 20px", fontSize: 9.5, color: "#3c544f" }}>
          No sessions yet — <span style={{ color: "#7fe9d8", cursor: "pointer" }} onClick={() => onNewSession(g.rel)}>+ NEW</span> to start one.
        </div>
      )}

      <div style={{ borderTop: "1px solid rgba(127,233,216,.07)", padding: "6px 9px 7px" }}>
        <button onClick={() => setPickerOpen((o) => !o)} title="start a session on a worktree"
          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: pickerOpen ? "#cbb8ff" : "#6f6088", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "2px 3px", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#b9a6ff", fontSize: 11 }}>⎇</span>+ SESSION ON WORKTREE
        </button>
        {pickerOpen && (
          <div style={{ animation: "mslide .2s ease both" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
              {branches.map((b) => (
                <button key={b} onClick={() => { onWorktreeSession(g.rel, b, false); setPickerOpen(false); }}
                  title="new session on this worktree"
                  style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: "1px solid rgba(185,166,255,.3)", background: "rgba(185,166,255,.06)", color: "#cbb8ff", fontFamily: "'JetBrains Mono',monospace", fontSize: 9, padding: "4px 7px", maxWidth: "100%", minWidth: 0 }}>
                  <span style={{ color: "#b9a6ff", flex: "none" }}>⎇</span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b}</span>
                </button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7 }}>
              <span style={{ fontSize: 8, letterSpacing: 1, color: "#6f6088", flex: "none" }}>FROM</span>
              <button onClick={() => { const i = Math.max(0, branches.indexOf(parent)); setParent(branches[(i + 1) % Math.max(1, branches.length)] || parent); }}
                title="change parent branch — click to cycle"
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, border: "1px solid rgba(185,166,255,.3)", background: "rgba(185,166,255,.06)", color: "#cbb8ff", fontFamily: "'JetBrains Mono',monospace", fontSize: 8.5, padding: "2px 6px", minWidth: 0 }}>
                <span style={{ color: "#b9a6ff", flex: "none" }}>⎇</span>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120 }}>{parent || "main"}</span>
                <span style={{ color: "#6f6088", flex: "none" }}>⟳</span>
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5 }}>
              <span style={{ color: "#b9a6ff", fontSize: 11, flex: "none" }}>⎇</span>
              <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newBranch.trim()) { onWorktreeSession(g.rel, newBranch.trim().replace(/\s+/g, "-"), true, parent); setNewBranch(""); setPickerOpen(false); } }}
                placeholder="new worktree branch…"
                style={{ flex: 1, minWidth: 0, background: "rgba(7,13,13,.6)", border: "1px solid rgba(185,166,255,.25)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, padding: "4px 7px" }} />
              <button onClick={() => { if (newBranch.trim()) { onWorktreeSession(g.rel, newBranch.trim().replace(/\s+/g, "-"), true, parent); setNewBranch(""); setPickerOpen(false); } }}
                title="create branch + worktree + session"
                style={{ appearance: "none", cursor: "pointer", border: "1px solid #b9a6ff", background: "rgba(185,166,255,.14)", color: "#e7deff", fontFamily: "inherit", fontSize: 8.5, letterSpacing: 1, padding: "5px 8px", flex: "none" }}>+ CREATE</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ProjectsPanel(props: Props) {
  const { groups, onCreateProject } = props;
  const [newOpen, setNewOpen] = useState(false);
  const [npName, setNpName] = useState("");
  const [npPrompt, setNpPrompt] = useState("");
  const sessionTotal = groups.reduce((n, g) => n + g.sessions.length, 0);
  const activeRel = groups.find((g) => g.sessions.some((s) => s.id === props.selectedSessionId))?.rel;

  return (
    <div className="panel" style={{ border: "1px solid rgba(127,233,216,.16)", background: "rgba(9,16,16,.5)", animation: "enterRight .55s cubic-bezier(.2,.8,.2,1) both .18s", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", flex: "none" }}>
        <span style={{ fontSize: 10.5, letterSpacing: 2.5, color: "#3c544f" }}>WORKSPACE</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#7fe9d8" }}>{groups.length} PROJ · {sessionTotal} SESS</span>
          <button onClick={() => setNewOpen((o) => !o)} title="new project from a prompt"
            style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(111,181,255,.35)", background: "rgba(111,181,255,.06)", color: "#9fc8ff", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 7px" }}>+ PROJ</button>
          <button onClick={() => activeRel && props.onNewSession(activeRel)} title="new session"
            style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.3)", background: "rgba(127,233,216,.06)", color: "#bfe6de", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 7px" }}>+ SESS</button>
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,#7fe9d8,rgba(127,233,216,.05))", transformOrigin: "left", animation: "drawline .7s ease both .16s", flex: "none" }} />
      <div className="mscroll" style={{ flex: 1, padding: "9px 9px 11px" }}>
        {newOpen && (
          <div style={{ border: "1px solid rgba(111,181,255,.32)", background: "rgba(111,181,255,.05)", padding: "11px 12px", marginBottom: 10, animation: "mslide .2s ease both" }}>
            <div style={{ fontSize: 9, letterSpacing: 1.5, color: "#3c544f", marginBottom: 9 }}>NEW PROJECT</div>
            <input value={npName} onChange={(e) => setNpName(e.target.value)} placeholder="project-name"
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(7,13,13,.6)", border: "1px solid rgba(111,181,255,.25)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "6px 9px" }} />
            <textarea value={npPrompt} onChange={(e) => setNpPrompt(e.target.value)} placeholder="starting prompt — what should Claude build first?"
              style={{ width: "100%", boxSizing: "border-box", minHeight: 60, resize: "vertical", marginTop: 8, background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "inherit", fontSize: 12, lineHeight: 1.5, padding: "8px 9px" }} />
            <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
              <button onClick={() => { if (npName.trim() && npPrompt.trim()) { onCreateProject(npName.trim(), npPrompt.trim()); setNpName(""); setNpPrompt(""); setNewOpen(false); } }}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid #6fb5ff", background: "rgba(111,181,255,.14)", color: "#dbeeff", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <span style={{ color: "#6fb5ff" }}>▸</span>CREATE & START</button>
              <button onClick={() => setNewOpen(false)}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.2)", background: "transparent", color: "#6f938d", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "8px 12px" }}>CANCEL</button>
            </div>
          </div>
        )}
        {groups.map((g) => (
          <ProjectCard key={g.rel} g={g} active={g.rel === activeRel} status={props.status}
            selectedSessionId={props.selectedSessionId} onSelectProject={props.onSelectProject}
            onSelectSession={props.onSelectSession} onAnalyze={props.onAnalyze}
            onNewSession={props.onNewSession} onWorktreeSession={props.onWorktreeSession} />
        ))}
        {groups.length === 0 && (
          <div style={{ fontSize: 11, color: "#3c544f", padding: "10px 4px" }}>No projects with sessions yet.</div>
        )}
      </div>
    </div>
  );
}
