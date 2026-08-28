import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SessionBrief, SessionStatus } from "../../api";
import { api } from "../../api";
import { ago, projectName, projectTint } from "../../lib/surfaces";
import { useStickyFlag, useStickyStr } from "../../lib/prefs";
import type { ProjectGroup } from "./ProjectsPanel";

/** A prompt of yours that hasn't run yet, flagged on the session it belongs to:
 *  unsent text in the composer, a relevance check in flight, or a held card
 *  waiting on your answer. */
export type PromptFlag = "draft" | "checking" | "held";

// Flags render as quiet meta-line words, in the same voice as tags — a chip
// would out-shout the state dot that the whole panel now leans on.
const FLAG_VIEW: Record<PromptFlag, { c: string; l: string; t: string }> = {
  draft: { c: "var(--warn)", l: "✎ draft", t: "unsent prompt waiting in this session" },
  checking: { c: "var(--purple)", l: "checking…", t: "checking this prompt fits this session" },
  held: { c: "var(--warn)", l: "held", t: "a prompt here needs your decision" },
};

interface Props {
  sessions: SessionBrief[]; // full list — RECENT and expanded projects need more than the capped group slices
  groups: ProjectGroup[];
  status: Map<string, SessionStatus>;
  done: Set<string>; // finished a turn, not opened since
  flags: Map<string, PromptFlag>; // prompts of yours that haven't run yet
  pins: Set<string>; // sessions you pinned — ranked first here and in the context menu
  selectedSessionId: string | null;
  /** First session list hasn't landed yet — the empty list means nothing yet. */
  booting?: boolean;
  activeProject: string | null;
  onTogglePin: (id: string) => void;
  onSelectSession: (s: SessionBrief) => void;
  onAnalyze: (rel: string) => void;
  onNewSession: (rel: string) => void;
  /** Start a typed session: the form's fields, already composed into a prompt. */
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string) => void;
}

type Mode = "attention" | "projects" | "recent";
/** How much of a row's provenance it prints. `notable` is the default and the
 *  point of the setting: on a machine where most sessions sit on master in the
 *  main checkout, printing "master" on every row is a column of noise that
 *  hides the two rows that are somewhere else. */
type Detail = "notable" | "all" | "none";
type OrderMode = "recent" | "alpha" | "biggest" | "custom";

const PROJ_CAP = 10; // project chips shown before "SHOW ALL"

const ORDER_LABEL: Record<OrderMode, string> = {
  recent: "recently used", alpha: "a → z", biggest: "biggest", custom: "custom",
};
const ORDERS: OrderMode[] = ["recent", "alpha", "biggest", "custom"];

const DETAIL_LABEL: Record<Detail, string> = {
  notable: "only what differs", all: "branch + worktree", none: "nothing",
};
const DETAIL_TIP: Record<Detail, string> = {
  notable: "Show a branch only when it isn't main/master, and a worktree only when it isn't the main checkout",
  all: "Show the branch and worktree on every row",
  none: "No branch or worktree on any row",
};
const DETAILS: Detail[] = ["notable", "all", "none"];

// Which mode you were on, how PROJECTS is ordered, and your hand-dragged order.
// ponytail: localStorage = per-browser, like every other HUD pref (see lib/surfaces.ts).
const PREFS_KEY = "hud-sessions-prefs";
type Prefs = { mode: Mode; order: OrderMode; custom: string[] };

function loadPrefs(): Prefs {
  try {
    const r = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") as Partial<Prefs> & { tab?: string };
    // Pre-v3 prefs stored {tab: "recent"|"grouped"} — carry the choice over once.
    const mode: Mode =
      r.mode === "attention" || r.mode === "projects" || r.mode === "recent" ? r.mode
        : r.tab === "grouped" ? "projects" : r.tab === "recent" ? "recent" : "attention";
    return {
      mode,
      order: r.order && ORDERS.includes(r.order) ? r.order : "recent",
      custom: Array.isArray(r.custom) ? r.custom : [],
    };
  } catch { return { mode: "attention", order: "recent", custom: [] }; }
}

/** The four lanes ATTENTION sorts every session into. */
type LaneKey = "ask" | "work" | "done" | "idle";

const LANES: { k: LaneKey; label: string; tint: string }[] = [
  { k: "ask", label: "NEEDS YOU", tint: "var(--warn)" },
  { k: "work", label: "WORKING", tint: "var(--ok)" },
  { k: "done", label: "DONE — NOT OPENED", tint: "var(--acc)" },
  { k: "idle", label: "IDLE", tint: "var(--txd)" },
];

// Server state → lane, dot colour, filled?, tooltip. The dot's grammar: filled
// means the machine did or is doing something; a ring is passive. Ring colour
// still tells idle (dim) from live-elsewhere (info) from parked (warn) — the
// lane collapses to four, the dot keeps the detail.
const SV: Record<string, { lane: LaneKey; c: string; fill: boolean; t: string }> = {
  working: { lane: "work", c: "var(--ok)", fill: true, t: "working now" },
  checking: { lane: "work", c: "var(--ok)", fill: true, t: "checking your prompt against this session" },
  awaiting: { lane: "ask", c: "var(--warn)", fill: true, t: "waiting on your answer" },
  asking: { lane: "ask", c: "var(--warn)", fill: true, t: "asking you a question" },
  live: { lane: "idle", c: "var(--info)", fill: false, t: "live in another window" },
  parked: { lane: "idle", c: "var(--warn)", fill: false, t: "parked — resumes when the limit resets" },
  idle: { lane: "idle", c: "var(--txl)", fill: false, t: "idle" },
};
const SV_DONE = { lane: "done" as LaneKey, c: "var(--acc)", fill: false, t: "finished a turn — not opened yet" };

const BUSY_NOW = ["working", "awaiting", "asking", "checking"];

type StateView = { lane: LaneKey; c: string; fill: boolean; t: string };

function resolve(st: SessionStatus | undefined, isDone: boolean, flag?: PromptFlag): StateView {
  // DONE (finished, unopened) outranks idle/live, but never a state it's in
  // *now* — working, awaiting you, asking you, or having a prompt checked.
  const state = st?.state ?? "idle";
  const busy = BUSY_NOW.includes(state);
  let v = isDone && !busy ? SV_DONE : SV[state] ?? SV.idle;
  // A held card is a session that wants you, whatever its runner state says —
  // warn ring, not fill: nothing is running, a prompt of yours is parked on it.
  if (flag === "held" && (v.lane === "idle" || v.lane === "done"))
    v = { ...v, lane: "ask", c: "var(--warn)" };
  return v;
}

function SessionRow({
  s, on, v, flag, branch, pinned, showDot, showProj, detail, compact, pulse, onPin, onAttach,
}: {
  s: SessionBrief;
  on: boolean;
  v: StateView;
  flag?: PromptFlag;
  branch: string;
  pinned: boolean;
  showDot: boolean;  // PROJECTS rows carry the state dot; lane rows wear it as their left edge
  showProj: boolean; // lane rows name their project; PROJECTS rows sit under a header that already does
  detail: Detail;    // how much provenance the meta line prints
  compact: boolean;  // title only
  pulse: boolean;    // a turn is in flight — the one state that earns motion
  onPin: () => void;
  onAttach: () => void;
}) {
  const [hov, setHov] = useState(false);
  const tint = projectTint(s.project);
  const fv = flag ? FLAG_VIEW[flag] : null;
  // A sidebar has no room for a full ref, so a row prints the branch's last
  // segment; the full ref lives in the row tooltip. Compact drops the whole meta
  // line, and DETAILS decides how much of the rest is worth the width.
  // `s.worktree` is empty for the main checkout (git.worktree_name), so "in a
  // worktree at all" and "not the main worktree" are the same question.
  const onDefault = branch === "master" || branch === "main";
  const inWorktree = !!(s.worktree || s.work_cwd);
  const wtTitle = s.work_cwd ? `working in ${s.work_cwd}` : s.worktree ? `worktree ${s.worktree}` : "";
  const branchShown = detail === "all" ? !!branch : detail === "notable" && !!branch && !onDefault;
  // A worktree usually carries the branch of the same name, and then the row
  // would say it twice — only a tree named something else earns the second word.
  // Under ALL it always earns it, because that is what ALL was asked for.
  const wtShown = detail !== "none" && inWorktree
    && (detail === "all" || !branchShown || s.worktree !== branch.split("/").pop());
  const metaShow = !compact && !!(showProj || branchShown || wtShown || fv || s.goal);
  return (
    <div
      onClick={onAttach}
      className="sessrow" data-on={showDot && on}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      data-ctx-type="session" data-ctx-id={s.id} data-ctx-label={s.title || "session"}
      title={`${s.title || "untitled session"} · ${projectName(s.project)} · ${branch} · ${v.t}`}
      style={{
        display: "grid", gridTemplateColumns: showDot ? "8px 1fr auto" : "1fr auto", columnGap: 10,
        alignItems: "start", padding: compact ? "5px 8px" : "8px 8px 9px", position: "relative",
        // Lane rows wear their state on the left edge; PROJECTS rows carry a
        // dot instead and the .sessrow bar marks the open one.
        borderLeft: showDot ? undefined : `2px solid ${on ? "var(--acc)" : `color-mix(in srgb, ${v.c} 32%, transparent)`}`,
        background: on ? "color-mix(in srgb, var(--acc) 6%, transparent)" : hov ? "color-mix(in srgb, var(--acc) 4%, transparent)" : "transparent",
        cursor: "pointer", transition: "background .13s ease",
      }}
    >
      {showDot && (
        <span
          className="sessdot" data-work={pulse} title={v.t}
          style={{ width: 8, height: 8, marginTop: compact ? 4 : 3, borderRadius: "50%", boxSizing: "border-box",
                   background: v.fill ? v.c : "transparent", border: v.fill ? 0 : `1.5px solid ${v.c}`,
                   boxShadow: v.fill ? `0 0 7px color-mix(in srgb, ${v.c} 40%, transparent)` : "none" }}
        />
      )}
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                       fontSize: showDot ? "var(--t12)" : "var(--t125)", lineHeight: 1.3,
                       fontWeight: on ? 600 : 500, color: on ? "var(--txb)" : "var(--txh)" }}>
          {s.title || "untitled session"}
        </span>
        {metaShow && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, fontSize: "var(--t95)", lineHeight: 1 }}>
            {showProj && (
              <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tint.color }}>
                {projectName(s.project)}
              </span>
            )}
            {branchShown && (
              <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                             color: inWorktree ? "var(--acc)" : "var(--txd)" }}>
                ⎇ {branch.split("/").pop()}
              </span>
            )}
            {wtShown && (
              <span title={wtTitle} style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                                             whiteSpace: "nowrap", color: "var(--acc)" }}>
                ⧉{s.worktree ? ` ${s.worktree}` : ""}
              </span>
            )}
            {fv && (
              <span title={fv.t} style={{ flex: "none", color: fv.c }}>{fv.l}</span>
            )}
            {s.goal && (
              // Active goals pulse; a blocked one is the row that wants you.
              <span
                title={`goal (${s.goal.state}): ${s.goal.objective}`}
                style={{ flex: "none", fontSize: "var(--t9)",
                         color: s.goal.state === "blocked" ? "var(--warn)"
                              : s.goal.state === "active" ? "var(--acc)" : "var(--txf)",
                         animation: s.goal.state === "active" ? "mpulse 2.4s infinite" : "none" }}
              >◎</span>
            )}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 16 }}>
        <button
          onClick={(e) => { e.stopPropagation(); onPin(); }}
          title={pinned ? "unpin — stops holding the top of the list" : "pin to the top of the list"}
          style={{ appearance: "none", cursor: "pointer", flex: "none", width: 11, border: 0, background: "transparent",
                   padding: 0, fontFamily: "inherit", fontSize: "var(--t10)", lineHeight: 1, textAlign: "center",
                   color: pinned ? "var(--warn)" : "var(--txl)", opacity: pinned || hov ? 1 : 0.45,
                   transition: "opacity .15s ease" }}
        >{pinned ? "★" : "☆"}</button>
        <span style={{ flex: "none", width: 26, textAlign: "right", fontSize: "var(--t95)",
                       color: pulse ? "var(--ok)" : "var(--txl)" }}>{ago(s.updated)}</span>
      </div>
    </div>
  );
}

/** One virtualised entry in a lane list: a lane header, a session row, or the
 *  idle lane's fold toggle. */
type LaneItem =
  | { k: "head"; label: string; tint: string; count: number; pulse: boolean; first: boolean }
  | { k: "row"; s: SessionBrief }
  | { k: "fold"; label: string };

export function SessionsPanel(props: Props) {
  const {
    sessions, groups, status, done, flags, pins, selectedSessionId, activeProject, booting,
    onTogglePin, onSelectSession, onNewSession, onWorktreeSession,
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
  const [nsScoped, setNsScoped] = useState(false); // opened from a project header — project is fixed
  const [projQ, setProjQ] = useState("");
  const [projAll, setProjAll] = useState(false);
  const [branchQ, setBranchQ] = useState("");

  // Browser state — mode + project order remembered across reloads.
  const [mode, setMode] = useState<Mode>(() => loadPrefs().mode);
  const [order, setOrder] = useState<OrderMode>(() => loadPrefs().order);
  const [customOrder, setCustomOrder] = useState<string[]>(() => loadPrefs().custom);
  const [orderMenu, setOrderMenu] = useState(false);
  // Native HTML5 drag state for CUSTOM order.
  const [dragRel, setDragRel] = useState<string | null>(null);
  const [overRel, setOverRel] = useState<string | null>(null);
  // Row density — remembered, because it tracks the screen you use, not the task.
  const [compact, setCompact] = useStickyFlag("hud-sessions-compact");
  // How much provenance each row prints. Remembered, because it tracks the
  // machine you work on — one repo on one branch wants less than fifteen.
  const [detailPref, setDetail] = useStickyStr("hud-sessions-detail", "notable");
  const detail = (DETAILS.includes(detailPref as Detail) ? detailPref : "notable") as Detail;
  const [detailMenu, setDetailMenu] = useState(false);
  // ATTENTION's idle lane is the long tail — folded to four rows until asked.
  const [folded, setFolded] = useState(true);
  // Projects you collapsed with the header. ponytail: not persisted — a collapse
  // is a "get this out of my way right now", not a preference.
  const [shut, setShut] = useState<Set<string>>(new Set());
  // Projects expanded past their two default rows.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sessionQ, setSessionQ] = useState("");
  // One hover key for every small control — the rows manage their own.
  const [hov, setHov] = useState("");
  const [chipHov, setChipHov] = useState("");
  const [closeHov, setCloseHov] = useState(false);
  const [startHov, setStartHov] = useState(false);
  const [cancelHov, setCancelHov] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ mode, order, custom: customOrder })); }
    catch { /* ignore */ }
  }, [mode, order, customOrder]);

  // "/" jumps to the search box — the hint badge in it promises this.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t?.tagName ?? "")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Branches power the WORKTREE chips + parent cycle — load per selected project
  // while the form is open (same endpoint the old inline picker used).
  useEffect(() => {
    if (!nsOpen || !nsProject) return;
    let live = true;
    void api.branches(nsProject).then((b) => {
      if (!live) return;
      const cur = b.current || b.branches[0] || "main";
      // Default to the branch of the session you're in when it's this project —
      // new work continues where you are, not wherever the main checkout sits.
      const mine = sessions.find((s) => s.id === selectedSessionId);
      const pick = mine?.project === nsProject && mine.branch && b.branches.includes(mine.branch)
        ? mine.branch : cur;
      setBranches(b.branches);
      setCurrent(cur);
      setNsBranch(pick);
      setNsParent(pick);
    }).catch(() => {});
    return () => { live = false; };
  }, [nsOpen, nsProject]);

  const branchOf = new Map(groups.map((g) => [g.rel, g.badge?.branch]));
  // One resolution of "which branch is this session on", so the row label and
  // the search box can never disagree about it.
  const branchFor = (s: SessionBrief) => s.branch || branchOf.get(s.project) || "main";

  const sq = sessionQ.trim().toLowerCase();
  // Pinned first, then newest-first. Every list below slices this one, so a pin
  // holds the top of its lane, its bucket, and its project's rows alike — and
  // the search applied here reaches every mode from one place.
  const sorted = [...sessions]
    .filter((s) => !sq || `${s.title ?? ""} ${branchFor(s)}`.toLowerCase().includes(sq))
    .sort((a, b) =>
      Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.updated - a.updated);

  // One state resolution per session per render — lanes, dots and counts all
  // read this map so they can never disagree.
  const views = new Map(sorted.map((s) => [s.id, resolve(status.get(s.id), done.has(s.id), flags.get(s.id))]));
  const laneOf = (s: SessionBrief) => views.get(s.id)?.lane ?? "idle";

  // ATTENTION: the four lanes. Idle is the long tail, so it folds to four rows
  // and nothing else is capped. Searching drops the fold — a search is already
  // the filter.
  type Lane = { label: string; tint: string; count: number; pulse: boolean; rows: SessionBrief[]; fold: string };
  let lanes: Lane[] = [];
  if (mode === "attention") {
    lanes = LANES.flatMap((d) => {
      const all = sorted.filter((s) => laneOf(s) === d.k);
      if (!all.length) return [];
      const folds = d.k === "idle" && !sq && all.length > 4;
      return [{
        label: d.label, tint: d.tint, count: all.length, pulse: d.k === "work",
        rows: folds && folded ? all.slice(0, 4) : all,
        fold: folds ? (folded ? `${all.length - 4} more idle ↓` : "show less ↑") : "",
      }];
    });
  } else if (mode === "recent") {
    // RECENT is one flat stream, cut into time buckets — no project grouping.
    const now = Date.now() / 1000;
    const cuts: [number, string][] = [[86400, "TODAY"], [7 * 86400, "THIS WEEK"], [Infinity, "EARLIER"]];
    lanes = cuts.flatMap(([max, label], i) => {
      const min = i === 0 ? -1 : cuts[i - 1][0];
      const age = (s: SessionBrief) => now - s.updated;
      const rows = sorted.filter((s) => age(s) > min && age(s) <= max);
      return rows.length ? [{ label, tint: "var(--txd)", count: rows.length, pulse: false, rows, fold: "" }] : [];
    });
  }

  // The lane modes flatten to one virtualised list — ATTENTION and RECENT both
  // carry the full session list, which is the one list long enough to be worth
  // the code. PROJECTS shows two rows per project and renders plain.
  const laneItems: LaneItem[] = [];
  if (mode !== "projects") {
    lanes.forEach((l, i) => {
      laneItems.push({ k: "head", label: l.label, tint: l.tint, count: l.count, pulse: l.pulse, first: i === 0 });
      for (const s of l.rows) laneItems.push({ k: "row", s });
      if (l.fold) laneItems.push({ k: "fold", label: l.fold });
    });
  }

  // PROJECTS: the tree. Order is a cycle — most-recently-used, name, size.
  const byLastUsed = [...groups].sort((a, b) => (b.sessions[0]?.updated ?? 0) - (a.sessions[0]?.updated ?? 0));
  // CUSTOM: dragged positions first (sort is stable, so anything you never
  // dragged keeps its last-used order behind them).
  const rank = (rel: string) => { const i = customOrder.indexOf(rel); return i < 0 ? Infinity : i; };
  const ps =
    order === "alpha" ? [...groups].sort((a, b) => a.name.localeCompare(b.name))
      : order === "biggest" ? [...groups].sort((a, b) => b.sessionCount - a.sessionCount)
        : order === "custom" ? [...byLastUsed].sort((a, b) => rank(a.rel) - rank(b.rel))
          : byLastUsed;
  const tree = mode !== "projects" ? [] : ps.flatMap((g) => {
    const f = sorted.filter((s) => s.project === g.rel);
    if (sq && f.length === 0) return [];
    const isShut = shut.has(g.rel) && !sq;
    const vis = isShut ? [] : sq || open.has(g.rel) ? f : f.slice(0, 2);
    const rest = Math.max(0, g.sessionCount - vis.length);
    return [{ g, f, isShut, vis, rest }];
  });

  const rowFor = (s: SessionBrief, showDot: boolean, showProj: boolean) => (
    <SessionRow
      key={s.id} s={s} showDot={showDot} showProj={showProj} detail={detail} compact={compact}
      on={s.id === selectedSessionId}
      v={views.get(s.id) ?? SV.idle} flag={flags.get(s.id)}
      pulse={(status.get(s.id)?.state ?? "idle") === "working"}
      branch={branchFor(s)}
      pinned={pins.has(s.id)} onPin={() => onTogglePin(s.id)}
      onAttach={() => onSelectSession(s)}
    />
  );

  // Virtualize the lane list against the shared .mscroll scroller.
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const rowV = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: laneItems.length,
    getScrollElement: () => scrollRef.current,
    // Compact drops the metadata line, so the estimate has to follow or the
    // scrollbar promises a list twice as long as the one that renders.
    estimateSize: (i) => {
      const it = laneItems[i];
      return it.k === "head" ? (it.first ? 24 : 40) : it.k === "fold" ? 30 : compact ? 27 : 50;
    },
    overscan: 8,
    scrollMargin,
  });
  // The new-session form sits above the list inside the scroller, so the list's
  // start offset shifts when it opens/closes — re-measure and feed it back.
  useLayoutEffect(() => {
    const sc = scrollRef.current, li = listRef.current;
    if (!sc || !li) return;
    const m = li.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    setScrollMargin((prev) => (Math.abs(prev - m) > 0.5 ? m : prev));
  });

  function resetForm() {
    setBranches([]); setCurrent(""); setNsBranch(""); setNsParent("");
    setNsNewOpen(false); setNsNewBranch(""); setBranchQ("");
  }

  function toggleForm() {
    if (nsOpen && !nsScoped) { setNsOpen(false); return; }
    setNsProject((p) => p ?? activeProject ?? groups[0]?.rel ?? null);
    resetForm(); setNsScoped(false); setProjQ(""); setProjAll(false); setNsOpen(true);
  }

  /** New session for one project — same form, project locked to it, opened
   *  inline under that project's header. */
  function openFor(rel: string) {
    if (nsOpen && nsScoped && nsProject === rel) { setNsOpen(false); return; }
    setNsProject(rel); setNsScoped(true); setNsOpen(true); resetForm();
  }

  /** Drop `dragRel` into `target`'s slot, materialising the visible order as the
   *  custom one on first drag. */
  function dropOn(target: string) {
    if (dragRel && dragRel !== target) {
      const next = tree.map(({ g }) => g.rel).filter((r) => r !== dragRel);
      const at = next.indexOf(target);
      next.splice(at < 0 ? next.length : at, 0, dragRel);
      setCustomOrder(next);
    }
    setDragRel(null); setOverRel(null);
  }

  function start() {
    if (!nsProject) return;
    const nb = nsNewOpen ? nsNewBranch.trim().replace(/\s+/g, "-") : "";
    // Same routing as the old per-project picker: new branch → create worktree,
    // other existing branch → attach worktree, current branch → plain session.
    if (nb) onWorktreeSession(nsProject, nb, true, nsParent || undefined);
    else if (nsBranch && current && nsBranch !== current) onWorktreeSession(nsProject, nsBranch, false);
    else onNewSession(nsProject);
    setNsOpen(false); setNsNewOpen(false); setNsNewBranch("");
  }

  function cycleParent() {
    const i = Math.max(0, branches.indexOf(nsParent));
    setNsParent(branches[(i + 1) % Math.max(1, branches.length)] || nsParent);
  }

  // Form pickers: searchable, and long lists stay collapsed until asked for.
  const q = projQ.trim().toLowerCase();
  // Selected project first, so it never hides behind SHOW ALL (sort is stable —
  // everything else keeps its order).
  const projList = (q ? groups.filter((g) => `${g.name} ${g.rel}`.toLowerCase().includes(q)) : groups)
    .slice().sort((a, b) => Number(b.rel === nsProject) - Number(a.rel === nsProject));
  const projShown = projAll ? projList : projList.slice(0, PROJ_CAP);
  const projHidden = projList.length - projShown.length;
  const bq = branchQ.trim().toLowerCase();
  const branchList = bq ? branches.filter((b) => b.toLowerCase().includes(bq)) : branches;

  // The form renders under whatever opened it: the NEW SESSION button (pinned
  // above the scroller) or a project header's + NEW.
  const nsForm = (
    <div style={{ border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)", background: "linear-gradient(160deg,color-mix(in srgb, var(--purple) 7%, transparent),color-mix(in srgb, var(--panel) 40%, transparent))", padding: 12, marginBottom: 11, animation: "mslide .22s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 11 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--purple)", flex: "none" }} />
        <span style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--purple-h)" }}>NEW SESSION</span>
        {nsScoped && (
          <span style={{ fontSize: "var(--t95)", color: "var(--txm)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            · {groups.find((g) => g.rel === nsProject)?.name ?? nsProject}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setNsOpen(false)} title="close"
          onMouseEnter={() => setCloseHov(true)} onMouseLeave={() => setCloseHov(false)}
          aria-label="close"
          style={{ appearance: "none", cursor: "pointer", flex: "none", width: 24, height: 24, padding: 0, borderRadius: 7,
                   display: "grid", placeItems: "center", border: 0,
                   background: closeHov ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent",
                   color: closeHov ? "var(--purple-b)" : "var(--purple-g)", transition: "background .15s ease, color .15s ease" }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {!nsScoped && (<>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <span style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>PROJECT</span>
        <input
          value={projQ} onChange={(e) => setProjQ(e.target.value)} placeholder="search projects…"
          style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", padding: "4px 7px" }}
        />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {projShown.map((g) => {
          const on = g.rel === nsProject;
          const h = chipHov === `p:${g.rel}`;
          const tint = projectTint(g.rel);
          return (
            <button
              key={g.rel} onClick={() => setNsProject(g.rel)}
              onMouseEnter={() => setChipHov(`p:${g.rel}`)} onMouseLeave={() => setChipHov("")}
              style={{
                appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                border: `1px solid ${on || h ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`,
                background: on ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "color-mix(in srgb, var(--panel2) 40%, transparent)",
                color: on ? "var(--txb)" : "var(--txm)",
                fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", padding: "4px 8px", minWidth: 0, maxWidth: "100%",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: tint.color, flex: "none" }} />
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
            </button>
          );
        })}
        {projHidden > 0 && (
          <button
            onClick={() => setProjAll(true)}
            style={{ appearance: "none", cursor: "pointer", border: "1px dashed color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 0.5, padding: "4px 8px" }}
          >SHOW ALL · {projHidden} MORE</button>
        )}
        {projAll && projList.length > PROJ_CAP && (
          <button
            onClick={() => setProjAll(false)}
            style={{ appearance: "none", cursor: "pointer", border: "1px dashed color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 0.5, padding: "4px 8px" }}
          >COLLAPSE</button>
        )}
        {projList.length === 0 && (
          <span style={{ fontSize: "var(--t95)", color: "var(--txl)", padding: "4px 2px" }}>no project matches “{projQ}”</span>
        )}
      </div>
      </>)}
      <div style={{ display: "flex", alignItems: "center", gap: 7, margin: "12px 0 6px" }}>
        <span style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>WORKTREE</span>
        {branches.length > 5 && (
          <input
            value={branchQ} onChange={(e) => setBranchQ(e.target.value)} placeholder="search branches…"
            style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--purple) 25%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", padding: "4px 7px" }}
          />
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {branchList.map((b) => {
          const on = !nsNewOpen && b === nsBranch;
          const h = chipHov === `b:${b}`;
          return (
            <button
              key={b} onClick={() => { setNsBranch(b); setNsNewOpen(false); }}
              onMouseEnter={() => setChipHov(`b:${b}`)} onMouseLeave={() => setChipHov("")}
              style={{
                appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                border: `1px solid ${on || h ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`,
                background: on ? "color-mix(in srgb, var(--purple) 16%, transparent)" : "color-mix(in srgb, var(--purple) 6%, transparent)",
                color: on ? "var(--purple-b)" : "var(--purple-h)",
                fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", padding: "5px 8px", maxWidth: "100%", minWidth: 0,
              }}
            >
              <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b}</span>
            </button>
          );
        })}
        <button
          onClick={() => setNsNewOpen((o) => !o)} title="create a new worktree branch"
          style={{ appearance: "none", cursor: "pointer", border: `1px solid ${nsNewOpen ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`, background: nsNewOpen ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent", color: "var(--purple-h)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 0.5, padding: "5px 9px" }}
        >+ NEW WORKTREE</button>
      </div>
      {nsNewOpen && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: "var(--t8)", letterSpacing: 1, color: "var(--purple-g)", flex: "none" }}>FROM</span>
            <button
              onClick={cycleParent} title="parent branch — click to cycle"
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)", background: "color-mix(in srgb, var(--purple) 6%, transparent)", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t9)", padding: "3px 7px", minWidth: 0 }}
            >
              <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>{nsParent || "main"}</span>
              <span style={{ color: "var(--purple-g)", flex: "none" }}>⟳</span>
            </button>
          </div>
          <input
            value={nsNewBranch} onChange={(e) => setNsNewBranch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && nsNewBranch.trim()) start(); }}
            placeholder="new-worktree-branch"
            style={{ width: "100%", boxSizing: "border-box", marginTop: 7, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", padding: "7px 9px" }}
          />
        </>
      )}
      <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
        <button
          onClick={start}
          onMouseEnter={() => setStartHov(true)} onMouseLeave={() => setStartHov(false)}
          style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--purple)", background: startHov ? "color-mix(in srgb, var(--purple) 26%, transparent)" : "color-mix(in srgb, var(--purple) 16%, transparent)", color: "var(--purple-b)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: 9, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
        ><span style={{ color: "var(--purple)" }}>▸</span>START SESSION</button>
        <button
          onClick={() => setNsOpen(false)}
          onMouseEnter={() => setCancelHov(true)} onMouseLeave={() => setCancelHov(false)}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: cancelHov ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: "9px 12px" }}
        >CANCEL</button>
      </div>
    </div>
  );

  const modeTabs: { id: Mode; label: string; count: number; tip: string }[] = [
    { id: "attention", label: "Attention", count: sorted.filter((s) => laneOf(s) !== "idle").length, tip: "Grouped by what each session wants from you" },
    { id: "projects", label: "Projects", count: groups.length, tip: "Grouped by project" },
    { id: "recent", label: "Recent", count: sorted.length, tip: "One flat stream, newest first" },
  ];

  const laneHead = (it: Extract<LaneItem, { k: "head" }>) => (
    <div style={{ display: "flex", alignItems: "center", gap: 9, height: 24, padding: "0 6px", marginTop: it.first ? 0 : 16 }}>
      <span className="sessdot" data-work={it.pulse}
            style={{ flex: "none", width: 6, height: 6, borderRadius: "50%", background: it.tint }} />
      <span style={{ flex: "none", fontSize: "var(--t9)", letterSpacing: ".22em", color: it.tint }}>{it.label}</span>
      <span style={{ flex: 1, minWidth: 8, height: 1, background: "color-mix(in srgb, var(--acc) 7%, transparent)" }} />
      <span style={{ flex: "none", fontSize: "var(--t9)", color: "var(--txl)" }}>{it.count}</span>
    </div>
  );

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", animation: "enterLeft .55s cubic-bezier(.2,.8,.2,1) both .12s", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: "none", display: "flex", flexDirection: "column", padding: "14px 16px 0" }}>
        <div style={{ display: "flex", alignItems: "stretch", gap: 2, padding: 2, borderRadius: 4, background: "color-mix(in srgb, var(--acc) 4%, transparent)" }}>
          {modeTabs.map((m) => {
            const on = mode === m.id;
            return (
              <button
                key={m.id} onClick={() => setMode(m.id)} title={m.tip}
                style={{ flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                         height: 27, border: 0, borderRadius: 3, padding: 0, margin: 0,
                         background: on ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent",
                         cursor: "pointer", fontFamily: "inherit", transition: "background .15s ease" }}
              >
                <span style={{ flex: "none", fontSize: "var(--t95)", letterSpacing: ".14em", textTransform: "uppercase",
                               color: on ? "var(--txb)" : "var(--txf)", transition: "color .15s ease" }}>{m.label}</span>
                <span style={{ flex: "none", fontSize: "var(--t9)", color: on ? "var(--acc)" : "var(--txl)" }}>{m.count}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 38, marginTop: 11, position: "relative",
                      borderBottom: "1px solid color-mix(in srgb, var(--acc) 9%, transparent)" }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flex: "none" }} aria-hidden="true">
            <circle cx="5" cy="5" r="3.6" stroke="var(--txl)" strokeWidth="1.3" />
            <line x1="7.8" y1="7.8" x2="11" y2="11" stroke="var(--txl)" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            value={sessionQ} onChange={(e) => setSessionQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setSessionQ(""); e.currentTarget.blur(); } }}
            placeholder="Search title or branch"
            style={{ flex: 1, minWidth: 0, height: "100%", border: 0, outline: "none", background: "transparent", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", color: "var(--txb)" }}
          />
          <span title="Press / to jump here" style={{ flex: "none", fontSize: "var(--t9)", color: "var(--txl)" }}>/</span>
          <span style={{ flex: "none", width: 1, height: 14, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />
          <button
            onClick={() => setCompact(!compact)}
            title={compact ? "comfortable rows" : "compact rows — titles only"}
            onMouseEnter={() => setHov("density")} onMouseLeave={() => setHov("")}
            style={{ flex: "none", display: "flex", alignItems: "center", border: 0, background: "transparent", padding: 3, margin: 0, cursor: "pointer",
                     color: hov === "density" ? "var(--acc)" : compact ? "var(--acc)" : "var(--txl)" }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="0" y="1" width="12" height="1.3" fill="currentColor" /><rect x="0" y="5.4" width="12" height="1.3" fill="currentColor" /><rect x="0" y="9.8" width="12" height="1.3" fill="currentColor" />
            </svg>
          </button>
          <button
            onClick={() => setDetailMenu((o) => !o)}
            title={`Row details — ${DETAIL_LABEL[detail]}`}
            aria-expanded={detailMenu}
            onMouseEnter={() => setHov("detail")} onMouseLeave={() => setHov("")}
            style={{ flex: "none", border: 0, background: "transparent", padding: "0 2px", margin: 0, cursor: "pointer", fontFamily: "inherit",
                     fontSize: "var(--t12)", lineHeight: 1,
                     color: detailMenu || hov === "detail" ? "var(--acc)" : detail === "none" ? "var(--txl)" : "var(--acc)" }}
          >⎇</button>
          {detailMenu && (
            <>
              <div onClick={() => setDetailMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
              <div style={{ position: "absolute", top: "calc(100% - 2px)", right: 0, zIndex: 97, minWidth: 168,
                            border: "1px solid color-mix(in srgb, var(--acc) 28%, transparent)", background: "var(--panel)",
                            boxShadow: "0 8px 22px var(--shadow-pop)", padding: 3, animation: "mslide .16s ease both" }}>
                <div style={{ padding: "5px 8px 4px", fontSize: "var(--t8)", letterSpacing: ".18em", color: "var(--txl)" }}>ROW DETAILS</div>
                {DETAILS.map((d) => (
                  <button
                    key={d} onClick={() => { setDetail(d); setDetailMenu(false); }}
                    title={DETAIL_TIP[d]}
                    onMouseEnter={() => setHov(`det:${d}`)} onMouseLeave={() => setHov("")}
                    style={{ width: "100%", appearance: "none", cursor: "pointer", textAlign: "left", border: 0,
                             background: detail === d ? "color-mix(in srgb, var(--acc) 14%, transparent)"
                               : hov === `det:${d}` ? "color-mix(in srgb, var(--acc) 7%, transparent)" : "transparent",
                             color: detail === d ? "var(--txb)" : "var(--txd)", fontFamily: "inherit",
                             fontSize: "var(--t9)", letterSpacing: ".1em", textTransform: "uppercase", padding: "6px 8px" }}
                  >{detail === d ? "▸ " : "\u00a0\u00a0 "}{DETAIL_LABEL[d]}</button>
                ))}
              </div>
            </>
          )}
        </div>

        {mode !== "projects" && (
          <button
            onClick={toggleForm} title="start a session — current worktree or a new one"
            onMouseEnter={() => setHov("new")} onMouseLeave={() => setHov("")}
            style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", height: 34, marginTop: 11, padding: "0 10px",
                     border: 0, borderRadius: 3,
                     background: `color-mix(in srgb, var(--acc) ${hov === "new" || nsOpen ? 11 : 5.5}%, transparent)`,
                     color: "var(--acc)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: ".18em", textTransform: "uppercase",
                     cursor: "pointer", transition: "background .15s ease" }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: "none" }}>
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            New session
          </button>
        )}
      </div>

      <div ref={scrollRef} className="mscroll" style={{ flex: 1, minHeight: 0, padding: "16px 10px 26px" }}>
        {nsOpen && !nsScoped && nsForm}

        {mode !== "projects" ? (
          <div ref={listRef} style={{ position: "relative", height: rowV.getTotalSize() }}>
            {rowV.getVirtualItems().map((vi) => {
              const it = laneItems[vi.index];
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={rowV.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start - scrollMargin}px)` }}
                >
                  {it.k === "head" ? laneHead(it)
                    : it.k === "row" ? rowFor(it.s, false, true)
                    : (
                      <button
                        onClick={() => setFolded((v) => !v)}
                        onMouseEnter={() => setHov("fold")} onMouseLeave={() => setHov("")}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 8px 7px 14px", border: 0,
                                 background: "transparent", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: ".1em",
                                 color: hov === "fold" ? "var(--acc)" : "var(--txl)", cursor: "pointer" }}
                      >{it.label}</button>
                    )}
                </div>
              );
            })}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, height: 24, padding: "0 6px", marginBottom: 4, position: "relative" }}>
              <span style={{ flex: "none", fontSize: "var(--t9)", letterSpacing: ".24em", color: "var(--txl)" }}>{sq ? "MATCHES" : "PROJECTS"}</span>
              <span style={{ flex: 1, minWidth: 8, height: 1, background: "color-mix(in srgb, var(--acc) 7%, transparent)" }} />
              <button
                onClick={() => setOrderMenu((o) => !o)}
                title="Project order"
                onMouseEnter={() => setHov("order")} onMouseLeave={() => setHov("")}
                style={{ flex: "none", border: 0, background: "transparent", padding: 0, margin: 0, cursor: "pointer", fontFamily: "inherit",
                         fontSize: "var(--t9)", letterSpacing: ".14em", textTransform: "uppercase",
                         color: orderMenu || hov === "order" ? "var(--acc)" : "var(--txf)" }}
              >{ORDER_LABEL[order]} ⇅</button>
              {orderMenu && (
                <>
                  <div onClick={() => setOrderMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
                  <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 97, minWidth: 140,
                                border: "1px solid color-mix(in srgb, var(--acc) 28%, transparent)", background: "var(--panel)",
                                boxShadow: "0 8px 22px var(--shadow-pop)", padding: 3, animation: "mslide .16s ease both" }}>
                    {ORDERS.map((m) => (
                      <button
                        key={m} onClick={() => { setOrder(m); setOrderMenu(false); }}
                        onMouseEnter={() => setHov(`ord:${m}`)} onMouseLeave={() => setHov("")}
                        style={{ width: "100%", appearance: "none", cursor: "pointer", textAlign: "left", border: 0,
                                 background: order === m ? "color-mix(in srgb, var(--acc) 14%, transparent)"
                                   : hov === `ord:${m}` ? "color-mix(in srgb, var(--acc) 7%, transparent)" : "transparent",
                                 color: order === m ? "var(--txb)" : "var(--txd)", fontFamily: "inherit",
                                 fontSize: "var(--t9)", letterSpacing: ".1em", textTransform: "uppercase", padding: "6px 8px" }}
                      >{order === m ? "▸ " : "\u00a0\u00a0 "}{ORDER_LABEL[m]}</button>
                    ))}
                    {order === "custom" && (
                      <div style={{ padding: "5px 8px 4px", fontSize: "var(--t85)", color: "var(--txf)", letterSpacing: ".04em" }}>
                        drag a project header to reorder
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            {tree.map(({ g, f, isShut, vis, rest }) => {
              const tint = projectTint(g.rel);
              return (
                <div
                  key={g.rel}
                  onDragOver={dragRel ? (e) => { e.preventDefault(); setOverRel(g.rel); } : undefined}
                  onDrop={dragRel ? (e) => { e.preventDefault(); dropOn(g.rel); } : undefined}
                  style={{ marginBottom: isShut ? 4 : 13, opacity: dragRel === g.rel ? 0.4 : 1,
                           borderTop: `2px solid ${dragRel && overRel === g.rel && dragRel !== g.rel ? "var(--acc)" : "transparent"}` }}
                >
                  <div
                    draggable={order === "custom" && !sq}
                    onDragStart={order === "custom" && !sq
                      ? (e) => { e.dataTransfer.effectAllowed = "move"; setDragRel(g.rel); } : undefined}
                    onDragEnd={order === "custom" ? () => { setDragRel(null); setOverRel(null); } : undefined}
                    onClick={() => setShut((c) => {
                      const n = new Set(c);
                      if (!n.delete(g.rel)) n.add(g.rel);
                      return n;
                    })}
                    title={order === "custom" && !sq
                      ? `${g.rel} — drag to reorder, click to ${isShut ? "expand" : "collapse"}`
                      : `${g.rel} · ${sq ? `${f.length} of ${g.sessionCount} match` : `${g.sessionCount} sessions`} — click to ${isShut ? "expand" : "collapse"}`}
                    style={{ display: "flex", alignItems: "center", gap: 9, height: 26, padding: "0 6px", userSelect: "none",
                             cursor: order === "custom" && !sq ? "grab" : "pointer" }}
                  >
                    <span style={{ flex: "none", width: 6, height: 6, background: tint.color }} />
                    <span style={{ flex: "none", maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                   fontSize: "var(--t115)", letterSpacing: ".06em", color: isShut ? "var(--txd)" : "var(--txb)" }}>{g.name}</span>
                    <span style={{ flex: 1, minWidth: 6 }} />
                    <button
                      onClick={(e) => { e.stopPropagation(); openFor(g.rel); }}
                      title={`New session in ${g.rel}`}
                      draggable={false} onDragStart={(e) => e.preventDefault()}
                      onMouseEnter={() => setHov(`add:${g.rel}`)} onMouseLeave={() => setHov("")}
                      style={{ flex: "none", display: "flex", alignItems: "center", gap: 6, border: 0, background: "transparent",
                               padding: 0, margin: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)",
                               letterSpacing: ".14em", textTransform: "uppercase",
                               color: hov === `add:${g.rel}` || (nsOpen && nsScoped && nsProject === g.rel) ? "var(--acc)" : "var(--txl)",
                               transition: "color .15s ease" }}
                    >
                      <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: "none" }}>
                        <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                      New
                    </button>
                  </div>
                  {nsOpen && nsScoped && nsProject === g.rel && nsForm}
                  <div style={{ margin: "1px 0 0 3px", paddingLeft: 15, borderLeft: `1px solid color-mix(in srgb, ${tint.color} ${isShut ? 7 : 20}%, transparent)` }}>
                    {/* A search drops the per-project cap, so this can be every
                        session in the store — skip off-screen rows. */}
                    {vis.length > 0 && <div className="vskip-card">{vis.map((s) => rowFor(s, true, false))}</div>}
                    {!isShut && !sq && (rest > 0 || (open.has(g.rel) && f.length > 2)) && (
                      <button
                        onClick={() => setOpen((c) => {
                          const n = new Set(c);
                          if (!n.delete(g.rel)) n.add(g.rel);
                          return n;
                        })}
                        onMouseEnter={() => setHov(`more:${g.rel}`)} onMouseLeave={() => setHov("")}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 8px", border: 0, background: "transparent",
                                 fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: ".1em",
                                 color: hov === `more:${g.rel}` ? "var(--acc)" : "var(--txl)", cursor: "pointer" }}
                      >{open.has(g.rel) ? "show less ↑" : `${rest} more ↓`}</button>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {groups.length === 0 && (
          <div style={{ fontSize: "var(--t11)", color: "var(--txl)", padding: "10px 4px" }}>
            {booting ? "LOADING SESSIONS…" : "No projects with sessions yet."}
          </div>
        )}
        {groups.length > 0 && sq && sorted.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "72px 16px" }}>
            <div style={{ fontSize: "var(--t11)", color: "var(--txf)" }}>Nothing matches “{sessionQ.trim()}”</div>
            <button
              onClick={() => setSessionQ("")}
              style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", fontFamily: "inherit",
                       fontSize: "var(--t95)", letterSpacing: ".16em", textTransform: "uppercase", color: "var(--acc)" }}
            >Clear search</button>
          </div>
        )}
      </div>
    </div>
  );
}
