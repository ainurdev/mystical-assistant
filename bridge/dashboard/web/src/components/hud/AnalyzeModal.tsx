import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type GitBadge,
  type GitStatus,
  type Issue,
  type IssuesInfo,
  type SessionBrief,
  type SessionStatus,
  type TermInfo,
  type Worktree,
} from "../../api";
import { useAiFeatures } from "../../lib/ai";
import { useStickyFlag } from "../../lib/prefs";
import { ago, projectTint, setProjectTint } from "../../lib/surfaces";
import { EditorTab, type BranchOpt } from "./EditorTab";
import { MapTab } from "./MapTab";
import { SkillsTab } from "./SkillsTab";
import { WorktreesTab } from "./WorktreesTab";
import { XtermPane } from "./XtermPane";

/* PROJECT ANALYSIS modal — matches the HUD design mock (hud.dc.html lines
   530–1258): header with editable short tag, tab bar (EDITOR / GIT /
   WORKTREES / TERMINAL / ISSUES), and per-tab bodies. */

export type Tab = "changes" | "worktrees" | "editor" | "terminal" | "skills" | "issues" | "map";

interface Props {
  project: string;
  badge?: GitBadge;
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  // Deep-link from the sidebar FILES explorer: open straight into the editor
  // on this file, in the branch's worktree the explorer was listing.
  initialFile?: string;
  initialBranch?: string;
  initialTab?: Tab;
  onClose: () => void;
  onFeed: (texts: string[], project?: string) => void;
  onSelectSession: (s: SessionBrief) => void;
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string) => void;
}

const FILE_COLOR = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");

/* tag-edit swatches (design TAG_COLORS + extended range) */
const TAG_COLORS = [
  "var(--acc)", "var(--purple)", "var(--ok)", "var(--warn)", "var(--info)", "var(--err)",
  "#ff7ad9", "#ffab6b", "#c8ef6a", "#7fd8ff", "#ff8ba7", "#b8c9d4",
];

function name(rel: string): string {
  return rel.replace(/\/+$/, "").split("/").pop() || rel;
}

function hexRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  if (h.length < 6) return `rgba(159,199,192,${a})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export function AnalyzeModal(props: Props) {
  const { project, badge } = props;
  const tint = projectTint(project);
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [tab, setTab] = useState<Tab>(props.initialTab ?? "editor");
  const [git, setGit] = useState<GitStatus | null>(null);
  const [issues, setIssues] = useState<IssuesInfo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [termCount, setTermCount] = useState(0);
  const [closing, setClosing] = useState(false);
  // Maximize sticks per browser, so the next open comes back the way you left it.
  const [full, setFull] = useStickyFlag("hud-modal-full");
  // modal-wide branch focus for the GIT + EDITOR tabs (which worktree we view)
  const [selectedBranch, setSelectedBranch] = useState(props.initialBranch ?? "");

  // editable short tag + color — persisted per project via setProjectTint, so
  // the strip, panels and future opens all reflect it.
  const [tagEditOpen, setTagEditOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [tagColorDraft, setTagColorDraft] = useState("");
  const tag = tint.tag;
  const tagColor = tint.color;
  const tagBd = tint.border;

  const refreshGit = () => { void api.git(project).then(setGit).catch(() => {}); };
  const refreshWt = () => { void api.worktrees(project).then((w) => setWorktrees(w.worktrees)).catch(() => {}); };
  const refreshBranches = () => {
    void api.branches(project).then((b) => { setBranches(b.branches); if (b.default) setDefaultBranch(b.default); }).catch(() => {});
  };

  useEffect(() => {
    setSelectedBranch(props.initialBranch ?? "");
    setTagEditOpen(false);
    refreshGit();
    void api.issues(project).then(setIssues).catch(() => {});
    refreshBranches();
    refreshWt();
    void api.terminals(project).then((d) => setTermCount(d.terminals.length)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // default viewed branch → the checked-out branch
  useEffect(() => { const c = git?.branch || badge?.branch; if (c) setSelectedBranch((p) => p || c); }, [git, badge]);

  function close() {
    setClosing(true);
    setTimeout(props.onClose, 260);
  }

  function openTagEdit() {
    setTagDraft(tag);
    setTagColorDraft(tagColor);
    setTagEditOpen((o) => !o);
  }
  function saveTagEdit() {
    const t = (tagDraft.trim() || tag).toUpperCase().slice(0, 5);
    setProjectTint(project, { tag: t, color: tagColorDraft || tagColor });
    setTagEditOpen(false);
  }

  const cur = git?.branch || badge?.branch || "";
  const live = props.sessions.some((s) => {
    const st = props.status.get(s.id)?.state;
    return st === "working" || st === "live";
  });
  const linkedWt = worktrees.filter((w) => !w.is_main).length;
  const issueCount = issues?.open_count ?? 0;

  const branchOpts: BranchOpt[] = useMemo(() => {
    const list = branches.length ? branches : (cur ? [cur] : []);
    return list.map((b) => ({ name: b, on: b === (selectedBranch || cur), hasWorktree: worktrees.some((w) => w.branch === b) }));
  }, [branches, cur, selectedBranch, worktrees]);

  const tabs: { k: Tab; l: string; badge?: number }[] = [
    { k: "editor", l: "EDITOR" },
    { k: "changes", l: "GIT", badge: git?.dirty || undefined },
    { k: "worktrees", l: "WORKTREES", badge: linkedWt || undefined },
    { k: "terminal", l: "TERMINAL", badge: termCount || undefined },
    { k: "issues", l: "ISSUES", badge: issueCount || undefined },
    { k: "skills", l: "SKILLS" },
    { k: "map", l: "MAP" },
  ];

  return (
    <div onClick={close}
      style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 72%, transparent)", zIndex: 92, display: "flex", alignItems: "center", justifyContent: "center", animation: closing ? "backdropOut .2s ease forwards" : "backdropIn .22s ease both" }}>
      {/* Both sizes are viewport-relative and definite: half the screen by
          default, near-full when maximized — never taller than the monitor, and
          a definite height is what lets each tab scroll inside itself instead of
          stretching the modal. */}
      <div onClick={(e) => e.stopPropagation()} className="panel"
        style={{ width: full ? "96vw" : "min(94vw, max(560px, 50vw))", height: full ? "94vh" : "min(90vh, max(440px, 50vh))", transition: "width .38s cubic-bezier(.25,.9,.25,1),height .38s cubic-bezier(.25,.9,.25,1)", display: "flex", flexDirection: "column", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 0 70px var(--shadow-modal),0 0 30px color-mix(in srgb, var(--acc) 8%, transparent)", animation: closing ? "modalOut .28s ease-in forwards" : "modalIn .46s cubic-bezier(.16,.84,.3,1) both" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 18px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", flex: "none", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9.5, letterSpacing: 2.5, color: "var(--txl)" }}>ANALYZE</span>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: tagColor }} />
          <span style={{ fontSize: 15, color: "var(--txb)", letterSpacing: ".5px" }}>{name(project)}</span>
          <span style={{ position: "relative", flex: "none" }}>
            <button onClick={openTagEdit} title="edit short tag & color" {...hp("tag")}
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, fontSize: 9, letterSpacing: ".5px", color: tagColor, border: `1px solid ${tagBd}`, background: hov === "tag" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", fontFamily: "inherit", padding: "3px 7px" }}>
              {tag}<span style={{ fontSize: 8, color: "var(--txd)" }}>✎</span>
            </button>
            {tagEditOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 7px)", left: 0, zIndex: 40, width: 224, border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 14px 40px var(--shadow-pop)", padding: 12, animation: "mslide .16s ease both" }}>
                <div style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--txl)", marginBottom: 7 }}>SHORT TAG</div>
                <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} placeholder="MYST" maxLength={5}
                  style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel3) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, letterSpacing: 2, textAlign: "center", padding: 7, textTransform: "uppercase" }} />
                <div style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--txl)", margin: "11px 0 7px" }}>COLOR</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {TAG_COLORS.map((c) => (
                    <button key={c} onClick={() => setTagColorDraft(c)}
                      style={{ width: 20, height: 20, borderRadius: "50%", border: 0, cursor: "pointer", background: c, boxShadow: tagColorDraft === c ? `0 0 0 2px #060a0a, 0 0 0 3px ${c}` : "0 0 0 0 transparent", padding: 0, flex: "none" }} />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 7, marginTop: 13 }}>
                  <button onClick={saveTagEdit} {...hp("tagsave")}
                    style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--acc)", background: hov === "tagsave" ? "color-mix(in srgb, var(--acc) 24%, transparent)" : "color-mix(in srgb, var(--acc) 14%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: 7 }}>SAVE</button>
                  <button onClick={() => setTagEditOpen(false)} {...hp("tagcancel")}
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === "tagcancel" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "7px 11px" }}>CANCEL</button>
                </div>
              </div>
            )}
          </span>
          <span style={{ fontSize: 11, color: "var(--txd)", display: "flex", gap: 9, fontFamily: "'JetBrains Mono',monospace" }}>
            <span style={{ color: "var(--ok)" }}>↑{git?.ahead ?? badge?.ahead ?? 0}</span>
            <span>↓{git?.behind ?? badge?.behind ?? 0}</span>
          </span>
          {live && <span style={{ fontSize: 9, letterSpacing: 1, color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 30%, transparent)", padding: "1px 6px" }}>LIVE</span>}
          <span style={{ flex: 1 }} />
          <button onClick={() => setFull((v) => !v)} title={full ? "restore size" : "expand"} {...hp("full")}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "full" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 11, padding: "3px 9px", lineHeight: 1.4 }}>{full ? "⤡" : "⤢"}</button>
          <button onClick={close} style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.5, padding: "4px 10px" }}>ESC ✕</button>
        </div>
        {/* tabs */}
        <div style={{ display: "flex", flex: "none", borderBottom: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: "0 6px", overflowX: "auto" }}>
          {tabs.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)} {...hp(`tab:${t.k}`)}
              style={{ appearance: "none", border: 0, borderBottom: `2px solid ${tab === t.k ? "var(--acc)" : "transparent"}`, cursor: "pointer", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "10px 11px", background: tab === t.k ? "color-mix(in srgb, var(--acc) 6%, transparent)" : hov === `tab:${t.k}` ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent", color: tab === t.k ? "var(--txb)" : "var(--txl)", display: "flex", alignItems: "center", gap: 7 }}>
              {t.l}
              {t.badge != null && <span style={{ fontSize: 9, color: "var(--acc)", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", padding: "0 5px" }}>{t.badge}</span>}
            </button>
          ))}
        </div>
        {/* body */}
        <div className="mscroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 18 }}>
          {tab === "changes" && (
            <ChangesTab project={project} branch={selectedBranch || cur} branchOpts={branchOpts}
              onPickBranch={setSelectedBranch} onRefreshGit={refreshGit} initialFile={props.initialFile} />
          )}
          {tab === "worktrees" && (
            <WorktreesTab project={project} sessions={props.sessions} worktrees={worktrees}
              branches={branches} defaultBranch={defaultBranch} git={git}
              onSelectSession={props.onSelectSession} onWorktreeSession={props.onWorktreeSession}
              onRefresh={() => { refreshGit(); refreshWt(); refreshBranches(); }} />
          )}
          {tab === "editor" && (
            <EditorTab project={project} branch={selectedBranch || cur} branchOpts={branchOpts}
              onPickBranch={setSelectedBranch} initialFile={props.initialFile} />
          )}
          {tab === "terminal" && (
            <TerminalTab project={project} worktrees={worktrees} branch={cur || defaultBranch} onCount={setTermCount} />
          )}
          {tab === "skills" && <SkillsTab project={project} name={name(project)} />}
          {tab === "issues" && (
            <IssuesTab project={project} info={issues} onFeed={(t) => props.onFeed(t, project)}
              onReload={() => void api.issues(project).then(setIssues).catch(() => {})} />
          )}
          {tab === "map" && <MapTab project={project} />}
        </div>
      </div>
    </div>
  );
}

/* ---------------- GIT (changes): working-tree master-detail + commit/push (design 656–728) ---------------- */

interface DiffLine {
  ln: string;
  mark: string;
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

const DIFF_VIEW: Record<DiffLine["kind"], { bg: string; sign: string; color: string }> = {
  add: { bg: "color-mix(in srgb, var(--ok) 7%, transparent)", sign: "var(--ok)", color: "var(--ok)" },
  del: { bg: "color-mix(in srgb, var(--err) 7%, transparent)", sign: "var(--err)", color: "var(--err)" },
  ctx: { bg: "transparent", sign: "var(--txg)", color: "var(--txd)" },
  hunk: { bg: "color-mix(in srgb, var(--acc) 6%, transparent)", sign: "var(--acc)", color: "var(--acc)" },
};

/* Unified diff → numbered design rows (sequential numbers from each hunk's
   new-file start, matching the mock's numbering). */
function parseDiffRows(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let n = 0;
  let inHunk = false;
  for (const ln of diff.split("\n")) {
    if (ln.startsWith("@@")) {
      const m = /\+(\d+)/.exec(ln);
      if (m) n = parseInt(m[1], 10);
      inHunk = true;
      out.push({ ln: "", mark: "@@", kind: "hunk", text: ` ${ln}` });
      continue;
    }
    if (!inHunk) continue;
    if (ln.startsWith("+")) out.push({ ln: String(n++), mark: "+", kind: "add", text: ln.slice(1) });
    else if (ln.startsWith("-")) out.push({ ln: String(n++), mark: "-", kind: "del", text: ln.slice(1) });
    else out.push({ ln: String(n++), mark: "", kind: "ctx", text: ln.startsWith(" ") ? ln.slice(1) : ln });
  }
  return out;
}

function ChangesTab({ project, branch, branchOpts, onPickBranch, onRefreshGit, initialFile }: {
  project: string; branch: string; branchOpts: BranchOpt[]; onPickBranch: (b: string) => void;
  onRefreshGit: () => void; initialFile?: string;
}) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });
  const ai = useAiFeatures();   // GEN is hidden while commit messages are off

  const [st, setSt] = useState<GitStatus | null>(null);
  const [sel, setSel] = useState<string | null>(initialFile ?? null);
  const [diff, setDiff] = useState("");
  const [nonce, setNonce] = useState(0);
  const [msg, setMsg] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [gitOp, setGitOp] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Which files are staged for the next commit. `sel` above is the *focused*
  // file (whose diff shows); `checked` is the multi-select for commit/GEN.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const opT = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showOp(m: string) {
    setGitOp(m);
    if (opT.current) clearTimeout(opT.current);
    opT.current = setTimeout(() => setGitOp(""), 4500);
  }
  useEffect(() => () => { if (opT.current) clearTimeout(opT.current); }, []);

  const load = () => {
    void api.git(project, branch || undefined)
      .then((g) => { setSt(g); setChecked(new Set(g.files.map((f) => f.path))); })
      .catch(() => setSt(null));
  };
  // Focus the deep-linked file (sidebar → GIT), else the first changed one.
  useEffect(() => { setSel(initialFile ?? null); setMsg(""); load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, branch, initialFile]);

  // A branch with no worktree makes the backend fall back to the project
  // checkout — whose status would masquerade as this branch's. Detect the
  // mismatch and show nothing rather than another branch's changes.
  const wrongTree = !!(st?.is_repo && branch && st.branch !== branch);
  const files = wrongTree ? [] : st?.files ?? [];
  const selName = sel ?? files[0]?.path ?? null;
  const allChecked = files.length > 0 && checked.size === files.length;
  const toggleCheck = (p: string) =>
    setChecked((prev) => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(files.map((f) => f.path)));

  useEffect(() => {
    if (!selName) { setDiff(""); return; }
    let live = true;
    void api.gitDiff(project, selName, undefined, undefined, branch || undefined)
      .then((d) => { if (live) { setDiff(d.diff); setNonce((x) => x + 1); } })
      .catch(() => { if (live) setDiff(""); });
    return () => { live = false; };
  }, [selName, project, branch]);

  const rows = useMemo(() => parseDiffRows(diff), [diff]);
  const selFile = files.find((f) => f.path === selName);
  const diffAnim = nonce % 2 ? "mdiffin" : "mdiffin2";

  async function genMsg() {
    if (genBusy || !checked.size) return;
    setGenBusy(true);
    try {
      const r = await api.commitMessage(project, branch, [...checked]);
      if (r.message) setMsg(r.message);
    } catch { /* ignore */ }
    finally { setGenBusy(false); }
  }

  async function doCommit() {
    if (busy || !msg.trim() || !checked.size) return;
    setBusy(true);
    const n = checked.size;
    try {
      const r = await api.gitCommit(project, msg.trim(), [...checked], branch || undefined);
      if (r.ok) { showOp(`Committed ${n} file${n === 1 ? "" : "s"} on ${branch}`); setMsg(""); load(); onRefreshGit(); }
      else showOp(`Commit failed: ${r.output}`);
    } finally { setBusy(false); }
  }

  async function doPush() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.gitPush(project, branch || undefined);
      showOp(r.ok ? `Pushed ${branch} to origin` : `Push failed: ${r.output}`);
      if (r.ok) { load(); onRefreshGit(); }
    } finally { setBusy(false); }
  }

  function doPull() {
    // TODO(phase2-data): no pull endpoint on the bridge yet.
    showOp("Pull isn't wired to the bridge yet");
  }

  return (
    <div style={{ animation: "mslide .3s ease both", height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header row always renders the branch switcher — inside the file grid it
          unmounted on a clean branch, leaving no way to switch back. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11, flex: "none" }}>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--txl)" }}>WORKING TREE</span>
        <span style={{ flex: 1 }} />
        <div style={{ position: "relative", flex: "none" }}>
          <button onClick={() => setMenuOpen((o) => !o)} title="switch branch — worktrees marked" {...hp("br")}
            style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === "br" ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`, background: "color-mix(in srgb, var(--purple) 6%, transparent)", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "4px 8px", maxWidth: 160 }}>
            <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{branch || "—"}</span>
            <span style={{ color: "var(--purple-g)", flex: "none" }}>▾</span>
          </button>
          {menuOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 5px)", right: 0, zIndex: 30, minWidth: 214, border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 12px 32px var(--shadow-pop)", padding: 5, animation: "mslide .16s ease both" }}>
              <div style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--txl)", padding: "5px 8px 7px" }}>SWITCH BRANCH</div>
              {branchOpts.map((b) => (
                <button key={b.name} onClick={() => { onPickBranch(b.name); setMenuOpen(false); }} {...hp(`bi:${b.name}`)}
                  style={{ width: "100%", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, border: 0, background: hov === `bi:${b.name}` ? "color-mix(in srgb, var(--purple) 10%, transparent)" : "transparent", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, padding: "7px 9px", textAlign: "left" }}>
                  <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</span>
                  {b.hasWorktree && <span style={{ fontSize: 7.5, letterSpacing: 1, color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", padding: "1px 4px", flex: "none" }}>WORKTREE</span>}
                  {b.on && <span style={{ color: "var(--acc)", flex: "none" }}>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {st && files.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--txd)", fontFamily: "'JetBrains Mono',monospace", padding: "6px 2px" }}>
          {wrongTree
            ? <>⎇ {branch} isn't checked out — no working tree to show. Create a worktree for it in the WORKTREES tab.</>
            : "Working tree clean."}
        </div>
      )}
      {/* Fills the modal body (not min-height): the file list and diff then
          scroll inside their columns, keeping the commit box pinned at the
          bottom instead of pushing it below the modal's own scroll. */}
      {files.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {/* file list */}
          <div style={{ borderRight: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 12px 8px", flex: "none" }}>
              <button onClick={toggleAll} disabled={!files.length} title={allChecked ? "deselect all" : "select all"} {...hp("all")}
                style={{ appearance: "none", cursor: files.length ? "pointer" : "default", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "all" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 8.5, letterSpacing: 1, padding: "3px 7px", flex: "none" }}>{allChecked ? "NONE" : "ALL"}</button>
              <span style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--txl)" }}>{checked.size}/{files.length} SEL</span>
            </div>
            <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              {files.map((f) => {
                const on = f.path === selName;
                const isChecked = checked.has(f.path);
                return (
                  <div key={f.path} onClick={() => setSel(f.path)} {...hp(`f:${f.path}`)}
                    style={{ borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : hov === `f:${f.path}` ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 9, padding: "8px 10px" }}>
                    <input type="checkbox" checked={isChecked} onChange={() => toggleCheck(f.path)} onClick={(e) => e.stopPropagation()} title="stage this file for commit"
                      style={{ accentColor: "var(--acc)", cursor: "pointer", flex: "none", width: 13, height: 13, margin: 0 }} />
                    <span style={{ fontSize: 11, fontWeight: 700, width: 13, textAlign: "center", flex: "none", color: FILE_COLOR(f.status) }}>{f.status}</span>
                    <span style={{ fontSize: 11, color: on ? "var(--txb)" : isChecked ? "var(--txm)" : "var(--txf)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{f.path}</span>
                    <span style={{ fontSize: 10, flex: "none", display: "flex", gap: 5 }}><span style={{ color: "var(--ok)" }}>+{f.add}</span><span style={{ color: "var(--err)" }}>−{f.del}</span></span>
                  </div>
                );
              })}
            </div>
            <div style={{ borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", flex: "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 9px 0" }}>
                <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="commit message…"
                  style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: 11, padding: "6px 8px" }} />
                {ai.commitmsg && <button onClick={() => void genMsg()} title="generate with Claude" {...hp("gen")}
                  style={{ appearance: "none", cursor: "pointer", border: `1px solid ${genBusy ? "color-mix(in srgb, var(--purple) 50%, transparent)" : "color-mix(in srgb, var(--purple) 35%, transparent)"}`, background: genBusy ? "color-mix(in srgb, var(--purple) 16%, transparent)" : hov === "gen" ? "color-mix(in srgb, var(--purple) 16%, transparent)" : "transparent", color: "var(--purple-h)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 9px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 5, height: 5, background: "var(--purple)", transform: "rotate(45deg)" }} />{genBusy ? "THINKING…" : "GEN"}</button>}
              </div>
              {gitOp && (
                <div style={{ margin: "8px 9px 0", border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", background: "color-mix(in srgb, var(--ok) 6%, transparent)", color: "var(--ok)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "6px 9px", display: "flex", alignItems: "center", gap: 7, animation: "mslide .2s ease both" }}>
                  <span style={{ color: "var(--ok)", flex: "none" }}>✓</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gitOp}</span>
                </div>
              )}
              <div style={{ padding: "8px 9px 6px" }}>
                <button onClick={() => void doCommit()} disabled={!checked.size || !msg.trim() || busy} {...hp("commit")}
                  style={{ width: "100%", appearance: "none", cursor: checked.size && msg.trim() && !busy ? "pointer" : "not-allowed", border: "1px solid var(--acc)", background: hov === "commit" ? "color-mix(in srgb, var(--acc) 22%, transparent)" : "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 8, opacity: !checked.size || !msg.trim() || busy ? 0.45 : 1 }}>COMMIT {checked.size} FILE{checked.size === 1 ? "" : "S"}</button>
              </div>
              <div style={{ display: "flex", gap: 7, padding: "0 9px 9px" }}>
                <button onClick={() => void doPush()} title="push to origin" {...hp("push")}
                  style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "push" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--tx)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <span style={{ color: "var(--ok)" }}>↑</span>PUSH {st?.ahead ?? 0}</button>
                <button onClick={doPull} title="pull from origin" {...hp("pull")}
                  style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "pull" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--tx)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <span style={{ color: "var(--info)" }}>↓</span>PULL {st?.behind ?? 0}</button>
              </div>
            </div>
          </div>
          {/* diff panel */}
          <div style={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, flex: "none" }}>
              <span style={{ color: FILE_COLOR(selFile?.status ?? "M"), fontWeight: 700 }}>{selFile?.status ?? ""}</span>
              <span style={{ flex: 1, color: "var(--txb)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{selName || ""}</span>
              <span style={{ color: "var(--ok)" }}>+{selFile?.add ?? 0}</span><span style={{ color: "var(--err)" }}>−{selFile?.del ?? 0}</span>
            </div>
            <div className="mscroll" style={{ flex: 1, overflow: "auto", minHeight: 0, fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, lineHeight: 1.7 }}>
              {rows.map((d, i) => {
                const v = DIFF_VIEW[d.kind];
                return (
                  <div key={`${nonce}:${i}`} style={{ display: "flex", background: v.bg, animation: `${diffAnim} .34s ease both`, animationDelay: `${i * 22}ms` }}>
                    <span style={{ width: 36, flex: "none", textAlign: "right", paddingRight: 9, color: "var(--txg)", userSelect: "none", borderRight: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)" }}>{d.ln}</span>
                    <span style={{ width: 14, flex: "none", textAlign: "center", color: v.sign }}>{d.mark}</span>
                    <span style={{ color: v.color, whiteSpace: "pre", flex: 1 }}>{d.text || " "}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- ISSUES: master-detail with select/feed + pagination (design 876–991) ---------------- */

const ISSUES_PER_PAGE = 4;
const NEW_ISSUE_LABELS = [
  { name: "bug", color: "var(--err)" },
  { name: "enhancement", color: "var(--purple)" },
  { name: "p1", color: "var(--warn)" },
  { name: "good first issue", color: "var(--ok)" },
];

function issueText(i: Issue): string {
  return `Address issue #${i.number}: ${i.title}\n\n${i.body || ""}`;
}

function agoIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return ago(t / 1000) || "now";
}

function IssuesTab({ project, info, onFeed, onReload }: {
  project: string; info: IssuesInfo | null; onFeed: (t: string[]) => void; onReload: () => void;
}) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [open, setOpen] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [fed, setFed] = useState<Set<number>>(new Set());
  const [banner, setBanner] = useState("");
  const bannerT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [label, setLabel] = useState("bug"); // TODO(phase2-data): createIssue has no labels param yet

  useEffect(() => () => { if (bannerT.current) clearTimeout(bannerT.current); }, []);
  function showBanner(m: string) {
    setBanner(m);
    if (bannerT.current) clearTimeout(bannerT.current);
    bannerT.current = setTimeout(() => setBanner(""), 4500);
  }

  const issues = info?.issues ?? [];
  const pageCount = Math.max(1, Math.ceil(issues.length / ISSUES_PER_PAGE));
  const pageIdx = Math.min(page, pageCount - 1);
  const pageIssues = issues.slice(pageIdx * ISSUES_PER_PAGE, pageIdx * ISSUES_PER_PAGE + ISSUES_PER_PAGE);
  const selIssue = issues.find((i) => i.number === open) || null;
  const selCount = sel.size;

  function toggleSel(n: number) {
    setSel((prev) => { const s = new Set(prev); if (s.has(n)) s.delete(n); else s.add(n); return s; });
  }

  function feedSelected() {
    const picked = issues.filter((i) => sel.has(i.number));
    if (!picked.length) return;
    onFeed(picked.map(issueText));
    setFed((f) => { const n = new Set(f); picked.forEach((i) => n.add(i.number)); return n; });
    setSel(new Set());
    showBanner(`Fed ${picked.length} issue${picked.length === 1 ? "" : "s"} to Claude`);
  }

  function feedOne(i: Issue) {
    onFeed([issueText(i)]);
    setFed((f) => new Set(f).add(i.number));
    showBanner(`Fed #${i.number} to Claude`);
  }

  async function create() {
    if (!title.trim()) return;
    await api.createIssue(project, title.trim(), "");
    setTitle(""); setNewOpen(false); onReload();
  }

  if (info && !info.has_remote) return <div style={{ fontSize: 12, color: "var(--txd)", padding: "6px 2px" }}>No GitHub remote for this project.</div>;
  if (info && !info.gh_ok) return <div style={{ fontSize: 12, color: "var(--err)", padding: "6px 2px" }}>gh CLI unavailable: {info.error || "not authenticated"}.</div>;

  return (
    <div style={{ animation: "mslide .3s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--txl)" }}>{info?.open_count ?? 0} OPEN ISSUES</span>
        <span style={{ flex: 1 }} />
        {selCount > 0 && (
          <button onClick={feedSelected} {...hp("feedsel")}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--ok)", background: hov === "feedsel" ? "color-mix(in srgb, var(--ok) 22%, transparent)" : "color-mix(in srgb, var(--ok) 12%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "4px 10px", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--ok)" }}>▸</span>FEED {selCount} TO CLAUDE</button>
        )}
        <button onClick={() => setNewOpen((o) => !o)} {...hp("newissue")}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: hov === "newissue" ? "color-mix(in srgb, var(--purple) 16%, transparent)" : "color-mix(in srgb, var(--purple) 6%, transparent)", color: "var(--purple-h)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "4px 10px", display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 12 }}>+</span>NEW ISSUE</button>
      </div>

      {banner && (
        <div style={{ border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)", background: "color-mix(in srgb, var(--ok) 8%, transparent)", color: "var(--ok)", fontSize: 10.5, letterSpacing: ".5px", padding: "8px 11px", marginBottom: 9, display: "flex", alignItems: "center", gap: 8, animation: "mslide .25s ease both" }}>
          <span style={{ color: "var(--ok)" }}>▸</span>{banner}
        </div>
      )}

      {newOpen && (
        <div style={{ border: "1px solid color-mix(in srgb, var(--purple) 32%, transparent)", background: "color-mix(in srgb, var(--purple) 5%, transparent)", padding: "11px 12px", marginBottom: 10, animation: "mslide .2s ease both" }}>
          <div style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--txl)", marginBottom: 8 }}>NEW ISSUE · {name(project)}</div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="describe the issue…"
            style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: 12, padding: "7px 9px" }} />
          <div style={{ fontSize: 8.5, letterSpacing: 1, color: "var(--txl)", margin: "9px 0 6px" }}>LABEL</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {NEW_ISSUE_LABELS.map((l) => {
              const on = label === l.name;
              return (
                <button key={l.name} onClick={() => setLabel(l.name)}
                  style={{ appearance: "none", cursor: "pointer", border: `1px solid ${on ? `color-mix(in srgb, ${l.color} 60%, transparent)` : "color-mix(in srgb, var(--acc) 18%, transparent)"}`, background: on ? `color-mix(in srgb, ${l.color} 12%, transparent)` : "transparent", color: on ? "var(--txb)" : "var(--txm)", fontFamily: "inherit", fontSize: 9, letterSpacing: ".5px", padding: "4px 9px", display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: l.color }} />{l.name}</button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 7, marginTop: 10 }}>
            <button onClick={() => void create()} {...hp("createissue")}
              style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--purple)", background: hov === "createissue" ? "color-mix(in srgb, var(--purple) 24%, transparent)" : "color-mix(in srgb, var(--purple) 14%, transparent)", color: "var(--purple-b)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 7 }}>CREATE ISSUE</button>
            <button onClick={() => setNewOpen(false)} {...hp("cancelissue")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === "cancelissue" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "7px 12px" }}>CANCEL</button>
          </div>
        </div>
      )}

      {/* master-detail */}
      <div style={{ display: "grid", gridTemplateColumns: "330px 1fr", border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", minHeight: 372 }}>
        {/* LEFT: list */}
        <div style={{ borderRight: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: 9 }}>
            {pageIssues.map((i) => {
              const isOpen = i.number === open;
              const isSel = sel.has(i.number);
              return (
                <div key={i.number} onClick={() => setOpen(i.number)} data-ctx-type="issue" data-ctx-id={String(i.number)} data-ctx-label={`#${i.number}`} {...hp(`row:${i.number}`)}
                  style={{ border: `1px solid ${isOpen ? "color-mix(in srgb, var(--acc) 40%, transparent)" : hov === `row:${i.number}` ? "color-mix(in srgb, var(--acc) 30%, transparent)" : isSel ? "color-mix(in srgb, var(--acc) 25%, transparent)" : "color-mix(in srgb, var(--acc) 12%, transparent)"}`, borderLeft: `2px solid ${isOpen ? "var(--acc)" : "transparent"}`, padding: "9px 10px", marginBottom: 7, cursor: "pointer", background: isOpen ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", display: "flex", gap: 9 }}>
                  <span onClick={(e) => { e.stopPropagation(); toggleSel(i.number); }} title="select"
                    style={{ width: 15, height: 15, border: `1px solid ${isSel ? "var(--acc)" : "color-mix(in srgb, var(--acc) 30%, transparent)"}`, background: isSel ? "var(--acc)" : "transparent", flex: "none", marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--acc-on)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{isSel ? "✓" : ""}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
                      <div style={{ fontSize: 12, color: "var(--txh)", lineHeight: 1.35, flex: 1 }}>{i.title}</div>
                      {fed.has(i.number) && <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--acc-on)", background: "var(--ok)", padding: "2px 5px", flex: "none" }}>✓</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 9.5, color: "var(--txl)", fontFamily: "'JetBrains Mono',monospace" }}>#{i.number}</span>
                      {i.labels.slice(0, 2).map((l) => (
                        <span key={l.name} style={{ fontSize: 8.5, letterSpacing: ".5px", padding: "1px 6px", color: `#${l.color || "9fc7c0"}`, border: `1px solid ${hexRgba(l.color || "9fc7c0", 0.4)}` }}>{l.name}</span>
                      ))}
                      <span style={{ fontSize: 9.5, color: "var(--txg)", marginLeft: "auto" }}>{agoIso(i.updated)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {issues.length === 0 && <div style={{ fontSize: 11, color: "var(--txl)", padding: 6 }}>No open issues.</div>}
          </div>
          {pageCount > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 9px", borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", flex: "none" }}>
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} {...hp("prev")}
                style={{ appearance: "none", cursor: pageIdx > 0 ? "pointer" : "not-allowed", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === "prev" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: pageIdx > 0 ? "var(--txm)" : "var(--txl)", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1, padding: "5px 10px" }}>‹ PREV</button>
              <span style={{ flex: 1, textAlign: "center", fontSize: 9, letterSpacing: 1, color: "var(--txd)" }}>{pageIdx + 1} / {pageCount}</span>
              <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} {...hp("next")}
                style={{ appearance: "none", cursor: pageIdx < pageCount - 1 ? "pointer" : "not-allowed", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === "next" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: pageIdx < pageCount - 1 ? "var(--txm)" : "var(--txl)", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1, padding: "5px 10px" }}>NEXT ›</button>
            </div>
          )}
        </div>
        {/* RIGHT: detail */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {selIssue ? (
            <>
              <div style={{ flex: "none", padding: "15px 18px 13px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", animation: "mslide .25s ease both" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ fontSize: 10, color: "var(--txl)", fontFamily: "'JetBrains Mono',monospace" }}>#{selIssue.number}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, letterSpacing: 1, color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)", padding: "2px 8px" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)" }} />OPEN</span>
                  {fed.has(selIssue.number) && <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--acc-on)", background: "var(--ok)", padding: "2px 6px" }}>✓ FED</span>}
                  <span style={{ flex: 1 }} />
                  <button onClick={() => setOpen(null)} title="close detail" {...hp("closedetail")}
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "closedetail" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 11, padding: "2px 8px", lineHeight: 1 }}>✕</button>
                </div>
                <div style={{ fontSize: 15, color: "var(--txb)", marginTop: 11, lineHeight: 1.4 }}>{selIssue.title}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 9, flexWrap: "wrap" }}>
                  {selIssue.labels.map((l) => (
                    <span key={l.name} style={{ fontSize: 9, letterSpacing: ".5px", padding: "1px 7px", color: `#${l.color || "9fc7c0"}`, border: `1px solid ${hexRgba(l.color || "9fc7c0", 0.4)}` }}>{l.name}</span>
                  ))}
                </div>
                {/* TODO(phase2-data): author/assignee aren't in the issues endpoint yet */}
                <div style={{ fontSize: 10, color: "var(--txd)", marginTop: 11 }}>opened {agoIso(selIssue.updated)} ago by <span style={{ color: "var(--txm)" }}>—</span> · assignee <span style={{ color: "var(--txm)" }}>—</span></div>
              </div>
              <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "14px 18px" }}>
                <div style={{ fontSize: 8.5, letterSpacing: 1.5, color: "var(--txl)", marginBottom: 8 }}>DESCRIPTION</div>
                <div style={{ fontSize: 12, color: "var(--tx)", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{selIssue.body || "No description."}</div>
                <div style={{ fontSize: 8.5, letterSpacing: 1.5, color: "var(--txl)", margin: "18px 0 11px" }}>ACTIVITY</div>
                {/* TODO(phase2-data): no issue-activity endpoint yet */}
                <div style={{ fontSize: 10.5, color: "var(--txg)" }}>No activity yet.</div>
              </div>
              <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }}>
                <button onClick={() => feedOne(selIssue)} {...hp("feedone")}
                  style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--ok)", background: hov === "feedone" ? "color-mix(in srgb, var(--ok) 22%, transparent)" : "color-mix(in srgb, var(--ok) 12%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "8px 13px" }}>
                  {fed.has(selIssue.number) ? "FEED AGAIN" : "FEED TO CLAUDE"}</button>
                <span style={{ flex: 1 }} />
                {/* TODO(phase2-data): no close-issue endpoint yet (unwired in the design too) */}
                <button {...hp("closeissue")}
                  style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 30%, transparent)", background: hov === "closeissue" ? "color-mix(in srgb, var(--err) 10%, transparent)" : "transparent", color: "var(--err)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "8px 13px" }}>CLOSE ISSUE</button>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="var(--txg)" strokeWidth="1.5"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
              <div style={{ fontSize: 11, letterSpacing: 1.5, color: "var(--txl)" }}>SELECT AN ISSUE</div>
              <div style={{ fontSize: 10, color: "var(--txg)", maxWidth: 210, lineHeight: 1.55 }}>Click any issue on the left to read its full description and activity.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- TERMINAL: run-project bar + multi-tab PTY terminals (design 1063–1120) ---------------- */

function TerminalTab({ project, worktrees, branch, onCount }: {
  project: string; worktrees: Worktree[]; branch: string; onCount: (n: number) => void;
}) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [terms, setTerms] = useState<TermInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const [runCmd, setRunCmd] = useState("");
  const [runSource, setRunSource] = useState("");
  const [detected, setDetected] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);

  // auto-detect the run command for this project
  useEffect(() => {
    let live = true;
    setRunCmd(""); setRunSource(""); setDetected(false);
    void api.detectPreview({ project })
      .then((r) => { if (live) { setRunCmd(r.command || ""); setRunSource(r.source || ""); setDetected(true); } })
      .catch(() => { if (live) setDetected(true); });
    return () => { live = false; };
  }, [project]);

  // reconnect to this project's persisted terminals — with none open, start one on
  // the checked-out branch (the main checkout) so the tab lands on a live prompt
  const autoOpened = useRef("");
  useEffect(() => {
    let live = true;
    void api.terminals(project).then((d) => {
      if (!live) return;
      setTerms(d.terminals);
      setActiveId((cur) => (cur && d.terminals.some((t) => t.id === cur)) ? cur : (d.terminals[0]?.id ?? null));
      if (!d.terminals.length && autoOpened.current !== project) {
        autoOpened.current = project;
        void create(project);
      }
    }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => { onCount(terms.length); }, [terms, onCount]);

  const branchOf = (t: TermInfo): string => {
    const wt = worktrees.find((w) => w.rel && w.rel === t.cwd_rel);
    if (wt) return wt.branch;
    if (t.cwd_rel === project) return branch || "main";
    return t.cwd_rel.replace(/\/+$/, "").split("/").pop() || t.cwd_rel;
  };

  const removeTerm = (id: string) => {
    setTerms((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveId((cur) => (cur === id ? (next[next.length - 1]?.id ?? null) : cur));
      return next;
    });
  };

  async function create(cwdRel: string) {
    if (creating) return;
    setCreating(true); setError("");
    try {
      const r = await api.createTerminal(project, cwdRel, 80, 24);
      if (r.error || !r.id) { setError(r.error || "could not open terminal"); return; }
      const fresh: TermInfo = { id: r.id, project, cwd_rel: r.cwd_rel ?? cwdRel, cols: 80, rows: 24, created: Date.now() / 1000, alive: true };
      setTerms((prev) => [...prev, fresh]);
      setActiveId(r.id);
      setNewOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  }

  async function closeTerm(id: string) {
    try { await api.closeTerminal(id); } catch { /* already gone */ }
    removeTerm(id);
  }

  async function genRun() {
    if (genBusy) return;
    setGenBusy(true);
    try {
      const r = await api.detectPreview({ project });
      setRunCmd(r.command || "");
      setRunSource(r.source || "");
    } catch { /* ignore */ }
    finally { setGenBusy(false); }
  }

  async function runProject() {
    const cmd = runCmd.trim();
    if (!cmd || runBusy) return;
    setRunBusy(true);
    try { await api.server("start", { cmd, project }); }
    catch (e) { setError((e as Error).message); }
    finally { setRunBusy(false); }
  }

  const wtOpts = worktrees.length
    ? worktrees.map((w) => ({ name: w.branch, rel: w.rel ?? project }))
    : [{ name: branch || "main", rel: project }];

  return (
    <div style={{ animation: "mslide .3s ease both", height: "100%", display: "flex", flexDirection: "column" }}>
      {/* run project */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11, border: "1px solid color-mix(in srgb, var(--ok) 24%, transparent)", background: "color-mix(in srgb, var(--ok) 4%, transparent)", padding: "9px 11px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--ok)", flex: "none" }}>RUN PROJECT</span>
        <span style={{ fontSize: 13, color: "var(--ok)", flex: "none", fontFamily: "'JetBrains Mono',monospace" }}>$</span>
        <input value={runCmd} onChange={(e) => setRunCmd(e.target.value)} placeholder="command to run this project…"
          style={{ flex: 1, minWidth: 120, background: "color-mix(in srgb, var(--panel3) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, padding: "7px 9px" }} />
        <span title="auto-detected" style={{ fontSize: 8, letterSpacing: ".5px", color: "var(--txf)", flex: "none", fontFamily: "'JetBrains Mono',monospace" }}>{runSource}</span>
        {detected && !runCmd && (
          <button onClick={() => void genRun()} title="complex project — let Claude generate the run command" {...hp("gen")}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: hov === "gen" ? "color-mix(in srgb, var(--purple) 18%, transparent)" : "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "7px 11px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--purple)" }}>✦</span>{genBusy ? "THINKING…" : "GENERATE"}</button>
        )}
        <button onClick={() => void runProject()} title="run in terminal" {...hp("run")}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--ok)", background: hov === "run" ? "color-mix(in srgb, var(--ok) 24%, transparent)" : "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.5, padding: "7px 14px", flex: "none", display: "flex", alignItems: "center", gap: 6, opacity: runBusy ? 0.6 : 1 }}>
          <span style={{ color: "var(--ok)" }}>▸</span>RUN</button>
      </div>
      {error && (
        <div style={{ border: "1px solid color-mix(in srgb, var(--err) 30%, transparent)", background: "color-mix(in srgb, var(--err) 6%, transparent)", color: "var(--err)", fontSize: 10.5, padding: "7px 11px", marginBottom: 9, fontFamily: "'JetBrains Mono',monospace" }}>{error}</div>
      )}
      {/* terminal box */}
      <div style={{ border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0, background: "color-mix(in srgb, var(--panel3) 55%, transparent)" }}>
        <div style={{ flex: "none", display: "flex", alignItems: "stretch", borderBottom: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", background: "color-mix(in srgb, var(--panel2) 50%, transparent)", overflowX: "auto" }}>
          {terms.map((t) => {
            const on = t.id === activeId;
            return (
              <div key={t.id} onClick={() => setActiveId(t.id)} {...hp(`term:${t.id}`)}
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 11px", cursor: "pointer", borderRight: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", borderBottom: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? "color-mix(in srgb, var(--acc) 6%, transparent)" : hov === `term:${t.id}` ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent", flex: "none" }}>
                <span style={{ color: "var(--acc)", fontSize: 10, flex: "none" }}>❯_</span>
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: on ? "var(--txb)" : "var(--txd)", maxWidth: 150, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>⎇ {branchOf(t)}</span>
                <button onClick={(e) => { e.stopPropagation(); void closeTerm(t.id); }} title="close terminal" {...hp(`termx:${t.id}`)}
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: hov === `termx:${t.id}` ? "var(--err)" : "var(--txd)", fontFamily: "inherit", fontSize: 12, lineHeight: 1, padding: "0 2px", flex: "none" }}>✕</button>
              </div>
            );
          })}
          <button onClick={() => setNewOpen((o) => !o)} title="new terminal on a worktree" {...hp("termnew")}
            style={{ appearance: "none", cursor: "pointer", border: 0, background: hov === "termnew" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--acc)", fontFamily: "inherit", fontSize: 15, lineHeight: 1, padding: "4px 13px", flex: "none" }}>+</button>
        </div>
        {newOpen && (
          <div style={{ flex: "none", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, padding: "9px 11px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", background: "color-mix(in srgb, var(--purple) 4%, transparent)" }}>
            <span style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--purple-g)", flex: "none" }}>OPEN ON WORKTREE</span>
            {wtOpts.map((w) => (
              <button key={w.name} onClick={() => void create(w.rel)} {...hp(`wt:${w.name}`)}
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === `wt:${w.name}` ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`, background: "color-mix(in srgb, var(--purple) 6%, transparent)", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "4px 8px" }}>
                <span style={{ color: "var(--purple)" }}>⎇</span>{w.name}</button>
            ))}
          </div>
        )}
        {terms.length === 0 ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 11 }}>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 22, color: "var(--txg)" }}>❯_</span>
            <div style={{ fontSize: 11, letterSpacing: 1.5, color: "var(--txl)" }}>NO OPEN TERMINALS</div>
            <button onClick={() => setNewOpen(true)} {...hp("emptynew")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: hov === "emptynew" ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--tx)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "8px 14px" }}>+ NEW TERMINAL</button>
          </div>
        ) : (
          /* real PTY panes replace the design's simulated output/input; all stay
             mounted so output keeps flowing, only the active one is visible */
          <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
            {terms.map((t) => (
              <div key={t.id} style={{ position: "absolute", inset: 8, display: t.id === activeId ? "block" : "none" }}>
                <XtermPane id={t.id} active={t.id === activeId} onEnded={() => removeTerm(t.id)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
