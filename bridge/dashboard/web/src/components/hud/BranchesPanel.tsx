import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, GitBranch, GitCommitHorizontal, MessageSquare, Plus } from "lucide-react";
import { api, type SessionBrief, type SessionStatus } from "../../api";
import { branchGroups, CHIPS, type Activity, type BranchPr, type BranchStatus, type Chip, type ShownRow } from "../../lib/branchrows";
import { ago } from "../../lib/surfaces";

/* BRANCHES — the right rail's view of the open session's repo, for watching
   every branch at once (.mystical/design-drafts/branches-tab, round 2).
   On top, four chips count what's working, uncommitted, unmerged and merged,
   and each one filters the list. A row is three even lines: the name and its
   age; a live session's title, else the last commit's subject; then where it
   stands against the base. Hover a row for + Session (in its worktree, or a new
   worktree for a branch without one); a click opens its newest session.
   + Branch makes a worktree from a branch and opens a session there.
   Merge and delete stay a sentence to Claude.
   Rows, groups and chips: lib/branchrows. Two bridge calls: git.branch_status,
   then the PRs (prstatus.branch_prs) for a repo with anything pushed. */

const FOLD = 8;
const SEC: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, padding: "12px 14px 5px", fontSize: "var(--t9)", letterSpacing: 1.4, color: "var(--txl)" };
const MONO = "'JetBrains Mono',monospace";
const CHIP_TONE: Record<Chip, string> = { waiting: "var(--ask, var(--warn))", working: "var(--ok)", uncommitted: "var(--warn)", unmerged: "var(--acc)", merged: "var(--purple-h)" };
// prstatus.chip_state's words, as a chip
const PR_CHIP: Record<string, [string, string]> = {
  merged: ["merged", "var(--purple-h)"], closed: ["closed", "var(--txd)"], conflicts: ["conflict", "var(--warn)"],
  failing: ["failing", "var(--err)"], changes: ["changes asked", "var(--warn)"], running: ["checks running", "var(--txm)"],
  ready: ["✓ ready", "var(--ok)"], review: ["in review", "var(--txm)"],
};

function Tag({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ flex: "none", fontSize: "var(--t8)", letterSpacing: 1, lineHeight: "15px", padding: "0 5px", borderRadius: 4, color,
                   border: `1px solid color-mix(in srgb, ${color} 45%, transparent)` }}>{text}</span>
  );
}

/** Distance from the base: behind in amber left of the tick, ahead in green right of it (√ scale). */
function Bar({ r, max }: { r: ShownRow; max: { a: number; b: number } }) {
  const a = r.ahead ? Math.max(.08, Math.sqrt(r.ahead / max.a)) * 32 : 0;
  const b = r.behind ? Math.max(.08, Math.sqrt(r.behind / max.b)) * 10 : 0;
  return (
    <span style={{ position: "relative", flex: "none", width: 44, height: 4, marginRight: 8 }}>
      <i style={{ position: "absolute", left: 11, top: -2, width: 1, height: 8, background: "color-mix(in srgb, var(--txd) 70%, transparent)" }} />
      {b > 0 && <b style={{ position: "absolute", top: 0, height: 4, borderRadius: 2, left: 11 - b, width: b, background: "var(--warn)", opacity: .85 }} />}
      {a > 0 && <b style={{ position: "absolute", top: 0, height: 4, borderRadius: 2, left: 12, width: a, background: "var(--ok)" }} />}
    </span>
  );
}

function Row({ r, base, max, sess, live, onOpen, onNew }: {
  r: ShownRow; base: string; max: { a: number; b: number };
  sess: SessionBrief[]; live: SessionBrief | undefined;
  onOpen: (s: SessionBrief) => void; onNew: (r: ShownRow) => void;
}) {
  const dot = !r.name ? "var(--warn)" : r.activity === "asking" ? "var(--ask, var(--warn))" : r.activity === "working" ? "var(--ok)" : null;
  const tone = r.activity === "asking" ? "var(--ask, var(--warn))" : "var(--ok)";
  const facts: ReactNode[] = [
    r.base ? <span key="d" style={{ color: "var(--txd)" }}>the base</span>
      : r.landed && !r.ahead ? <span key="d" style={{ color: "var(--ok)" }}>✓ in {base}</span>
      : !r.ahead && !r.behind ? <span key="d" style={{ color: "var(--txd)" }}>same as {base}</span>
      : <span key="d" style={{ color: r.behind && !r.ahead ? "var(--warn)" : "var(--txm)" }}>
          <Bar r={r} max={max} />{[r.ahead && `↑${r.ahead}`, r.behind && `↓${r.behind}`].filter(Boolean).join(" ")}
        </span>,
  ];
  if (r.dirty) facts.push(<span key="u" style={{ color: "var(--warn)" }}>●{r.dirty} uncommitted</span>);
  if (r.pr) {
    const [t, c] = PR_CHIP[r.pr.status] ?? ["open", "var(--txm)"];
    facts.push(<span key="p" style={{ lineHeight: "12px", height: 14, padding: "0 5px", borderRadius: 4, color: c, border: `1px solid color-mix(in srgb, ${c} 45%, transparent)` }}>
      #{r.pr.number} {r.pr.status === "failing" ? `✗ ${r.pr.failed} failing` : t}</span>);
  }
  if (sess.length) facts.push(<span key="s" style={{ color: "var(--txl)" }} title={`${sess.length} session${sess.length === 1 ? "" : "s"} on this branch`}>
    <MessageSquare size={11} strokeWidth={2.2} aria-hidden style={{ color: "var(--txd)" }} />{sess.length}</span>);
  const push = !r.name || r.landed || (r.base && !r.upstream) ? null
    : !r.upstream ? <span style={{ color: "var(--txd)" }}>local</span>
    : r.unpushed ? <span style={{ color: "var(--warn)" }}>↑{r.unpushed} to push</span>
    : <span style={{ color: "var(--txd)" }}>✓ pushed</span>;
  return (
    <div className="brow" data-here={r.here || undefined} onClick={sess[0] ? () => onOpen(sess[0]) : undefined}
      title={[r.name || `detached at ${r.head}`, r.worktree, sess[0] && "click: its newest session"].filter(Boolean).join("\n")}
      style={{ cursor: sess[0] ? "pointer" : "default" }}>
      <div className="brow-l1">
        {dot ? (
          <span className={r.activity === "working" ? "sessdot" : undefined} data-work={r.activity === "working" || undefined}
            style={{ flex: "none", width: 7, height: 7, borderRadius: "50%", background: dot, boxShadow: r.activity ? `0 0 6px color-mix(in srgb, ${dot} 50%, transparent)` : undefined }} />
        ) : (
          <span style={{ flex: "none", width: 7, height: 7, boxSizing: "border-box", borderRadius: "50%", border: "1.5px solid color-mix(in srgb, var(--txd) 80%, transparent)" }} />
        )}
        <span style={{ fontFamily: MONO, fontSize: "var(--t105)", color: "var(--txb)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
        {r.here && <Tag text="HERE" color="var(--acc)" />}
        {r.base && <Tag text="BASE" color="var(--txl)" />}
        {!r.name && <Tag text="CHECKOUT" color="var(--txl)" />}
        {/* the age and + Session share one cell, so the row never moves */}
        <span className="brow-end">
          <span className="brow-age">{ago(r.at)}</span>
          <span className="rowact brow-go">
            {!r.worktree && <span className="brow-hint">new worktree</span>}
            <button className="gp-pb tint brow-pill" onClick={(e) => { e.stopPropagation(); onNew(r); }}
              title={r.worktree ? `New session in ${r.worktree}` : `Check ${r.name} out into a new worktree and start a session there`}>
              <Plus size={10} strokeWidth={2.6} aria-hidden />Session
            </button>
          </span>
        </span>
      </div>
      <div className="brow-l2">
        {live ? (
          <>
            <MessageSquare size={12} strokeWidth={2} aria-hidden style={{ flex: "none", color: tone }} />
            <span className="t" style={{ color: tone }}>{live.title || "fresh session"}</span>
            <span style={{ flex: "none", color: tone }}>{r.activity === "asking" ? "waits on you" : "working"}</span>
          </>
        ) : (
          <>
            <GitCommitHorizontal size={12} strokeWidth={2} aria-hidden style={{ flex: "none", color: "var(--txd)" }} />
            <span className="t">{r.subject}</span>
          </>
        )}
      </div>
      <div className="brow-l3">
        <span className="brow-facts">{facts}</span>
        <span style={{ flex: 1 }} />
        {push}
      </div>
    </div>
  );
}

function Group({ title, rows, fold, render }: { title: string; rows: ShownRow[]; fold?: boolean; render: (r: ShownRow) => ReactNode }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = fold && !all ? rows.slice(0, FOLD) : rows;
  return (
    <>
      <div style={SEC}>{title}<span style={{ color: "var(--txd)" }}>{rows.length}</span></div>
      {shown.map(render)}
      {shown.length < rows.length && (
        <button onClick={() => setAll(true)}
          style={{ appearance: "none", border: 0, background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t95)", color: "var(--txd)", padding: "6px 16px" }}>
          {rows.length - shown.length} more ↓
        </button>
      )}
    </>
  );
}

export function BranchesPanel({ project, branch, sessions, status, nonce, onOpen, onNew, onNewBranch }: {
  project: string | null;
  branch?: string;                        // the open session's: HERE
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  nonce: number;                          // App's gitNonce: a commit, a push, a checkout
  onOpen: (s: SessionBrief) => void;
  onNew: (r: ShownRow) => void;           // + Session on a row
  onNewBranch: (name: string, from: string) => void;
}) {
  const [data, setData] = useState<BranchStatus | null>(null);
  const [prs, setPrs] = useState<Record<string, BranchPr>>({});
  const [err, setErr] = useState("");
  const [hov, setHov] = useState(false);
  const [only, setOnly] = useState<Chip | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const d = await api.branchStatus(project);
      setData(d); setErr("");
      // gh only for a repo with something pushed: a local-only one has no PRs to find
      if (!d.branches.some((b) => b.upstream && b.name !== d.base)) setPrs({});
      else void api.branchPrs(project).then((r) => setPrs(r.prs ?? {}), () => setPrs({}));
    } catch (e) { setErr((e as Error).message); }
  }, [project]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30000);
    return () => clearInterval(id);
  }, [load, nonce]);

  // Each branch's sessions, newest first, and the one busy there: waiting on you outranks working.
  const { activity, byBranch, live } = useMemo(() => {
    const activity = new Map<string, Activity>(), byBranch = new Map<string, SessionBrief[]>(), live = new Map<string, SessionBrief>();
    for (const s of sessions) {
      if (s.project !== project || !s.branch || s.archived) continue;
      (byBranch.get(s.branch) ?? byBranch.set(s.branch, []).get(s.branch)!).push(s);
      const st = status.get(s.id)?.state;
      if (st === "awaiting" || st === "asking") { activity.set(s.branch, "asking"); live.set(s.branch, s); }
      else if ((st === "working" || st === "checking") && activity.get(s.branch) !== "asking") { activity.set(s.branch, "working"); live.set(s.branch, s); }
    }
    for (const l of byBranch.values()) l.sort((a, b) => b.updated - a.updated);
    return { activity, byBranch, live };
  }, [sessions, status, project]);

  const base = data?.base ?? "";
  const g = useMemo(() => branchGroups(data?.branches ?? [], base, branch ?? null, activity, prs), [data, base, branch, activity, prs]);
  const counts = useMemo(() => Object.fromEntries((Object.keys(CHIPS) as Chip[]).map((k) => [k, g.all.filter(CHIPS[k]).length])) as Record<Chip, number>, [g]);
  const shown: Chip[] = [counts.waiting ? "waiting" : "working", "uncommitted", "unmerged", "merged"];
  const f = only && shown.includes(only) && counts[only] ? only : null;    // a filter whose chip or rows are gone lets go
  const pick = (rows: ShownRow[]) => f ? rows.filter(CHIPS[f]) : rows;
  const max = { a: Math.max(1, ...g.all.map((r) => r.ahead)), b: Math.max(1, ...g.all.map((r) => r.behind)) };
  const row = (r: ShownRow) => (
    <Row key={r.name || `@${r.worktree}`} r={r} base={base} max={max} sess={(r.name && byBranch.get(r.name)) || []}
      live={r.name ? live.get(r.name) : undefined} onOpen={onOpen} onNew={onNew} />
  );
  const make = () => {
    const n = name.trim();
    if (!n) return;
    onNewBranch(n, from || base);
    setNaming(false); setName("");
  };
  const btn: React.CSSProperties = { appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px" };

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>BRANCHES</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {project && data && data.branches.length > 0 && (
            <button onClick={() => setNaming((v) => !v)} aria-expanded={naming} title="A new branch in its own worktree, and a session there"
              style={{ ...btn, display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--t9)",
                       ...(naming ? { color: "var(--acc)", background: "color-mix(in srgb, var(--acc) 12%, transparent)" } : {}) }}>
              <Plus size={10} strokeWidth={2.6} aria-hidden />Branch
            </button>
          )}
          <button onClick={() => void load()} title="refresh" onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
            style={{ ...btn, background: hov ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent" }}>⟳</button>
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />
      {base && (
        <div className="swapin" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px 0", fontSize: "var(--t9)", color: "var(--txd)", fontFamily: MONO }}>
          <span style={{ color: "var(--purple)" }}>⎇</span><span style={{ color: "var(--purple-h)" }}>{base}</span><span>is the base</span>
        </div>
      )}
      {naming && (
        <>
          <form className="bnew" onSubmit={(e) => { e.preventDefault(); make(); }}>
            <GitBranch size={11} strokeWidth={2.2} aria-hidden style={{ flex: "none", color: "var(--txl)" }} />
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="new branch name…" aria-label="New branch name"
              onKeyDown={(e) => { if (e.key === "Escape") { setNaming(false); setName(""); } }} />
            {/* the chip shows the pick; the native select, invisible on top, does the picking */}
            <label className="bnew-from" title="The branch it starts from">from
              <span className="bnew-base"><GitBranch size={10} strokeWidth={2.2} aria-hidden style={{ flex: "none", color: "var(--purple)" }} />
                <span className="v">{from || base}</span><ChevronDown size={10} strokeWidth={2.4} aria-hidden style={{ flex: "none" }} /></span>
              <select value={from || base} onChange={(e) => setFrom(e.target.value)} aria-label="Start from">
                {(data?.branches ?? []).filter((b) => b.name).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
            </label>
            <button type="submit" className="bnew-kbd" aria-label="Create the branch and start a session" disabled={!name.trim()}>↵</button>
          </form>
          <div style={{ margin: "5px 14px 0 21px", fontSize: "var(--t9)", color: "var(--txd)" }}>makes the worktree, opens a session there · esc closes</div>
        </>
      )}
      {data && data.branches.length > 0 && (
        <div className="bov" role="group" aria-label="Show only">
          {shown.map((k) => (
            <button key={k} className="bovc" disabled={!counts[k]} aria-pressed={f === k} data-on={f === k || undefined}
              style={counts[k] ? { ["--c" as string]: CHIP_TONE[k] } : undefined} onClick={() => setOnly(f === k ? null : k)}
              title={f === k ? "Show every branch" : `Show only the ${k} ones`}>
              <b>{counts[k]}</b>{k}
            </button>
          ))}
        </div>
      )}
      <div className="mscroll" style={{ padding: "4px 0 14px", flex: 1, minHeight: 0, overflowY: "auto" }}>
        {!project && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 14px" }}>No session selected.</div>}
        {project && err && <div style={{ fontSize: "var(--t105)", color: "var(--err)", padding: "8px 14px" }}>Couldn't read the branches: {err}</div>}
        {project && !err && !data && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 14px" }}>Reading branches…</div>}
        {project && data && !data.branches.length && (
          <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 14px" }}>No branches: not a git repo?</div>
        )}
        <div className="swapin">
          <Group title="WORKTREES" rows={pick(g.worktrees)} render={row} />
          <Group title="BRANCHES" rows={pick(g.branches)} render={row} fold />
          <Group title="MERGED" rows={pick(g.merged)} render={row} fold />
        </div>
      </div>
    </div>
  );
}
