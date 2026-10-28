import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SessionBrief, type SessionStatus } from "../../api";
import { branchGroups, type Activity, type BranchStatus, type ShownRow } from "../../lib/branchrows";
import { ago } from "../../lib/surfaces";

/* BRANCHES — the right rail's view of the open session's repo: every worktree
   and branch with its status, and nothing to press but ⟳
   (.mystical/design-drafts/project-split). It replaces the project window's
   WORKTREES tab, whose create / merge / delete stay a sentence to Claude.
   Rows and their order: lib/branchrows. One bridge call (git.branch_status). */

const FOLD = 8;
const SEC: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, padding: "12px 14px 5px", fontSize: "var(--t9)", letterSpacing: 1.4, color: "var(--txl)" };

function Tag({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ flex: "none", fontSize: "var(--t8)", letterSpacing: 1, lineHeight: "15px", padding: "0 5px", borderRadius: 4, color,
                   border: `1px solid color-mix(in srgb, ${color} 45%, transparent)` }}>{text}</span>
  );
}

function Row({ r, base }: { r: ShownRow; base: string }) {
  const chips: [string, string][] = [];
  if (r.activity === "asking") chips.push(["waits on you", "var(--ask, var(--warn))"]);
  if (r.activity === "working") chips.push(["working", "var(--ok)"]);
  if (r.merged && !r.worktree) chips.push([`✓ in ${base}`, "var(--ok)"]);
  else if (!r.base && (r.ahead || r.behind))
    chips.push([`${r.ahead ? `↑${r.ahead}` : ""}${r.ahead && r.behind ? " " : ""}${r.behind ? `↓${r.behind}` : ""} on ${base}`,
                r.behind ? "var(--warn)" : "var(--ok)"]);
  if (r.name && !r.merged) {
    if (!r.upstream) chips.push(["not pushed", "var(--warn)"]);
    else if (r.unpushed) chips.push([`↑${r.unpushed} to push`, "var(--warn)"]);
    else chips.push(["✓ pushed", "var(--txl)"]);
  }
  if (r.dirty) chips.push([`●${r.dirty} uncommitted`, "var(--warn)"]);
  const dot = !r.name ? "var(--warn)" : r.activity === "asking" ? "var(--ask, var(--warn))" : r.activity === "working" ? "var(--ok)" : null;
  return (
    <div title={[r.name || `detached at ${r.head}`, r.worktree].filter(Boolean).join("\n")}
      style={{ margin: "1px 6px", padding: "7px 8px 8px", borderRadius: 8,
               background: r.here ? "color-mix(in srgb, var(--acc) 9%, transparent)" : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {dot ? (
          <span className={r.activity === "working" ? "sessdot" : undefined} data-work={r.activity === "working" || undefined}
            style={{ flex: "none", width: 7, height: 7, borderRadius: "50%", background: dot, boxShadow: r.activity ? `0 0 6px color-mix(in srgb, ${dot} 50%, transparent)` : undefined }} />
        ) : (
          <span style={{ flex: "none", width: 7, height: 7, boxSizing: "border-box", borderRadius: "50%", border: "1.5px solid color-mix(in srgb, var(--txd) 80%, transparent)" }} />
        )}
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)", color: "var(--txb)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
        {r.here && <Tag text="HERE" color="var(--acc)" />}
        {r.base && <Tag text="BASE" color="var(--txl)" />}
        {!r.name && <Tag text="CHECKOUT" color="var(--txl)" />}
        <span style={{ flex: "none", minWidth: 22, textAlign: "right", fontSize: "var(--t9)", color: "var(--txd)" }}>{ago(r.at)}</span>
      </div>
      {chips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 9px", margin: "4px 0 0 15px", fontSize: "var(--t95)" }}>
          {chips.map(([t, c]) => <span key={t} style={{ color: c, whiteSpace: "nowrap" }}>{t}</span>)}
        </div>
      )}
    </div>
  );
}

function Group({ title, rows, base, fold }: { title: string; rows: ShownRow[]; base: string; fold?: boolean }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = fold && !all ? rows.slice(0, FOLD) : rows;
  return (
    <>
      <div style={SEC}>{title}<span style={{ color: "var(--txd)" }}>{rows.length}</span></div>
      {shown.map((r) => <Row key={r.name || `@${r.worktree}`} r={r} base={base} />)}
      {shown.length < rows.length && (
        <button onClick={() => setAll(true)}
          style={{ appearance: "none", border: 0, background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t95)", color: "var(--txd)", padding: "6px 16px" }}>
          {rows.length - shown.length} more ↓
        </button>
      )}
    </>
  );
}

export function BranchesPanel({ project, branch, sessions, status, nonce }: {
  project: string | null;
  branch?: string;                        // the open session's: HERE
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  nonce: number;                          // App's gitNonce: a commit, a push, a checkout
}) {
  const [data, setData] = useState<BranchStatus | null>(null);
  const [err, setErr] = useState("");
  const [hov, setHov] = useState(false);

  const load = useCallback(async () => {
    if (!project) return;
    try { setData(await api.branchStatus(project)); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  }, [project]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30000);
    return () => clearInterval(id);
  }, [load, nonce]);

  // Which branches a session is busy on: one waiting on you outranks working.
  const activity = useMemo(() => {
    const m = new Map<string, Activity>();
    for (const s of sessions) {
      if (s.project !== project || !s.branch) continue;
      const st = status.get(s.id)?.state;
      if (st === "awaiting" || st === "asking") m.set(s.branch, "asking");
      else if ((st === "working" || st === "checking") && m.get(s.branch) !== "asking") m.set(s.branch, "working");
    }
    return m;
  }, [sessions, status, project]);

  const base = data?.base ?? "";
  const g = useMemo(() => branchGroups(data?.branches ?? [], base, branch ?? null, activity), [data, base, branch, activity]);

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>BRANCHES</span>
        <button onClick={() => void load()} title="refresh" onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px" }}>⟳</button>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />
      {base && (
        <div className="swapin" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px 0", fontSize: "var(--t9)", color: "var(--txd)", fontFamily: "'JetBrains Mono',monospace" }}>
          <span style={{ color: "var(--purple)" }}>⎇</span><span style={{ color: "var(--purple-h)" }}>{base}</span><span>is the base</span>
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
          <Group title="WORKTREES" rows={g.worktrees} base={base} />
          <Group title="BRANCHES" rows={g.branches} base={base} fold />
          <Group title="MERGED" rows={g.merged} base={base} fold />
        </div>
      </div>
    </div>
  );
}
