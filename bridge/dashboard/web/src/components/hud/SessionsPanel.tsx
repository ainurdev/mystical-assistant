import { useEffect, useState } from "react";
import type { SessionBrief, SessionStatus } from "../../api";
import { api } from "../../api";
import { ago, projectTint } from "../../lib/surfaces";
import { Spinner } from "../ui";
import type { ProjectGroup } from "./ProjectsPanel";

interface Props {
  sessions: SessionBrief[]; // full list — the RECENT view + drill-down need more than the capped group slices
  groups: ProjectGroup[];
  status: Map<string, SessionStatus>;
  selectedSessionId: string | null;
  loadingSessionId: string | null;
  activeProject: string | null;
  onSelectSession: (s: SessionBrief) => void;
  onAnalyze: (rel: string) => void;
  onNewSession: (rel: string) => void;
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string) => void;
  onFeed: (texts: string[]) => void; // first instruction → composer
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

function SessionRow({
  s, i, on, loading, sv, branch, onAttach, onAnalyzeProj,
}: {
  s: SessionBrief;
  i: number;
  on: boolean;
  loading: boolean;
  sv: { c: string; l: string };
  branch: string;
  onAttach: () => void;
  onAnalyzeProj: () => void;
}) {
  const [hov, setHov] = useState(false);
  const [tagHov, setTagHov] = useState(false);
  const tint = projectTint(s.project);
  const idle = sv.l === "IDLE";
  return (
    <div
      onClick={onAttach}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      data-ctx-type="session" data-ctx-id={s.id} data-ctx-label={s.title || "session"}
      style={{
        display: "flex", gap: 10, padding: "10px 11px", marginBottom: 7, cursor: "pointer",
        border: `1px solid ${on ? "rgba(127,233,216,.3)" : "rgba(127,233,216,.1)"}`,
        borderLeft: `2px solid ${on ? "#7fe9d8" : "transparent"}`,
        background: on ? "rgba(127,233,216,.08)" : hov ? "rgba(127,233,216,.06)" : "rgba(7,13,13,.35)",
        transition: "background .18s ease", animation: "mfadeup .4s ease both",
        animationDelay: `${Math.min(i, 10) * 35}ms`,
      }}
    >
      {loading ? (
        <span style={{ color: "#7fe9d8", flex: "none", marginTop: 3, display: "flex" }}><Spinner className="h-[9px] w-[9px] border" /></span>
      ) : (
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: sv.c, flex: "none", marginTop: 4, boxShadow: `0 0 7px ${idle ? "transparent" : sv.c}` }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.4, color: on ? "#eafff9" : "#cfe9e3", fontWeight: on ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {s.title || "untitled session"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 6 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onAnalyzeProj(); }} title="analyze project"
            onMouseEnter={() => setTagHov(true)} onMouseLeave={() => setTagHov(false)}
            style={{ appearance: "none", cursor: "pointer", flex: "none", fontSize: 8.5, letterSpacing: 0.5, color: tint.color, border: `1px solid ${tint.border}`, background: tagHov ? "rgba(127,233,216,.08)" : "transparent", fontFamily: "inherit", padding: "1px 6px" }}
          >{tint.tag}</button>
          <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: "#a78bf0", minWidth: 0 }} title="worktree">
            <span style={{ color: "#b9a6ff", flex: "none" }}>⎇</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{branch}</span>
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 8.5, letterSpacing: 1, color: sv.c, flex: "none" }}>{loading ? "LOADING…" : sv.l}</span>
          <span style={{ fontSize: 9, color: "#3c544f", flex: "none" }}>{ago(s.updated)}</span>
        </div>
      </div>
    </div>
  );
}

function ShowMore({ count, onClick }: { count: number; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        width: "100%", margin: "1px 0 9px", appearance: "none", cursor: "pointer",
        border: `1px dashed ${hov ? "rgba(127,233,216,.4)" : "rgba(127,233,216,.22)"}`,
        background: hov ? "rgba(127,233,216,.05)" : "transparent",
        color: hov ? "#bfe6de" : "#7f9d97", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5,
        padding: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
      }}
    >SHOW MORE · {count}<span style={{ fontSize: 12, lineHeight: 0 }}>→</span></button>
  );
}

export function SessionsPanel(props: Props) {
  const {
    sessions, groups, status, selectedSessionId, loadingSessionId, activeProject,
    onSelectSession, onAnalyze, onNewSession, onWorktreeSession, onFeed,
  } = props;

  // New-session form.
  const [nsOpen, setNsOpen] = useState(false);
  const [nsProject, setNsProject] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [nsBranch, setNsBranch] = useState("");
  const [nsNewOpen, setNsNewOpen] = useState(false);
  const [nsNewBranch, setNsNewBranch] = useState("");
  const [nsParent, setNsParent] = useState("");
  const [nsTask, setNsTask] = useState("");

  // Browser state.
  const [tab, setTab] = useState<"recent" | "grouped">("recent");
  const [drill, setDrill] = useState<string | null>(null);
  const [recentLimit, setRecentLimit] = useState(8);

  // Hovers.
  const [nsBtnHov, setNsBtnHov] = useState(false);
  const [closeHov, setCloseHov] = useState(false);
  const [startHov, setStartHov] = useState(false);
  const [cancelHov, setCancelHov] = useState(false);
  const [backHov, setBackHov] = useState(false);
  const [chipHov, setChipHov] = useState("");

  // Branches power the WORKTREE chips + parent cycle — load per selected project
  // while the form is open (same endpoint the old inline picker used).
  useEffect(() => {
    if (!nsOpen || !nsProject) return;
    let live = true;
    void api.branches(nsProject).then((b) => {
      if (!live) return;
      const cur = b.current || b.branches[0] || "main";
      setBranches(b.branches);
      setCurrent(cur);
      setNsBranch(cur);
      setNsParent(cur);
    }).catch(() => {});
    return () => { live = false; };
  }, [nsOpen, nsProject]);

  const sessionTotal = groups.reduce((n, g) => n + g.sessionCount, 0);
  const branchOf = new Map(groups.map((g) => [g.rel, g.badge?.branch]));
  const sorted = [...sessions].sort((a, b) => b.updated - a.updated);

  function toggleForm() {
    if (!nsOpen) {
      setNsProject((p) => p ?? activeProject ?? groups[0]?.rel ?? null);
      setBranches([]); setCurrent(""); setNsBranch(""); setNsParent("");
      setNsNewOpen(false); setNsNewBranch("");
    }
    setNsOpen((o) => !o);
  }

  function start() {
    if (!nsProject) return;
    const nb = nsNewOpen ? nsNewBranch.trim().replace(/\s+/g, "-") : "";
    // Same routing as the old per-project picker: new branch → create worktree,
    // other existing branch → attach worktree, current branch → plain session.
    if (nb) onWorktreeSession(nsProject, nb, true, nsParent || undefined);
    else if (nsBranch && current && nsBranch !== current) onWorktreeSession(nsProject, nsBranch, false);
    else onNewSession(nsProject);
    const t = nsTask.trim();
    if (t) onFeed([t]); // pre-fill the composer with the first instruction
    setNsOpen(false); setNsNewOpen(false); setNsNewBranch(""); setNsTask("");
  }

  function cycleParent() {
    const i = Math.max(0, branches.indexOf(nsParent));
    setNsParent(branches[(i + 1) % Math.max(1, branches.length)] || nsParent);
  }

  const rowFor = (s: SessionBrief, i: number) => (
    <SessionRow
      key={s.id} s={s} i={i}
      on={s.id === selectedSessionId} loading={s.id === loadingSessionId}
      sv={statusView(status.get(s.id))}
      branch={s.branch || branchOf.get(s.project) || "main"}
      onAttach={() => onSelectSession(s)}
      onAnalyzeProj={() => onAnalyze(s.project)}
    />
  );

  const drillGroup = drill ? groups.find((g) => g.rel === drill) : undefined;
  const drillSessions = drill ? sorted.filter((s) => s.project === drill) : [];
  const drillTint = projectTint(drill ?? "");

  return (
    <div className="panel" style={{ border: "1px solid rgba(127,233,216,.16)", background: "rgba(9,16,16,.86)", animation: "enterLeft .55s cubic-bezier(.2,.8,.2,1) both .12s", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", flex: "none" }}>
        <span style={{ fontSize: 10.5, letterSpacing: 2.5, color: "#3c544f" }}>SESSIONS</span>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#7fe9d8" }}>{groups.length} PROJ · {sessionTotal} SESS</span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,#7fe9d8,rgba(127,233,216,.05))", transformOrigin: "left", animation: "drawline .7s ease both .16s", flex: "none" }} />

      <div style={{ flex: "none", display: "flex", gap: 7, padding: "10px 10px 3px" }}>
        <button
          onClick={toggleForm} title="start a session — current worktree or a new one"
          onMouseEnter={() => setNsBtnHov(true)} onMouseLeave={() => setNsBtnHov(false)}
          style={{
            flex: 1, appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            border: `1px solid ${nsOpen ? "rgba(185,166,255,.5)" : "rgba(127,233,216,.3)"}`,
            background: nsOpen ? "rgba(185,166,255,.12)" : "rgba(127,233,216,.06)",
            color: nsOpen ? "#e7deff" : "#bfe6de",
            fontFamily: "inherit", fontSize: 10.5, letterSpacing: 1.5, padding: "10px 8px",
            transition: "all .15s ease", filter: nsBtnHov ? "brightness(1.18)" : "none",
          }}
        ><span style={{ fontSize: 14, lineHeight: 0 }}>+</span>NEW SESSION</button>
      </div>

      <div className="mscroll" style={{ flex: 1, padding: "9px 9px 11px" }}>
        {nsOpen && (
          <div style={{ border: "1px solid rgba(185,166,255,.3)", background: "linear-gradient(160deg,rgba(185,166,255,.07),rgba(9,16,16,.4))", padding: 12, marginBottom: 11, animation: "mslide .22s ease both" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 11 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#b9a6ff", flex: "none" }} />
              <span style={{ fontSize: 9, letterSpacing: 1.5, color: "#cbb8ff" }}>NEW SESSION</span>
              <span style={{ flex: 1 }} />
              <button
                onClick={toggleForm} title="close"
                onMouseEnter={() => setCloseHov(true)} onMouseLeave={() => setCloseHov(false)}
                style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: closeHov ? "#cbb8ff" : "#6f6088", fontFamily: "inherit", fontSize: 13, lineHeight: 1, padding: "2px 4px" }}
              >✕</button>
            </div>
            <div style={{ fontSize: 8, letterSpacing: 1.5, color: "#3c544f", marginBottom: 6 }}>PROJECT</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {groups.map((g) => {
                const on = g.rel === nsProject;
                const hov = chipHov === `p:${g.rel}`;
                const tint = projectTint(g.rel);
                return (
                  <button
                    key={g.rel} onClick={() => setNsProject(g.rel)}
                    onMouseEnter={() => setChipHov(`p:${g.rel}`)} onMouseLeave={() => setChipHov("")}
                    style={{
                      appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                      border: `1px solid ${on || hov ? "#7fe9d8" : "rgba(127,233,216,.18)"}`,
                      background: on ? "rgba(127,233,216,.1)" : "rgba(7,13,13,.4)",
                      color: on ? "#dff8f2" : "#9fc7c0",
                      fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "4px 8px", minWidth: 0, maxWidth: "100%",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: tint.color, flex: "none" }} />
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 8, letterSpacing: 1.5, color: "#3c544f", margin: "12px 0 6px" }}>WORKTREE</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {branches.map((b) => {
                const on = !nsNewOpen && b === nsBranch;
                const hov = chipHov === `b:${b}`;
                return (
                  <button
                    key={b} onClick={() => { setNsBranch(b); setNsNewOpen(false); }}
                    onMouseEnter={() => setChipHov(`b:${b}`)} onMouseLeave={() => setChipHov("")}
                    style={{
                      appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                      border: `1px solid ${on || hov ? "#b9a6ff" : "rgba(185,166,255,.3)"}`,
                      background: on ? "rgba(185,166,255,.16)" : "rgba(185,166,255,.06)",
                      color: on ? "#e7deff" : "#cbb8ff",
                      fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "5px 8px", maxWidth: "100%", minWidth: 0,
                    }}
                  >
                    <span style={{ color: "#b9a6ff", flex: "none" }}>⎇</span>
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b}</span>
                  </button>
                );
              })}
              <button
                onClick={() => setNsNewOpen((o) => !o)} title="create a new worktree branch"
                style={{ appearance: "none", cursor: "pointer", border: `1px solid ${nsNewOpen ? "#b9a6ff" : "rgba(185,166,255,.3)"}`, background: nsNewOpen ? "rgba(185,166,255,.14)" : "transparent", color: "#cbb8ff", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 0.5, padding: "5px 9px" }}
              >+ NEW WORKTREE</button>
            </div>
            {nsNewOpen && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                  <span style={{ fontSize: 8, letterSpacing: 1, color: "#6f6088", flex: "none" }}>FROM</span>
                  <button
                    onClick={cycleParent} title="parent branch — click to cycle"
                    style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, border: "1px solid rgba(185,166,255,.3)", background: "rgba(185,166,255,.06)", color: "#cbb8ff", fontFamily: "'JetBrains Mono',monospace", fontSize: 9, padding: "3px 7px", minWidth: 0 }}
                  >
                    <span style={{ color: "#b9a6ff", flex: "none" }}>⎇</span>
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>{nsParent || "main"}</span>
                    <span style={{ color: "#6f6088", flex: "none" }}>⟳</span>
                  </button>
                </div>
                <input
                  value={nsNewBranch} onChange={(e) => setNsNewBranch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && nsNewBranch.trim()) start(); }}
                  placeholder="new-worktree-branch"
                  style={{ width: "100%", boxSizing: "border-box", marginTop: 7, background: "rgba(7,13,13,.6)", border: "1px solid rgba(185,166,255,.35)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "7px 9px" }}
                />
              </>
            )}
            <textarea
              value={nsTask} onChange={(e) => setNsTask(e.target.value)}
              placeholder="first instruction for Claude…"
              style={{ width: "100%", boxSizing: "border-box", minHeight: 58, resize: "vertical", marginTop: 10, background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "inherit", fontSize: 12, lineHeight: 1.5, padding: "9px 10px" }}
            />
            <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
              <button
                onClick={start}
                onMouseEnter={() => setStartHov(true)} onMouseLeave={() => setStartHov(false)}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid #b9a6ff", background: startHov ? "rgba(185,166,255,.26)" : "rgba(185,166,255,.16)", color: "#e7deff", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 9, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              ><span style={{ color: "#b9a6ff" }}>▸</span>START SESSION</button>
              <button
                onClick={toggleForm}
                onMouseEnter={() => setCancelHov(true)} onMouseLeave={() => setCancelHov(false)}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.2)", background: cancelHov ? "rgba(127,233,216,.06)" : "transparent", color: "#6f938d", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "9px 12px" }}
              >CANCEL</button>
            </div>
          </div>
        )}

        {drill ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 2px 11px" }}>
              <button
                onClick={() => setDrill(null)} title="back to projects"
                onMouseEnter={() => setBackHov(true)} onMouseLeave={() => setBackHov(false)}
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, border: "1px solid rgba(127,233,216,.25)", background: backHov ? "rgba(127,233,216,.16)" : "rgba(127,233,216,.06)", color: "#bfe6de", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "5px 10px" }}
              ><span style={{ fontSize: 13, lineHeight: 0 }}>←</span>BACK</button>
              <span style={{ fontSize: 8.5, letterSpacing: 0.5, color: drillTint.color, border: `1px solid ${drillTint.border}`, padding: "1px 6px", flex: "none" }}>{drillTint.tag}</span>
              <span style={{ fontSize: 10.5, color: "#cfe9e3", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{drillGroup?.name ?? drill}</span>
              <span style={{ fontSize: 8.5, letterSpacing: 1, color: "#5a6f6a", flex: "none" }}>{drillSessions.length} SESS</span>
            </div>
            {drillSessions.map((s, i) => rowFor(s, i))}
          </>
        ) : (
          <>
            <div style={{ display: "flex", gap: 3, margin: "4px 2px 11px", border: "1px solid rgba(127,233,216,.14)", background: "rgba(7,13,13,.3)", padding: 3 }}>
              <button
                onClick={() => setTab("recent")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: 0, background: tab === "recent" ? "rgba(127,233,216,.14)" : "transparent", color: tab === "recent" ? "#dff8f2" : "#5a6f6a", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: 7, transition: "all .15s ease" }}
              >RECENT</button>
              <button
                onClick={() => setTab("grouped")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: 0, background: tab === "grouped" ? "rgba(127,233,216,.14)" : "transparent", color: tab === "grouped" ? "#dff8f2" : "#5a6f6a", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: 7, transition: "all .15s ease" }}
              >BY PROJECT</button>
            </div>
            {tab === "recent" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 10px" }}>
                  <span style={{ fontSize: 9.5, letterSpacing: 2, color: "#3c544f", flex: "none" }}>RECENT SESSIONS</span>
                  <span style={{ flex: 1, height: 1, background: "rgba(127,233,216,.1)" }} />
                  <span style={{ fontSize: 8.5, letterSpacing: 0.5, color: "#5a6f6a", flex: "none" }}>newest first</span>
                </div>
                {sorted.slice(0, recentLimit).map((s, i) => rowFor(s, i))}
                {sorted.length > recentLimit && (
                  <ShowMore count={sorted.length - recentLimit} onClick={() => setRecentLimit((l) => l + 10)} />
                )}
              </>
            ) : (
              groups.map((g) => {
                const tint = projectTint(g.rel);
                const more = g.sessionCount - g.sessions.length;
                return (
                  <div key={g.rel}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, margin: "13px 2px 8px" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: tint.color, flex: "none" }} />
                      <span style={{ fontSize: 8.5, letterSpacing: 0.5, color: tint.color, border: `1px solid ${tint.border}`, padding: "1px 6px", flex: "none" }}>{tint.tag}</span>
                      <span style={{ fontSize: 10.5, color: "#9fc7c0", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
                      <span style={{ flex: 1, height: 1, background: "rgba(127,233,216,.1)" }} />
                      <span style={{ fontSize: 8.5, color: "#5a6f6a", flex: "none" }}>{g.sessionCount} SESS</span>
                    </div>
                    {g.sessions.map((s, i) => rowFor(s, i))}
                    {more > 0 && <ShowMore count={more} onClick={() => setDrill(g.rel)} />}
                  </div>
                );
              })
            )}
          </>
        )}
        {groups.length === 0 && (
          <div style={{ fontSize: 11, color: "#3c544f", padding: "10px 4px" }}>No projects with sessions yet.</div>
        )}
      </div>
    </div>
  );
}
