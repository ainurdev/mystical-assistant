import { useEffect, useMemo, useState } from "react";
import {
  api,
  type CompareInfo,
  type GitBadge,
  type GitStatus,
  type Issue,
  type IssuesInfo,
  type SessionBrief,
  type SessionStatus,
  type Worktree,
} from "../../api";
import { ago, projectTint, surfaceFor } from "../../lib/surfaces";

type Tab = "overview" | "changes" | "issues" | "logs";

interface Props {
  project: string;
  badge?: GitBadge;
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  onClose: () => void;
  onFeed: (texts: string[]) => void;
  onSelectSession: (s: SessionBrief) => void;
  onNewSession: (rel: string) => void;
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string) => void;
  onCommit: () => void;
}

const FILE_COLOR = (s: string) => (s === "A" ? "#8fd9a8" : s === "D" ? "#e0897a" : "#e3c279");

function name(rel: string): string {
  return rel.replace(/\/+$/, "").split("/").pop() || rel;
}

export function AnalyzeModal(props: Props) {
  const { project, badge } = props;
  const tint = projectTint(project);
  const [tab, setTab] = useState<Tab>("overview");
  const [git, setGit] = useState<GitStatus | null>(null);
  const [issues, setIssues] = useState<IssuesInfo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [closing, setClosing] = useState(false);

  const refreshGit = () => { void api.git(project).then(setGit).catch(() => {}); };
  const refreshWt = () => { void api.worktrees(project).then((w) => setWorktrees(w.worktrees)).catch(() => {}); };

  useEffect(() => {
    refreshGit();
    void api.issues(project).then(setIssues).catch(() => {});
    void api.branches(project).then((b) => setBranches(b.branches)).catch(() => {});
    refreshWt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  function close() {
    setClosing(true);
    setTimeout(props.onClose, 260);
  }

  const dirty = git?.dirty ?? badge?.dirty ?? 0;
  const issueCount = issues?.open_count ?? 0;
  const tabs: { k: Tab; l: string; badge?: number }[] = [
    { k: "overview", l: "OVERVIEW" },
    { k: "changes", l: "CHANGES", badge: dirty || undefined },
    { k: "issues", l: "ISSUES", badge: issueCount || undefined },
    { k: "logs", l: "LOGS" },
  ];

  return (
    <div onClick={close}
      style={{ position: "fixed", inset: 0, background: "rgba(4,7,7,.72)", zIndex: 92, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "7vh", animation: closing ? "backdropOut .2s ease forwards" : "backdropIn .22s ease both" }}>
      <div onClick={(e) => e.stopPropagation()} className="panel"
        style={{ width: 880, maxWidth: "94vw", maxHeight: "84vh", display: "flex", flexDirection: "column", border: "1px solid rgba(127,233,216,.4)", background: "rgba(7,13,13,.98)", boxShadow: "0 0 70px rgba(0,0,0,.75),0 0 30px rgba(127,233,216,.08)", animation: closing ? "modalOut .28s ease-in forwards" : "modalIn .46s cubic-bezier(.16,.84,.3,1) both" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 18px", borderBottom: "1px solid rgba(127,233,216,.16)", flex: "none", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9.5, letterSpacing: 2.5, color: "#3c544f" }}>ANALYZE</span>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: tint.color }} />
          <span style={{ fontSize: 15, color: "#dff8f2", letterSpacing: ".5px" }}>{name(project)}</span>
          <span style={{ fontSize: 11, color: "#7fe9d8", border: "1px solid rgba(127,233,216,.25)", padding: "2px 8px" }}>⎇ {git?.branch || badge?.branch || "—"}</span>
          <span style={{ fontSize: 11, color: "#6f938d", display: "flex", gap: 9, fontFamily: "'JetBrains Mono',monospace" }}>
            <span style={{ color: "#8fd9a8" }}>↑{git?.ahead ?? badge?.ahead ?? 0}</span>
            <span>↓{git?.behind ?? badge?.behind ?? 0}</span>
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={close} style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.5, padding: "4px 10px" }}>ESC ✕</button>
        </div>
        {/* tabs */}
        <div style={{ display: "flex", flex: "none", borderBottom: "1px solid rgba(127,233,216,.12)", padding: "0 10px" }}>
          {tabs.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)}
              style={{ appearance: "none", border: 0, borderBottom: `2px solid ${tab === t.k ? "#7fe9d8" : "transparent"}`, cursor: "pointer", fontFamily: "inherit", fontSize: 10.5, letterSpacing: 1.5, padding: "11px 15px", background: tab === t.k ? "rgba(127,233,216,.06)" : "transparent", color: tab === t.k ? "#dff8f2" : "#3c544f", display: "flex", alignItems: "center", gap: 7 }}>
              {t.l}
              {t.badge != null && <span style={{ fontSize: 9, color: "#7fe9d8", border: "1px solid rgba(127,233,216,.3)", padding: "0 5px" }}>{t.badge}</span>}
            </button>
          ))}
        </div>
        {/* body */}
        <div className="mscroll" style={{ flex: 1, padding: 18 }}>
          {tab === "overview" && (
            <OverviewTab {...props} git={git} branches={branches} worktrees={worktrees}
              onRefreshWt={refreshWt} />
          )}
          {tab === "changes" && <ChangesTab project={project} git={git} onRefresh={refreshGit} onCommit={props.onCommit} />}
          {tab === "issues" && <IssuesTab project={project} info={issues} onFeed={props.onFeed} onReload={() => void api.issues(project).then(setIssues)} />}
          {tab === "logs" && <LogsTab />}
        </div>
      </div>
    </div>
  );
}

/* ---------------- OVERVIEW: sessions by branch + worktrees + PR ---------------- */
function OverviewTab({
  project, sessions, status, git, branches, worktrees, onSelectSession, onNewSession,
  onWorktreeSession, onRefreshWt,
}: Props & { git: GitStatus | null; branches: string[]; worktrees: Worktree[]; onRefreshWt: () => void }) {
  const cur = git?.branch || "main";
  const [newBranch, setNewBranch] = useState("");
  const [prOpen, setPrOpen] = useState(false);
  const [prBase, setPrBase] = useState("main");
  const [prTitle, setPrTitle] = useState("");
  const [prDiff, setPrDiff] = useState<CompareInfo | null>(null);
  const [prCreated, setPrCreated] = useState<{ number: number | null; url: string } | null>(null);
  const [banner, setBanner] = useState("");
  const [busy, setBusy] = useState(false);

  const wtByBranch = useMemo(() => {
    const m = new Map<string, Worktree>();
    for (const w of worktrees) m.set(w.branch, w);
    return m;
  }, [worktrees]);

  // sessions grouped by their worktree branch (fall back to current).
  const groups = useMemo(() => {
    const order: string[] = [];
    const map: Record<string, SessionBrief[]> = {};
    for (const s of sessions) {
      const wt = worktrees.find((w) => w.path === s.cwd);
      const b = wt?.branch || cur;
      if (!map[b]) { map[b] = []; order.push(b); }
      map[b].push(s);
    }
    return order.map((b) => ({ branch: b, sessions: map[b] }));
  }, [sessions, worktrees, cur]);

  useEffect(() => {
    if (!prOpen) return;
    void api.compare(project, prBase, cur).then(setPrDiff).catch(() => {});
  }, [prOpen, prBase, cur, project]);

  async function doMerge(branch: string) {
    setBusy(true);
    try {
      const r = await api.merge(project, branch, "main");
      setBanner(r.ok ? `Merged ${branch} → main` : `Merge failed: ${r.output}`);
      onRefreshWt();
    } finally { setBusy(false); }
    setTimeout(() => setBanner(""), 4500);
  }
  async function doRemove(w: Worktree) {
    setBusy(true);
    try {
      const r = await api.worktreeRemove(project, w.path, w.branch, true);
      setBanner(r.ok ? `Removed worktree ${w.branch}` : `Failed: ${r.output}`);
      onRefreshWt();
    } finally { setBusy(false); }
    setTimeout(() => setBanner(""), 4000);
  }
  async function doCheckout(ref: string) {
    setBusy(true);
    try { await api.checkout(project, ref); onRefreshWt(); } finally { setBusy(false); }
  }
  async function doCreatePr() {
    setBusy(true);
    try {
      const r = await api.createPr(project, cur, prBase, prTitle || `Merge ${cur} into ${prBase}`);
      if (r.ok) { setPrCreated({ number: r.number, url: r.url }); setPrOpen(false); }
      else setBanner(`PR failed: ${r.output}`);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ animation: "mslide .3s ease both" }}>
      {banner && (
        <div style={{ border: "1px solid rgba(127,233,216,.35)", background: "rgba(127,233,216,.06)", color: "#bfe6de", fontSize: 10.5, padding: "8px 11px", marginBottom: 12, fontFamily: "'JetBrains Mono',monospace" }}>▸ {banner}</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {/* left: sessions by branch */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#3c544f" }}>SESSIONS ON THIS PROJECT</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => onNewSession(project)} style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(185,166,255,.4)", background: "rgba(185,166,255,.06)", color: "#cbb8ff", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 9px", display: "flex", alignItems: "center", gap: 5 }}><span style={{ fontSize: 12 }}>+</span>NEW</button>
          </div>
          {groups.map((g) => (
            <div key={g.branch}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 0 7px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#cbb8ff", fontFamily: "'JetBrains Mono',monospace" }}><span style={{ color: "#b9a6ff" }}>⎇</span>{g.branch}</span>
                <span style={{ flex: 1, height: 1, background: "rgba(185,166,255,.16)" }} />
                <span style={{ fontSize: 8, letterSpacing: 1, color: "#6f6088" }}>{g.sessions.length} SESS</span>
              </div>
              {g.sessions.map((s) => {
                const surf = surfaceFor(s.origin);
                const st = status.get(s.id)?.state ?? "idle";
                const sc = st === "working" ? "#8fd9a8" : st === "awaiting" ? "#e3c279" : st === "live" ? "#6fb5ff" : "#5a6f6a";
                return (
                  <div key={s.id} onClick={() => onSelectSession(s)} style={{ border: "1px solid rgba(127,233,216,.12)", marginBottom: 7, display: "flex", alignItems: "center", gap: 9, padding: "10px", cursor: "pointer" }}>
                    <span style={{ fontSize: 9, letterSpacing: 1, color: surf.color, border: `1px solid ${surf.color}`, padding: "3px 4px", flex: "none", width: 30, textAlign: "center" }}>{surf.code}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "#cfe9e3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title || "untitled"}</div>
                      <div style={{ fontSize: 9.5, color: "#3c544f", marginTop: 2 }}>{ago(s.updated)}</div>
                    </div>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: sc, flex: "none" }} />
                  </div>
                );
              })}
            </div>
          ))}
          {sessions.length === 0 && <div style={{ fontSize: 11, color: "#3c544f", padding: "6px 2px" }}>No sessions on this project.</div>}
        </div>

        {/* right: worktrees + PR */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#3c544f" }}>WORKTREES</span>
            <span style={{ fontSize: 8.5, color: "#6f6088" }}>{worktrees.filter((w) => !w.is_main).length} OPEN</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 9, color: "#6f938d", fontFamily: "'JetBrains Mono',monospace" }}>●{git?.dirty ?? 0} ↑{git?.ahead ?? 0} ↓{git?.behind ?? 0}</span>
          </div>

          {/* main / base row */}
          <div style={{ display: "flex", alignItems: "center", gap: 9, border: "1px solid rgba(127,233,216,.12)", padding: "8px 11px", marginBottom: 8, background: "rgba(7,13,13,.3)" }}>
            <span style={{ fontSize: 12, color: "#7fe9d8", flex: "none" }}>⎇</span>
            <button onClick={() => doCheckout("main")} disabled={busy} style={{ flex: 1, minWidth: 0, appearance: "none", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: "#cfe9e3" }}>main</button>
            {cur === "main" && <span style={{ fontSize: 8, letterSpacing: 1, color: "#06100e", background: "#7fe9d8", padding: "2px 6px", flex: "none" }}>HEAD</span>}
          </div>

          {worktrees.filter((w) => !w.is_main).map((w) => (
            <div key={w.path} data-ctx-type="branch" data-ctx-id={w.branch} data-ctx-label={w.branch}
              style={{ border: `1px solid ${w.branch === cur ? "#7fe9d8" : "rgba(127,233,216,.32)"}`, borderLeft: `2px solid ${w.branch === cur ? "#7fe9d8" : "rgba(127,233,216,.32)"}`, background: w.branch === cur ? "rgba(127,233,216,.05)" : "transparent", padding: "9px 11px", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "#7fe9d8", flex: "none" }}>⎇</span>
                <button onClick={() => doCheckout(w.branch)} disabled={busy} style={{ flex: 1, minWidth: 0, appearance: "none", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: w.branch === cur ? "#dff8f2" : "#cfe9e3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.branch}</button>
                <span style={{ fontSize: 8, letterSpacing: 1, color: "#7fe9d8", flex: "none" }}>WORKTREE LIVE</span>
              </div>
              <div style={{ marginTop: 7, fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#5a6f6a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={w.path}>{w.path}</div>
              <div style={{ marginTop: 9, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <button onClick={() => onWorktreeSession(project, w.branch, false)} style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.3)", background: "transparent", color: "#bfe6de", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 9px", flex: "none", display: "flex", alignItems: "center", gap: 4 }}><span style={{ color: "#7fe9d8" }}>▸</span>ATTACH</button>
                <button onClick={() => doMerge(w.branch)} disabled={busy} style={{ appearance: "none", cursor: "pointer", border: "1px solid #8fd9a8", background: "rgba(143,217,168,.12)", color: "#dff8f2", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 10px", flex: "none", marginLeft: "auto", display: "flex", alignItems: "center", gap: 5 }}>MERGE → main</button>
                <button onClick={() => doRemove(w)} disabled={busy} title="delete worktree + branch" style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(224,137,122,.28)", background: "transparent", color: "#9a6f68", fontFamily: "inherit", fontSize: 11, padding: "5px 8px", flex: "none", lineHeight: 1 }}>✕</button>
              </div>
            </div>
          ))}

          {/* new worktree */}
          <div style={{ border: "1px solid rgba(185,166,255,.25)", background: "rgba(185,166,255,.04)", padding: "8px 9px" }}>
            <div style={{ fontSize: 8, letterSpacing: 1, color: "#6f6088", marginBottom: 7 }}>NEW WORKTREE FROM <span style={{ color: "#cbb8ff" }}>{cur}</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 13, color: "#b9a6ff", flex: "none" }}>⎇</span>
              <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newBranch.trim()) { onWorktreeSession(project, newBranch.trim().replace(/\s+/g, "-"), true, cur); setNewBranch(""); } }}
                placeholder="new branch name…" style={{ flex: 1, minWidth: 0, background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "5px 8px" }} />
              <button onClick={() => { if (newBranch.trim()) { onWorktreeSession(project, newBranch.trim().replace(/\s+/g, "-"), true, cur); setNewBranch(""); } }}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid #b9a6ff", background: "rgba(185,166,255,.14)", color: "#e7deff", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 10px", flex: "none" }}>▸ OPEN</button>
            </div>
          </div>

          {/* PR */}
          {prCreated && (
            <div style={{ marginTop: 11, border: "1px solid rgba(143,217,168,.35)", background: "rgba(143,217,168,.06)", padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: "#8fd9a8" }}>⇡ PR {prCreated.number ? `#${prCreated.number}` : "opened"}</span>
                <span style={{ flex: 1 }} />
                {prCreated.url && <a href={prCreated.url} target="_blank" rel="noreferrer" style={{ fontSize: 9, letterSpacing: 1, color: "#8fd9a8", border: "1px solid rgba(143,217,168,.4)", padding: "1px 6px", textDecoration: "none" }}>OPEN ↗</a>}
              </div>
            </div>
          )}
          {prOpen ? (
            <div style={{ marginTop: 11, border: "1px solid rgba(185,166,255,.32)", background: "rgba(185,166,255,.05)", padding: "11px 12px" }}>
              <div style={{ fontSize: 9, letterSpacing: 1.5, color: "#3c544f", marginBottom: 8 }}>NEW PULL REQUEST · {cur} → {prBase}</div>
              <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder="pull request title…" style={{ width: "100%", boxSizing: "border-box", background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "inherit", fontSize: 11.5, padding: "7px 9px" }} />
              <div style={{ fontSize: 8.5, letterSpacing: 1.5, color: "#3c544f", margin: "10px 0 6px" }}>MERGE INTO</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {["main", ...branches.filter((b) => b !== cur && b !== "main")].map((b) => (
                  <button key={b} onClick={() => setPrBase(b)} style={{ appearance: "none", cursor: "pointer", border: `1px solid ${b === prBase ? "#b9a6ff" : "rgba(127,233,216,.18)"}`, background: b === prBase ? "rgba(185,166,255,.18)" : "transparent", color: b === prBase ? "#e7deff" : "#9fc7c0", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, padding: "5px 8px" }}>⎇ {b}</button>
                ))}
              </div>
              {prDiff && (
                <div style={{ marginTop: 9, border: "1px solid rgba(127,233,216,.12)", background: "rgba(7,13,13,.5)", padding: "8px 10px", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#6f938d" }}>
                  {prDiff.commits} commits · {prDiff.files.length} files · <span style={{ color: "#8fd9a8" }}>+{prDiff.add}</span> <span style={{ color: "#e0897a" }}>−{prDiff.del}</span>
                </div>
              )}
              <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
                <button onClick={doCreatePr} disabled={busy} style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid #b9a6ff", background: "rgba(185,166,255,.14)", color: "#e7deff", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 7 }}>OPEN PR</button>
                <button onClick={() => setPrOpen(false)} style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.2)", background: "transparent", color: "#6f938d", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "7px 12px" }}>CANCEL</button>
              </div>
            </div>
          ) : (
            <button onClick={() => { setPrOpen(true); setPrTitle(`Merge ${cur} into main`); }} disabled={cur === "main"}
              title={cur === "main" ? "check out a feature branch to open a PR" : "open a pull request"}
              style={{ width: "100%", marginTop: 11, appearance: "none", cursor: cur === "main" ? "not-allowed" : "pointer", border: `1px solid ${cur === "main" ? "rgba(127,233,216,.12)" : "rgba(127,233,216,.3)"}`, background: "transparent", color: cur === "main" ? "#3c544f" : "#bfe6de", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 9 }}>⇡ CREATE PULL REQUEST</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- CHANGES: file list + diff + commit/push ---------------- */
function ChangesTab({ project, git, onRefresh, onCommit }: { project: string; git: GitStatus | null; onRefresh: () => void; onCommit: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const files = git?.files ?? [];
  const selName = sel ?? files[0]?.path ?? null;

  useEffect(() => {
    if (!selName) { setDiff(""); return; }
    void api.gitDiff(project, selName).then((d) => setDiff(d.diff)).catch(() => setDiff(""));
  }, [selName, project]);

  const selFile = files.find((f) => f.path === selName);
  const lines = diff.split("\n");

  async function commit() {
    if (!msg.trim()) return;
    setBusy(true);
    try {
      const r = await api.gitCommit(project, msg.trim());
      if (r.ok) { setMsg(""); onCommit(); onRefresh(); }
    } finally { setBusy(false); }
  }
  async function push() { setBusy(true); try { await api.gitPush(project); onRefresh(); } finally { setBusy(false); } }
  function gen() {
    const verbs = files.length > 3 ? "update" : "tweak";
    const names = files.slice(0, 3).map((f) => f.path.split("/").pop()).join(", ");
    setMsg(`chore: ${verbs} ${names}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`);
  }

  if (git && git.dirty === 0) return <div style={{ fontSize: 12, color: "#6f938d", fontFamily: "'JetBrains Mono',monospace", padding: "6px 2px", animation: "mslide .3s ease both" }}>Working tree clean.</div>;

  return (
    <div style={{ animation: "mslide .3s ease both" }}>
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", border: "1px solid rgba(127,233,216,.12)", minHeight: 362 }}>
        <div style={{ borderRight: "1px solid rgba(127,233,216,.12)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ fontSize: 9, letterSpacing: 1.5, color: "#3c544f", padding: "11px 12px 8px", flex: "none" }}>CHANGED · {files.length}</div>
          <div className="mscroll" style={{ flex: 1, minHeight: 0 }}>
            {files.map((f) => {
              const on = f.path === selName;
              return (
                <button key={f.path} onClick={() => setSel(f.path)} style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${on ? "#7fe9d8" : "transparent"}`, background: on ? "rgba(127,233,216,.08)" : "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 9, padding: "8px 10px" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, width: 13, textAlign: "center", flex: "none", color: FILE_COLOR(f.status) }}>{f.status}</span>
                  <span style={{ fontSize: 11, color: on ? "#dff8f2" : "#9fc7c0", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{f.path}</span>
                  <span style={{ fontSize: 10, flex: "none", display: "flex", gap: 5 }}><span style={{ color: "#8fd9a8" }}>+{f.add}</span><span style={{ color: "#e0897a" }}>−{f.del}</span></span>
                </button>
              );
            })}
          </div>
          <div style={{ borderTop: "1px solid rgba(127,233,216,.1)", flex: "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 9px 0" }}>
              <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="commit message…" style={{ flex: 1, minWidth: 0, background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "inherit", fontSize: 11, padding: "6px 8px" }} />
              <button onClick={gen} title="suggest a message" style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(185,166,255,.35)", background: "transparent", color: "#cbb8ff", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 9px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 5, height: 5, background: "#b9a6ff", transform: "rotate(45deg)" }} />GEN</button>
            </div>
            <div style={{ display: "flex", gap: 7, padding: "8px 9px 9px" }}>
              <button onClick={commit} disabled={busy || !msg.trim()} style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid #7fe9d8", background: "rgba(127,233,216,.12)", color: "#dff8f2", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 8, opacity: busy || !msg.trim() ? 0.5 : 1 }}>COMMIT ALL</button>
              <button onClick={push} disabled={busy} style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: "transparent", color: "#bfe6de", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "8px 12px" }}>PUSH ↑{git?.ahead ?? 0}</button>
            </div>
          </div>
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderBottom: "1px solid rgba(127,233,216,.1)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, flex: "none" }}>
            <span style={{ color: FILE_COLOR(selFile?.status ?? "M"), fontWeight: 700 }}>{selFile?.status ?? ""}</span>
            <span style={{ flex: 1, color: "#dff8f2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{selName || ""}</span>
            <span style={{ color: "#8fd9a8" }}>+{selFile?.add ?? 0}</span><span style={{ color: "#e0897a" }}>−{selFile?.del ?? 0}</span>
          </div>
          <div className="mscroll" style={{ flex: 1, minHeight: 0, fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, lineHeight: 1.7 }}>
            {lines.map((ln, i) => {
              const kind = ln.startsWith("@@") ? "hunk" : ln.startsWith("+") ? "add" : ln.startsWith("-") ? "del" : "ctx";
              const map = { add: { bg: "rgba(143,217,168,.07)", c: "#a7e6c3" }, del: { bg: "rgba(224,137,122,.07)", c: "#f0b0a8" }, hunk: { bg: "rgba(127,233,216,.06)", c: "#7fe9d8" }, ctx: { bg: "transparent", c: "#6f938d" } }[kind];
              return <div key={i} style={{ display: "flex", background: map.bg, padding: "0 10px" }}><span style={{ color: map.c, whiteSpace: "pre", flex: 1 }}>{ln || " "}</span></div>;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- ISSUES ---------------- */
function IssuesTab({ project, info, onFeed, onReload }: { project: string; info: IssuesInfo | null; onFeed: (t: string[]) => void; onReload: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [title, setTitle] = useState("");
  const issues = info?.issues ?? [];
  const sel = issues.find((i) => i.number === open) || null;

  async function create() {
    if (!title.trim()) return;
    await api.createIssue(project, title.trim(), "");
    setTitle(""); setNewOpen(false); onReload();
  }

  if (info && !info.has_remote) return <div style={{ fontSize: 12, color: "#6f938d", padding: "6px 2px" }}>No GitHub remote for this project.</div>;
  if (info && !info.gh_ok) return <div style={{ fontSize: 12, color: "#e0897a", padding: "6px 2px" }}>gh CLI unavailable: {info.error || "not authenticated"}.</div>;

  return (
    <div style={{ animation: "mslide .3s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#3c544f" }}>{info?.open_count ?? 0} OPEN ISSUES</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setNewOpen((o) => !o)} style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(185,166,255,.4)", background: "rgba(185,166,255,.06)", color: "#cbb8ff", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "4px 10px", display: "flex", alignItems: "center", gap: 5 }}><span style={{ fontSize: 12 }}>+</span>NEW ISSUE</button>
      </div>
      {newOpen && (
        <div style={{ border: "1px solid rgba(185,166,255,.32)", background: "rgba(185,166,255,.05)", padding: "11px 12px", marginBottom: 10 }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="describe the issue…" style={{ width: "100%", boxSizing: "border-box", background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "inherit", fontSize: 12, padding: "7px 9px" }} />
          <div style={{ display: "flex", gap: 7, marginTop: 10 }}>
            <button onClick={create} style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid #b9a6ff", background: "rgba(185,166,255,.14)", color: "#e7deff", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 7 }}>CREATE ISSUE</button>
            <button onClick={() => setNewOpen(false)} style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.2)", background: "transparent", color: "#6f938d", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "7px 12px" }}>CANCEL</button>
          </div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "330px 1fr", border: "1px solid rgba(127,233,216,.12)", minHeight: 372 }}>
        <div className="mscroll" style={{ borderRight: "1px solid rgba(127,233,216,.12)", padding: 9 }}>
          {issues.map((i: Issue) => {
            const on = i.number === open;
            return (
              <div key={i.number} onClick={() => setOpen(i.number)} data-ctx-type="issue" data-ctx-id={String(i.number)} data-ctx-label={`#${i.number}`}
                style={{ border: `1px solid ${on ? "rgba(127,233,216,.4)" : "rgba(127,233,216,.12)"}`, borderLeft: `2px solid ${on ? "#7fe9d8" : "transparent"}`, padding: "9px 10px", marginBottom: 7, cursor: "pointer", background: on ? "rgba(127,233,216,.08)" : "transparent" }}>
                <div style={{ fontSize: 12, color: "#cfe9e3", lineHeight: 1.35 }}>{i.title}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9.5, color: "#3c544f", fontFamily: "'JetBrains Mono',monospace" }}>#{i.number}</span>
                  {i.labels.slice(0, 2).map((l) => (
                    <span key={l.name} style={{ fontSize: 8.5, letterSpacing: ".5px", padding: "1px 6px", color: `#${l.color || "9fc7c0"}`, border: "1px solid rgba(127,233,216,.2)" }}>{l.name}</span>
                  ))}
                </div>
              </div>
            );
          })}
          {issues.length === 0 && <div style={{ fontSize: 11, color: "#3c544f", padding: 6 }}>No open issues.</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {sel ? (
            <>
              <div style={{ flex: "none", padding: "15px 18px 13px", borderBottom: "1px solid rgba(127,233,216,.1)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ fontSize: 10, color: "#3c544f", fontFamily: "'JetBrains Mono',monospace" }}>#{sel.number}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, letterSpacing: 1, color: "#8fd9a8", border: "1px solid rgba(143,217,168,.4)", padding: "2px 8px" }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "#8fd9a8" }} />OPEN</span>
                  <span style={{ flex: 1 }} />
                  <button onClick={() => setOpen(null)} style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 11, padding: "2px 8px", lineHeight: 1 }}>✕</button>
                </div>
                <div style={{ fontSize: 15, color: "#dff8f2", marginTop: 11, lineHeight: 1.4 }}>{sel.title}</div>
              </div>
              <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: "14px 18px" }}>
                <div style={{ fontSize: 8.5, letterSpacing: 1.5, color: "#3c544f", marginBottom: 8 }}>DESCRIPTION</div>
                <div style={{ fontSize: 12, color: "#bfe6de", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{sel.body || "No description."}</div>
              </div>
              <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", borderTop: "1px solid rgba(127,233,216,.1)" }}>
                <button onClick={() => onFeed([`Address issue #${sel.number}: ${sel.title}\n\n${sel.body || ""}`])} style={{ appearance: "none", cursor: "pointer", border: "1px solid #8fd9a8", background: "rgba(143,217,168,.12)", color: "#dff8f2", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "8px 13px" }}>▸ FEED TO CLAUDE</button>
                <span style={{ flex: 1 }} />
                {sel.url && <a href={sel.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, letterSpacing: 1, color: "#9fc7c0", border: "1px solid rgba(127,233,216,.25)", padding: "8px 13px", textDecoration: "none" }}>VIEW ↗</a>}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#2e423f" strokeWidth="1.5"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
              <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#3c544f" }}>SELECT AN ISSUE</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- LOGS ---------------- */
function LogsTab() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const tick = () => { void api.logs(200).then((d) => { if (live) setLines(d.lines); }).catch(() => {}); };
    tick();
    const id = setInterval(tick, 2000);
    return () => { live = false; clearInterval(id); };
  }, []);
  return (
    <div style={{ animation: "mslide .3s ease both" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 11, fontSize: 10, letterSpacing: 1 }}>
        <span style={{ color: "#8fd9a8", display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "#8fd9a8", animation: "mpulse 2.4s infinite" }} />DEV SERVER</span>
      </div>
      <div style={{ border: "1px solid rgba(127,233,216,.12)", padding: "11px 12px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, lineHeight: 1.95, maxHeight: 420, overflow: "auto" }} className="mscroll">
        {lines.length === 0 && <div style={{ color: "#3c544f" }}>No dev-server output. Start the server from the Run command.</div>}
        {lines.map((ln, i) => <div key={i} style={{ color: "#6f938d", whiteSpace: "pre-wrap" }}>{ln}</div>)}
      </div>
    </div>
  );
}
