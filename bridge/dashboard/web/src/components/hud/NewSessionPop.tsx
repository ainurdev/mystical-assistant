/** NEW SESSION as a popover. The + beside the search opens it on the projects
 *  you last started sessions in; a project head's + New opens it on that
 *  project's branches. It floats over the list (the inline form it replaced
 *  pushed every row down 358px), and a click starts: 95% of one month's
 *  sessions started in a project's checkout, so branches wait behind the
 *  highlighted row's ⎇ chip, or →. Both pages draw in one frame of fixed rows,
 *  so switching or filtering never resizes it.
 *  Design: .mystical/design-drafts/new-session (A · LIST). */
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Copy, CornerDownLeft, FolderPlus, GitBranch, Plus, Search } from "lucide-react";
import type { SessionBrief, SessionStatus } from "../../api";
import { api } from "../../api";
import { ago } from "../../lib/surfaces";
import { jobGroup } from "../../lib/jobs";
import { orderBranches } from "../../lib/branchorder";
import { rankProjects, startCall } from "../../lib/newsession";
import { ProjectTile } from "../ui/ProjectTile";
import type { ProjectGroup } from "./ProjectsPanel";

const ROWS = 5;       // rows a page shows before "N more · type to find"
const ROW_H = 38;
const RUNNING = ["working", "checking"];

type Branches = { all: string[]; current: string; held: Set<string>; merged: Set<string> };

interface Props {
  groups: ProjectGroup[];
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  /** The project you're in: first, highlighted. */
  here: string | null;
  /** The session you're in: its branch is its project's default. */
  mine?: SessionBrief;
  /** A project head's + New: that project's branches, no way back to the list. */
  scoped?: string;
  onNew: (rel: string) => void;
  onWorktree: (rel: string, branch: string, create: boolean, parent?: string) => void;
  onNewProject: () => void;
  onClose: () => void;
}

const tail = (b: string) => b.split("/").pop() || b;
const well = "var(--side-well, color-mix(in srgb, var(--acc) 6%, transparent))";
const kbd: CSSProperties = {
  flex: "none", display: "inline-grid", placeItems: "center", minWidth: 18, height: 18, padding: "0 5px", boxSizing: "border-box",
  borderRadius: "min(5px, var(--f-rad-s, 0px))", fontSize: "var(--t10)", fontWeight: 600, lineHeight: 1, color: "var(--txl)",
  background: "color-mix(in srgb, var(--txl) 12%, transparent)",
};
const sub: CSSProperties = { flex: "none", fontSize: "var(--t11)", fontWeight: 500, color: "var(--txl)", fontVariantNumeric: "tabular-nums" };
const rowStyle = (on: boolean): CSSProperties => ({
  display: "flex", alignItems: "center", gap: 10, height: ROW_H, padding: "0 8px 0 10px", borderRadius: "var(--f-rad, 0px)", cursor: "pointer",
  background: on ? "var(--side-row, color-mix(in srgb, var(--acc) 8%, transparent))" : "transparent",
  boxShadow: on ? "inset 0 0 0 1px color-mix(in srgb, var(--acc) 38%, transparent)" : "none",
});
const nameStyle = (on: boolean, acc = false): CSSProperties => ({
  flex: "0 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  fontSize: "var(--t13)", fontWeight: on ? 650 : 500, color: acc ? "var(--acc)" : on ? "var(--txb)" : "var(--txh)",
});
const glyph: CSSProperties = { flex: "none", width: 22, display: "inline-grid", placeItems: "center", color: "var(--txl)" };
const chip: CSSProperties = {
  flex: "0 1 auto", minWidth: 32, maxWidth: 128, overflow: "hidden", display: "inline-flex", alignItems: "center", gap: 4, height: 22, padding: "0 6px 0 7px", border: 0, margin: 0,
  borderRadius: "min(6px, var(--f-rad-s, 0px))", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t11)", fontWeight: 600,
  color: "var(--txm)", background: "color-mix(in srgb, var(--txl) 13%, transparent)",
};

const clip: CSSProperties = { minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
// A row's right edge takes only the room its name leaves, so a long branch
// shortens before a project's name does.
const edge: CSSProperties = { flex: "1 1 0", minWidth: 32, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 };

function Running({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span title={`${n} running`} style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--t11)", fontWeight: 600, color: "var(--ok)" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)", boxShadow: "0 0 6px color-mix(in srgb, var(--ok) 70%, transparent)" }} />
      {n}
    </span>
  );
}

export function NewSessionPop({ groups, sessions, status, here, mine, scoped, onNew, onWorktree, onNewProject, onClose }: Props) {
  const [page, setPage] = useState<string | null>(scoped ?? null); // a project's branches, or the list
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(-1);                       // -1: the page's default row
  const [from, setFrom] = useState<string | null>(null);  // a new worktree's base; null: the project's default
  const [picking, setPicking] = useState(false);          // the rows list bases for that worktree
  const [naming, setNaming] = useState(false);
  const [br, setBr] = useState<Record<string, Branches>>({});
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const lid = useId();

  const { list, started } = rankProjects(groups, sessions, here);
  // Branches load for the page's project, or on open for the one you lead
  // with: its chip names the branch a click starts on.
  const want = page ?? list[0]?.rel;
  useEffect(() => {
    if (!want || br[want]) return;
    let live = true;
    void Promise.all([api.branches(want), api.worktrees(want).catch(() => ({ worktrees: [], merged: [] as string[] }))]).then(([b, w]) => {
      if (live) setBr((m) => ({ ...m, [want]: { all: b.branches, current: b.current || b.branches[0] || "main",
        held: new Set(w.worktrees.map((x) => x.branch)), merged: new Set(w.merged) } }));
    }, () => {});
    return () => { live = false; };
  }, [want]);

  useEffect(() => { input.current?.focus(); }, [page]);
  // A head low in the list opens its popover under the fold: bring it up.
  useEffect(() => { if (scoped) ref.current?.scrollIntoView({ block: "nearest" }); }, []);
  // Anywhere else closes it; the + and a head's + New toggle it themselves.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest?.("[data-ns-anchor]")) close.current();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, []);

  const checkout = (rel: string) => br[rel]?.current ?? groups.find((g) => g.rel === rel)?.badge?.branch;
  // New work continues where you are: in the project you're in, your session's
  // branch, while it still exists; anywhere else, the checkout's.
  const dflt = (rel: string) => {
    const b = mine?.project === rel ? mine.branch : undefined;
    return b && (!br[rel] || br[rel].all.includes(b)) ? b : checkout(rel) ?? "";
  };
  const running = (rel: string, branch?: string) => sessions.filter((s) => jobGroup(s) === rel
    && RUNNING.includes(status.get(s.id)?.state ?? "") && (branch === undefined || (s.branch || checkout(rel)) === branch)).length;

  function go(rel: string, branch: string, create = false) {
    const c = startCall(branch, checkout(rel), create, create ? from ?? dflt(rel) : undefined);
    if (c.worktree) onWorktree(rel, c.branch, c.create, c.parent);
    else onNew(rel);
    close.current();
  }
  function open(rel: string) { setPage(rel); setQ(""); setHi(-1); setPicking(false); setNaming(false); setFrom(null); }

  const ql = q.trim().toLowerCase();
  const hits = ql ? list.filter((g) => `${g.name} ${g.rel}`.toLowerCase().includes(ql)) : list.slice(0, ROWS);
  const d = page ? br[page] : undefined;
  const bl = d ? [d.current, ...orderBranches(d.all.filter((b) => b !== d.current), "", d.held)] : [];
  const bhits = ql ? bl.filter((b) => b.toLowerCase().includes(ql)) : bl.slice(0, ROWS);
  const name = q.trim().replace(/\s+/g, "-");              // the form's rule for a new branch's name
  const fresh = !!name && !!d && !d.all.includes(name);    // ↵ on the worktree row makes it
  const base = page ? from ?? dflt(page) : "";

  // One list for the keys and the pointer: the page's rows, plus the new
  // worktree row under a project's branches.
  const n = !page ? hits.length : picking ? bl.length : bhits.length + 1;
  const at = Math.min(n - 1, hi >= 0 ? hi
    : !page ? 0 : picking ? Math.max(0, bl.indexOf(base)) : !d ? 0 : Math.max(0, bhits.indexOf(dflt(page))));
  function act(i: number) {
    if (!page) { const g = hits[i]; if (g) go(g.rel, dflt(g.rel)); return; }
    if (picking) { setFrom(bl[i]); setPicking(false); setHi(bhits.length); return; }
    if (i < bhits.length) { go(page, bhits[i]); return; }
    if (fresh) go(page, name, true);
    else { setNaming(true); setQ(""); input.current?.focus(); }
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    const caret = e.currentTarget.selectionStart ?? 0;
    if (e.key === "Escape") { e.preventDefault(); if (picking) setPicking(false); else close.current(); }
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) { e.preventDefault(); setHi((at + (e.key === "ArrowDown" ? 1 : -1) + n) % n); }
    else if (e.key === "Enter") { e.preventDefault(); if (n) act(at); }
    else if (e.key === "ArrowRight" && !page && caret === q.length && hits[at]) { e.preventDefault(); open(hits[at].rel); }
    else if (e.key === "ArrowLeft" && page && !scoped && !q) { e.preventDefault(); setPage(null); setHi(-1); }
  }

  const label = !page ? (ql ? "Projects" : "Recent") : picking ? "New worktree from" : "Start on";
  const more = !page ? (!ql && list.length > ROWS ? `${list.length - ROWS} more · type to find` : "")
    : !picking && !ql && bl.length > ROWS ? `${bl.length - ROWS} more branches · type to find` : "";
  const empty = !page ? (list.length ? `no project matches “${q.trim()}”` : "no projects yet")
    : !d ? "reading branches…" : fresh ? "no such branch — ↵ makes it" : `no branch matches “${q.trim()}”`;
  const opt = (i: number) => ({
    id: `${lid}-${i}`, role: "option", "aria-selected": i === at,
    onMouseEnter: () => setHi(i), onClick: () => act(i), style: rowStyle(i === at),
  });
  const pageName = page ? groups.find((g) => g.rel === page)?.name ?? page : "";

  return (
    <div
      ref={ref} className="nsp" role="dialog" aria-label={page ? `New session in ${pageName}` : "New session"}
      // Rows take the click, the box keeps the focus: typing goes on working.
      onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault(); }}
      style={{ position: "absolute", zIndex: 60, top: "100%", left: 0, right: 0, marginTop: 8, padding: 6, boxSizing: "border-box",
               border: "1px solid var(--line, color-mix(in srgb, var(--acc) 28%, transparent))", background: "var(--panel)",
               boxShadow: "0 8px 22px var(--shadow-pop)", fontFamily: "var(--ui-font, inherit)", color: "var(--txb)",
               animation: "mslide .16s ease both" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: page ? 8 : 9, height: 36, padding: "0 10px", borderRadius: "var(--f-rad, 0px)", background: well, color: "var(--txl)" }}>
        {!page && <Search size={15} strokeWidth={2} aria-hidden style={{ flex: "none" }} />}
        {page && !scoped && (
          <button onClick={() => { setPage(null); setHi(-1); }} aria-label="All projects" title="All projects  ←"
                  style={{ flex: "none", display: "inline-grid", placeItems: "center", padding: 0, margin: "0 -2px", border: 0, background: "transparent", color: "var(--txm)", cursor: "pointer" }}>
            <ChevronLeft size={15} strokeWidth={2.2} aria-hidden />
          </button>
        )}
        {page && (
          <span className="nsp-crumb" style={{ flex: "0 1 auto", minWidth: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>
            <ProjectTile project={page} />
            <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: "var(--t13)", fontWeight: 650, color: "var(--txb)" }}>{pageName}</span>
            <span style={{ flex: "none" }}>/</span>
          </span>
        )}
        <input
          ref={input} value={q} onKeyDown={onKey}
          onChange={(e) => { setQ(e.target.value); setHi(-1); setPicking(false); }}
          placeholder={!page ? "New session in…" : naming ? "new branch name…" : "branch…"}
          role="combobox" aria-expanded aria-controls={lid} aria-activedescendant={n ? `${lid}-${at}` : undefined}
          style={{ flex: "1 1 40px", minWidth: 0, height: "100%", padding: 0, border: 0, outline: "none", background: "transparent",
                   fontFamily: "inherit", fontSize: "var(--t13)", color: "var(--txb)" }}
        />
        {(!page || scoped) && <span style={kbd}>esc</span>}
      </div>

      <div className="nsp-lab" style={{ padding: "10px 10px 4px" }}>{label}</div>
      <div id={lid} role="listbox" style={{ height: scoped ? undefined : ROWS * ROW_H, minHeight: 3 * ROW_H, maxHeight: ROWS * ROW_H, overflowY: "auto", overscrollBehavior: "contain" }}>
        {!page && hits.map((g, i) => (
          <div key={g.rel} {...opt(i)}>
            <ProjectTile project={g.rel} />
            <span style={nameStyle(i === at)}>{g.name}</span>
            <Running n={running(g.rel)} />
            <span style={edge}>{i === at
              ? <button style={chip} tabIndex={-1} title="Pick a branch  →" aria-label={`Branches of ${g.name}`}
                        onClick={(e) => { e.stopPropagation(); open(g.rel); }}>
                  <GitBranch size={11} strokeWidth={2.2} aria-hidden style={{ flex: "none", color: "var(--txl)" }} /><span style={clip}>{tail(dflt(g.rel) || "branch")}</span>
                  <ChevronRight size={11} strokeWidth={2.4} aria-hidden style={{ flex: "none", color: "var(--txl)" }} />
                </button>
              : <span style={sub}>{ago(started.get(g.rel) ?? null)}</span>}</span>
          </div>
        ))}
        {page && picking && bl.map((b, i) => (
          <div key={b} {...opt(i)} title={b}>
            <span style={glyph}><GitBranch size={14} strokeWidth={2} aria-hidden /></span>
            <span style={nameStyle(i === at)}>{b}</span>
            <span style={{ flex: 1 }} />
            {b === base && <span style={sub}>from</span>}
          </div>
        ))}
        {page && !picking && d && bhits.map((b, i) => {
          const wt = b !== d.current && d.held.has(b), r = running(page, b);
          return (
            <div key={b} {...opt(i)} title={b}>
              <span style={glyph}>{wt ? <Copy size={13} strokeWidth={2} aria-hidden /> : <GitBranch size={14} strokeWidth={2} aria-hidden />}</span>
              <span style={nameStyle(i === at)}>{tail(b)}</span>
              <span style={{ flex: 1 }} />
              {b === d.current && <span style={sub}>checkout</span>}
              <Running n={r} />
              {!r && b !== d.current && <span style={sub}>{!wt ? "no worktree yet" : d.merged.has(b) ? "merged" : "idle"}</span>}
            </div>
          );
        })}
        {(page ? !picking && !bhits.length : !hits.length) && (
          <div style={{ padding: "10px", fontSize: "var(--t12)", color: "var(--txl)" }}>{empty}</div>
        )}
      </div>
      <div style={{ height: 28, padding: "0 10px", display: "flex", alignItems: "center", fontSize: "var(--t11)", fontWeight: 500, color: "var(--txl)" }}>{more}</div>
      <div style={{ height: 1, margin: "0 4px 2px", background: "var(--line, color-mix(in srgb, var(--acc) 14%, transparent))" }} />

      {!page ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, height: ROW_H, padding: "0 6px 0 4px", fontSize: "var(--t11)", fontWeight: 500, color: "var(--txl)" }}>
          <button onClick={onNewProject}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 6px", border: 0, borderRadius: "var(--f-rad-s, 0px)",
                           background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t11)", fontWeight: 600, color: "var(--txm)" }}>
            <FolderPlus size={13} strokeWidth={2} aria-hidden />New project
          </button>
          <span style={{ flex: 1 }} />
          <span style={kbd}><CornerDownLeft size={10} strokeWidth={2.4} aria-hidden /></span>start
          <span style={kbd}>→</span>branch
        </div>
      ) : (
        // While bases are listed it isn't a row of that list: a tap just folds them.
        <div {...(picking ? { onClick: () => setPicking(false), style: rowStyle(false) } : opt(bhits.length))}>
          <span style={{ ...glyph, color: "var(--acc)" }}><Plus size={15} strokeWidth={2.2} aria-hidden /></span>
          <span style={{ ...nameStyle(!picking && at === bhits.length, true), flex: "none" }}>New worktree</span>
          <span style={edge}><span style={sub}>from</span>
          <button style={chip} tabIndex={-1} aria-label={`Base: ${base}`} aria-expanded={picking} title="The branch it starts from"
                  onClick={(e) => { e.stopPropagation(); setPicking((p) => !p); setHi(-1); }}>
            <GitBranch size={11} strokeWidth={2.2} aria-hidden style={{ flex: "none", color: "var(--txl)" }} /><span style={clip}>{tail(base || "branch")}</span>
            <ChevronDown size={11} strokeWidth={2.4} aria-hidden style={{ flex: "none", color: "var(--txl)" }} />
          </button></span>
        </div>
      )}
    </div>
  );
}
