import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SessionBrief, SessionStatus } from "../../api";
import { api } from "../../api";
import { ago, projectTint } from "../../lib/surfaces";
import { useStickyFlag } from "../../lib/prefs";
import { Rows2, Rows4, Tag, TagX } from "lucide-react";
import type { ProjectGroup } from "./ProjectsPanel";

/** A prompt of yours that hasn't run yet, flagged on the session it belongs to:
 *  unsent text in the composer, a relevance check in flight, or a held card
 *  waiting on your answer. */
export type PromptFlag = "draft" | "checking" | "held";

const FLAG_VIEW: Record<PromptFlag, { c: string; l: string; t: string }> = {
  draft: { c: "var(--warn)", l: "DRAFT", t: "unsent prompt waiting in this session" },
  checking: { c: "var(--purple)", l: "CHECKING…", t: "checking this prompt fits this session" },
  held: { c: "var(--purple-b)", l: "HELD", t: "a prompt here needs your decision" },
};

interface Props {
  sessions: SessionBrief[]; // full list — the RECENT view + drill-down need more than the capped group slices
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
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string) => void;
}

type OrderMode = "recent" | "alpha" | "custom";

const PROJ_CAP = 10; // project chips shown before "SHOW ALL"

const ORDER_LABEL: Record<OrderMode, string> = {
  recent: "RECENTLY USED", alpha: "A → Z", custom: "CUSTOM",
};

// Which tab you were on, how BY PROJECT is ordered, and your hand-dragged order.
// (Pins live in lib/prefs' useSessionPins — the context menu toggles them too.)
// ponytail: localStorage = per-browser, like every other HUD pref (see lib/surfaces.ts).
const PREFS_KEY = "hud-sessions-prefs";
type Prefs = { tab: "recent" | "grouped"; order: OrderMode; custom: string[] };

function loadPrefs(): Prefs {
  try {
    const r = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") as Partial<Prefs>;
    return {
      tab: r.tab === "grouped" ? "grouped" : "recent",
      order: r.order === "alpha" || r.order === "custom" ? r.order : "recent",
      custom: Array.isArray(r.custom) ? r.custom : [],
    };
  } catch { return { tab: "recent", order: "recent", custom: [] }; }
}

const STATUS_VIEW: Record<string, { c: string; l: string }> = {
  working: { c: "var(--ok)", l: "WORK" },
  awaiting: { c: "var(--warn)", l: "WAIT" },
  asking: { c: "var(--acc)", l: "ASK" },
  checking: { c: "var(--purple)", l: "CHECK" },
  live: { c: "var(--info)", l: "LIVE" },
  idle: { c: "var(--txf)", l: "IDLE" },
  done: { c: "var(--acc)", l: "DONE" },
};

const BUSY_NOW = ["working", "awaiting", "asking", "checking"];

function statusView(s: SessionStatus | undefined, done = false) {
  // DONE (finished, unopened) outranks idle/live, but never a state it's in
  // *now* — working, awaiting you, asking you, or having a prompt checked
  // against it. ASK beats DONE for the same reason: it says what to do next.
  const state = s?.state ?? "idle";
  if (done && !BUSY_NOW.includes(state)) return STATUS_VIEW.done;
  return STATUS_VIEW[state] ?? STATUS_VIEW.idle;
}

function SessionRow({
  s, i, on, sv, flag, branch, pinned, showProj, showTags, compact, onPin, onAttach, onAnalyzeProj, animate = true,
}: {
  s: SessionBrief;
  i: number;
  on: boolean;
  sv: { c: string; l: string };
  flag?: PromptFlag;
  branch: string;
  pinned: boolean;
  showProj: boolean; // BY PROJECT rows sit under a header that already says it
  showTags: boolean; // tags turned off panel-wide
  compact: boolean;  // title + status dot only
  onPin: () => void;
  onAttach: () => void;
  onAnalyzeProj: () => void;
  animate?: boolean;
}) {
  const [hov, setHov] = useState(false);
  const [tagHov, setTagHov] = useState(false);
  const tint = projectTint(s.project);
  const idle = sv.l === "IDLE";
  const inWorktree = !!s.work_cwd;
  const fv = flag ? FLAG_VIEW[flag] : null;
  return (
    <div
      onClick={onAttach}
      className="sessrow" data-on={on}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      data-ctx-type="session" data-ctx-id={s.id} data-ctx-label={s.title || "session"}
      style={{
        display: "flex", gap: 11, padding: compact ? "5px 12px" : "9px 12px", marginBottom: 2, cursor: "pointer",
        borderRadius: 10, position: "relative",
        // Flat by default: a quiet row is just text. Only the open one — and the
        // one under the cursor — gets a card, so the list reads as a list.
        border: `1px solid ${on ? "color-mix(in srgb, var(--acc) 20%, transparent)" : "transparent"}`,
        borderLeft: "2px solid transparent", // the .sessrow bar paints this strip

        background: on ? "color-mix(in srgb, var(--acc) 7%, transparent)" : hov ? "color-mix(in srgb, var(--acc) 4%, transparent)" : "transparent",
        transition: "background .18s ease, border-color .18s ease",
        animation: animate ? "mfadeup .4s ease both" : "none",
        animationDelay: animate ? `${Math.min(i, 10) * 35}ms` : undefined,
      }}
    >
      {/* The status word is gone from the row, so the dot carries it: filled +
          glowing when the session is doing something, a hollow ring when idle,
          and pulsing (.sessdot) while it's actually working, so a turn in
          flight is distinguishable from one stopped waiting on you.
          Opening a session doesn't swap it for a spinner — the row you tapped
          shouldn't flicker to say something you already know. */}
      <span className="sessdot" data-work={sv.l === "WORK"} title={sv.l.toLowerCase()} style={{ width: 9, height: 9, borderRadius: "50%", flex: "none", marginTop: 5, boxSizing: "border-box", background: idle ? "transparent" : sv.c, border: idle ? `1.5px solid ${sv.c}` : 0, boxShadow: `0 0 8px ${idle ? "transparent" : sv.c}` }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--t12)", lineHeight: 1.35, color: on ? "var(--txb)" : "var(--txh)", fontWeight: on ? 600 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {s.title || "untitled session"}
        </div>
        {!compact && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5 }}>
          {showProj && (
            <button
              onClick={(e) => { e.stopPropagation(); onAnalyzeProj(); }} title="analyze project"
              onMouseEnter={() => setTagHov(true)} onMouseLeave={() => setTagHov(false)}
              style={{ appearance: "none", cursor: "pointer", flex: "none", fontSize: "var(--t85)", letterSpacing: 0.5, color: tint.color, border: `1px solid ${tint.border}`, borderRadius: 5, background: tagHov ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", fontFamily: "inherit", padding: "1px 6px" }}
            >{tint.tag}</button>
          )}
          {/* The branch is normally the checkout's, and reads as background. When
              the session's shell has moved into a worktree the branch is that
              one's — lit, so a row whose commits land somewhere other than the
              project checkout says so at a glance. */}
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--t10)", color: inWorktree ? "var(--acc)" : "var(--txd)", minWidth: 0 }}
                title={inWorktree ? `working in ${s.work_cwd}` : "branch"}>
            <span style={{ color: inWorktree ? "var(--acc)" : "var(--txf)", flex: "none" }}>⎇</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{branch}</span>
          </span>
          {showTags && (s.tags ?? []).slice(0, 2).map((t) => (
            <span
              key={t}
              title={`tag: ${t}`}
              style={{ flex: "none", fontSize: "var(--t85)", letterSpacing: 0.4,
                       color: "var(--txd)", border: "1px solid var(--txl)",
                       borderRadius: 5, padding: "0 5px", maxWidth: 60,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >{t}</span>
          ))}
          {s.goal && (
            // Active goals pulse; a blocked one is the row that wants you.
            <span
              title={`goal (${s.goal.state}): ${s.goal.objective}`}
              style={{ flex: "none", fontSize: "var(--t9)",
                       color: s.goal.state === "blocked" ? "var(--warn, #e8b339)"
                            : s.goal.state === "active" ? "var(--acc)" : "var(--txf)",
                       animation: s.goal.state === "active" ? "mpulse 2.4s infinite" : "none" }}
            >◎</span>
          )}
          <span style={{ flex: 1 }} />
          <button
            onClick={(e) => { e.stopPropagation(); onPin(); }}
            title={pinned ? "unpin — stops holding the top of the list" : "pin to the top of the list"}
            style={{
              appearance: "none", cursor: "pointer", flex: "none", border: 0, background: "transparent",
              color: pinned ? "var(--warn)" : "var(--txf)", fontFamily: "inherit", fontSize: "var(--t11)",
              lineHeight: 1, padding: "1px 3px", transition: "opacity .15s ease",
              // Dim until hovered, so a quiet row stays quiet — but a pin always shows.
              opacity: pinned ? 1 : hov ? 0.9 : 0.35,
            }}
          >{pinned ? "★" : "☆"}</button>
          {fv && (
            <span
              title={fv.t}
              style={{
                fontSize: "var(--t8)", letterSpacing: 0.8, color: fv.c, flex: "none", padding: "1px 5px",
                border: `1px solid color-mix(in srgb, ${fv.c} 45%, transparent)`,
                background: `color-mix(in srgb, ${fv.c} 10%, transparent)`,
                borderRadius: 5,
                animation: flag === "checking" ? "twinkle 1.1s ease-in-out infinite" : undefined,
              }}
            >{fv.l}</span>
          )}
          <span style={{ fontSize: "var(--t95)", color: "var(--txl)", flex: "none" }}>{ago(s.updated)}</span>
        </div>
        )}
      </div>
    </div>
  );
}

/** Dashed full-width row action under a project group — SHOW MORE, or START
 *  SESSION for a project with none yet. */
function DashedRow({ label, onClick, title }: { label: string; onClick: () => void; title?: string }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick} title={title}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        width: "100%", margin: "1px 0 9px", appearance: "none", cursor: "pointer",
        border: `1px dashed ${hov ? "color-mix(in srgb, var(--acc) 40%, transparent)" : "color-mix(in srgb, var(--acc) 22%, transparent)"}`,
        background: hov ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent",
        color: hov ? "var(--tx)" : "#7f9d97", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
        padding: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
      }}
    >{label}</button>
  );
}

/** Small square action on a project header — starts a session in that project. */
function PlusBtn({ on, onClick }: { on: boolean; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick} title={on ? "close" : "new session in this project"}
      aria-label={on ? "close new session form" : "new session in this project"}
      aria-expanded={on}
      // The project header is the drag handle in CUSTOM order — this button is
      // not, or reaching for "+" would drag the project instead.
      draggable={false} onDragStart={(e) => e.preventDefault()}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        appearance: "none", cursor: "pointer", flex: "none", width: 26, height: 26, padding: 0, borderRadius: 8,
        display: "grid", placeItems: "center",
        border: `1px solid ${on || hov ? "var(--purple)" : "color-mix(in srgb, var(--purple) 28%, transparent)"}`,
        background: on || hov ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent",
        color: on || hov ? "var(--purple-b)" : "var(--purple-h)",
        transition: "border-color .15s ease, background .15s ease, color .15s ease",
      }}
    >
      {/* ponytail: one glyph rotated 45° instead of swapping + for ✕ — nothing
          to re-align between the two states, and the turn reads as a toggle. */}
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"
           style={{ transform: on ? "rotate(45deg)" : "none", transition: "transform .18s ease" }}>
        <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export function SessionsPanel(props: Props) {
  const {
    sessions, groups, status, done, flags, pins, selectedSessionId, activeProject, booting,
    onTogglePin, onSelectSession, onAnalyze, onNewSession, onWorktreeSession,
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

  // Browser state — tab + project order remembered across reloads.
  const [tab, setTab] = useState<"recent" | "grouped">(() => loadPrefs().tab);
  const [order, setOrder] = useState<OrderMode>(() => loadPrefs().order);
  const [customOrder, setCustomOrder] = useState<string[]>(() => loadPrefs().custom);
  const [orderMenu, setOrderMenu] = useState(false);
  // Row density — remembered, because it tracks the screen you use, not the task.
  const [compact, setCompact] = useStickyFlag("hud-sessions-compact");
  const [dragRel, setDragRel] = useState<string | null>(null);
  const [overRel, setOverRel] = useState<string | null>(null);
  const [drill, setDrill] = useState<string | null>(null);
  // Projects you collapsed with the caret. ponytail: not persisted — a collapse
  // is a "get this out of my way right now", not a preference.
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sessionQ, setSessionQ] = useState("");
  // Tags off — rows and the filter strip both go. Stored inverted so the default
  // (nothing in localStorage) keeps tags on.
  const [noTags, setNoTags] = useStickyFlag("hud-sessions-notags");
  // Tag strip is capped at two rows — a tagged machine grows dozens of them and
  // they push the list off screen. Measured, so a short strip skips the toggle.
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagsOverflow, setTagsOverflow] = useState(false);
  const tagWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ tab, order, custom: customOrder })); }
    catch { /* ignore */ }
  }, [tab, order, customOrder]);

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

  const sessionTotal = groups.reduce((n, g) => n + g.sessionCount, 0);
  const branchOf = new Map(groups.map((g) => [g.rel, g.badge?.branch]));
  // One resolution of "which branch is this session on", so the row label and
  // the search box can never disagree about it.
  const branchFor = (s: SessionBrief) => s.branch || branchOf.get(s.project) || "main";
  // "N active" per project header — counted once over the whole list rather than
  // re-scanned per group.
  const activeBy = new Map<string, number>();
  for (const s of sessions) {
    if (BUSY_NOW.includes(status.get(s.id)?.state ?? "idle")) {
      activeBy.set(s.project, (activeBy.get(s.project) ?? 0) + 1);
    }
  }
  // Every tag in play, for the filter strip. Sorted so the strip doesn't reshuffle
  // itself as sessions come and go.
  // The active tag rides first so it stays visible in the collapsed one-row strip.
  const allTags = [...new Set(sessions.flatMap((s) => s.tags ?? []))]
    .sort((a, b) => Number(b === tagFilter) - Number(a === tagFilter) || a.localeCompare(b));
  const sq = sessionQ.trim().toLowerCase();
  // Pinned first, then newest-first. Every list below slices this one, so a pin
  // holds the top of the RECENT list and of its own project's rows alike — and the
  // tag filter + search applied here reach RECENT and BY PROJECT from one place.
  const sorted = [...sessions]
    .filter((s) => !tagFilter || (s.tags ?? []).includes(tagFilter))
    .filter((s) => !sq || `${s.title ?? ""} ${(s.tags ?? []).join(" ")} ${branchFor(s)}`.toLowerCase().includes(sq))
    .sort((a, b) =>
      Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.updated - a.updated);
  // BY PROJECT: most-recently-used project first. g.sessions is already
  // newest-first, so [0] is the project's last activity; no sessions → last.
  const byLastUsed = [...groups].sort((a, b) => (b.sessions[0]?.updated ?? 0) - (a.sessions[0]?.updated ?? 0));
  // CUSTOM: pinned positions first (sort is stable, so anything you never
  // dragged keeps its last-used order behind them).
  const rank = (rel: string) => { const i = customOrder.indexOf(rel); return i < 0 ? Infinity : i; };
  const orderedAll =
    order === "alpha" ? [...groups].sort((a, b) => a.name.localeCompare(b.name))
      : order === "custom" ? [...byLastUsed].sort((a, b) => rank(a.rel) - rank(b.rel))
        : byLastUsed;
  // Group headers come from `groups`, which the tag filter and search never
  // touched — so without this a filtered BY PROJECT shows headers with nothing
  // under them and reads as broken. `sorted` is already filtered, so ask it.
  const ordered = tagFilter || sq
    ? orderedAll.filter((g) => sorted.some((s) => s.project === g.rel))
    : orderedAll;
  // BY PROJECT rows: every session that's actually doing something (WORK/WAIT/
  // LIVE/DONE), holding a prompt of yours, pinned, or currently open — never
  // nothing, so a quiet project still shows its newest one. The open session
  // stays listed even when idle and draft-free: hiding the chat you're looking
  // at reads as "it's gone"; a pinned one likewise, or the pin did nothing.
  // ponytail: ignores g.sessions' cap on purpose; the rest hide behind SHOW MORE.
  // Filtering (search or tag) overrides all of it: you asked for these rows, so
  // every match shows, and nothing hides behind SHOW MORE.
  const rowsFor = (rel: string) => {
    const all = sorted.filter((s) => s.project === rel);
    if (sq || tagFilter) return all;
    const busy = all.filter((s) => s.id === selectedSessionId || pins.has(s.id)
      || statusView(status.get(s.id), done.has(s.id)).l !== "IDLE" || flags.has(s.id));
    return busy.length ? busy : all.slice(0, 1);
  };

  // Virtualize the uncapped RECENT list against the shared .mscroll scroller.
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const recentActive = !drill && tab === "recent";
  const rowV = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: recentActive ? sorted.length : 0,
    getScrollElement: () => scrollRef.current,
    // Compact drops the metadata line, so the estimate has to follow or the
    // scrollbar promises a list twice as long as the one that renders.
    estimateSize: () => (compact ? 30 : 62),
    overscan: 8,
    scrollMargin,
  });
  // The new-session form + tab header sit above the list inside the scroller, so the
  // list's start offset shifts when they open/close — re-measure and feed it back.
  useLayoutEffect(() => {
    const sc = scrollRef.current, li = listRef.current;
    if (!sc || !li) return;
    const m = li.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    setScrollMargin((prev) => (Math.abs(prev - m) > 0.5 ? m : prev));
  });

  // Does the tag strip spill past its two rows? Only measurable while collapsed —
  // expanded it never clips, so keep the last verdict and let LESS collapse it.
  useLayoutEffect(() => {
    const el = tagWrapRef.current;
    if (!el || tagsOpen) return;
    const over = el.scrollHeight > el.clientHeight + 1;
    setTagsOverflow((prev) => (prev === over ? prev : over));
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
      const next = ordered.map((g) => g.rel).filter((r) => r !== dragRel);
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

  const rowFor = (s: SessionBrief, i: number, animate = true, showProj = true) => (
    <SessionRow
      key={s.id} s={s} i={i} animate={animate} showProj={showProj} showTags={!noTags} compact={compact}
      on={s.id === selectedSessionId}
      sv={statusView(status.get(s.id), done.has(s.id))} flag={flags.get(s.id)}
      branch={branchFor(s)}
      pinned={pins.has(s.id)} onPin={() => onTogglePin(s.id)}
      onAttach={() => onSelectSession(s)}
      onAnalyzeProj={() => onAnalyze(s.project)}
    />
  );

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

  const drillGroup = drill ? groups.find((g) => g.rel === drill) : undefined;
  const drillSessions = drill ? sorted.filter((s) => s.project === drill) : [];
  const drillTint = projectTint(drill ?? "");

  // The form renders under whatever opened it: the RECENT tab's NEW SESSION
  // button (pinned above the scroller) or a project header's +.
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
          const hov = chipHov === `p:${g.rel}`;
          const tint = projectTint(g.rel);
          return (
            <button
              key={g.rel} onClick={() => setNsProject(g.rel)}
              onMouseEnter={() => setChipHov(`p:${g.rel}`)} onMouseLeave={() => setChipHov("")}
              style={{
                appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                border: `1px solid ${on || hov ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`,
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
          const hov = chipHov === `b:${b}`;
          return (
            <button
              key={b} onClick={() => { setNsBranch(b); setNsNewOpen(false); }}
              onMouseEnter={() => setChipHov(`b:${b}`)} onMouseLeave={() => setChipHov("")}
              style={{
                appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                border: `1px solid ${on || hov ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`,
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

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", animation: "enterLeft .55s cubic-bezier(.2,.8,.2,1) both .12s", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", flex: "none" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>SESSIONS</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "var(--t95)", letterSpacing: 1.5, color: "var(--acc)" }}>{groups.length} PROJ · {sessionTotal} SESS</span>
          {/* Compact drops each row to its dot and its title. On a phone that's
              the difference between four sessions on screen and nine. */}
          <button
            onClick={() => setCompact(!compact)}
            title={compact ? "show branch, tags and age on every row" : "compact rows — title only"}
            style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: compact ? "var(--acc)" : "var(--txf)", display: "flex", flex: "none", padding: 0 }}
          >
            {compact ? <Rows2 size={12} aria-hidden /> : <Rows4 size={12} aria-hidden />}
          </button>
          {/* Tags off hides them on the rows and drops the filter strip. Clearing
              the filter on the way out — an invisible filter reads as data loss. */}
          <button
            onClick={() => { setNoTags((v) => !v); setTagFilter(null); }}
            title={noTags ? "show tags on rows and the tag filter" : "hide tags"}
            style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: noTags ? "var(--txf)" : "var(--acc)", display: "flex", flex: "none", padding: 0 }}
          >
            {noTags ? <TagX size={12} aria-hidden /> : <Tag size={12} aria-hidden />}
          </button>
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),color-mix(in srgb, var(--acc) 5%, transparent))", transformOrigin: "left", animation: "drawline .7s ease both .16s", flex: "none" }} />

      {/* Tabs pinned above the scroller so NEW SESSION sits right under them —
          RECENT owns the catch-all button; BY PROJECT starts sessions from each
          project's own header instead. */}
      <div style={{ flex: "none", padding: "10px 10px 2px" }}>
        {!drill && (
        <div style={{ position: "relative", display: "flex", gap: 0, border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", borderRadius: 10, background: "color-mix(in srgb, var(--panel2) 30%, transparent)", padding: 3 }}>
          {/* One pill that slides, instead of two backgrounds cross-fading —
              the move reads the same in both directions. Halves are exactly
              50% (gap 0), so translateX(100%) lands on the other button. */}
          <span aria-hidden style={{ position: "absolute", top: 3, bottom: 3, left: 3, width: "calc(50% - 3px)", borderRadius: 8, border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", background: "color-mix(in srgb, var(--acc) 12%, transparent)", transform: `translateX(${tab === "recent" ? "0%" : "100%"})`, transition: "transform .22s cubic-bezier(.2,.8,.2,1)", pointerEvents: "none" }} />
          <button
            onClick={() => { setTab("recent"); setNsOpen(false); }}
            style={{ position: "relative", flex: 1, appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: tab === "recent" ? "var(--txb)" : "var(--txf)", fontFamily: "inherit", fontSize: "var(--t11)", letterSpacing: 2, padding: "6px 7px", transition: "color .22s cubic-bezier(.2,.8,.2,1)" }}
          >RECENT</button>
          <button
            onClick={() => { setTab("grouped"); setNsOpen(false); }}
            style={{ position: "relative", flex: 1, appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: tab === "grouped" ? "var(--txb)" : "var(--txf)", fontFamily: "inherit", fontSize: "var(--t11)", letterSpacing: 2, padding: "6px 7px", transition: "color .22s cubic-bezier(.2,.8,.2,1)" }}
          >BY PROJECT</button>
        </div>
        )}
        {/* Search over titles, tags + branch. Stays visible inside a project
            drill-down — the filter still applies there, so hiding the box reads
            as broken. */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 7, border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", borderRadius: 12, background: "color-mix(in srgb, var(--panel2) 45%, transparent)", padding: "0 11px" }}>
          <span style={{ fontSize: "var(--t13)", color: "var(--txf)", flex: "none" }}>⌕</span>
          <input
            ref={searchRef}
            value={sessionQ} onChange={(e) => setSessionQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setSessionQ(""); e.currentTarget.blur(); } }}
            placeholder="Search title, tag, or branch"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t12)", padding: "8px 0" }}
          />
          {sessionQ ? (
            <button
              onClick={() => setSessionQ("")} title="clear search"
              style={{ appearance: "none", cursor: "pointer", flex: "none", border: 0, background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t11)", lineHeight: 1, padding: "2px 1px" }}
            >✕</button>
          ) : (
            <span
              title="press / to search"
              style={{ flex: "none", fontSize: "var(--t10)", color: "var(--txf)", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", borderRadius: 6, padding: "1px 6px", lineHeight: 1.5 }}
            >/</span>
          )}
        </div>
        {/* Tag filter. Only appears once something is tagged, so an untagged
            machine never pays for a control it can't use. */}
        {!noTags && allTags.length > 0 && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 5, marginTop: 6 }}>
            {/* Expanded caps at ~4 rows and scrolls: 60+ tags otherwise push the
                session list off-screen, and MORE/LESS stays put at the top. */}
            <div
              ref={tagWrapRef}
              className={tagsOpen ? "mscroll" : undefined}
              style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: 5,
                       maxHeight: tagsOpen ? 92 : 24, overflow: tagsOpen ? undefined : "hidden" }}
            >
              {allTags.map((t) => {
                const on = tagFilter === t;
                return (
                  <button
                    key={t}
                    onClick={() => setTagFilter(on ? null : t)}
                    title={on ? `showing only ${t} — click to clear` : `show only ${t}`}
                    style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit",
                             fontSize: "var(--t10)", letterSpacing: 0.5, padding: "2px 10px", borderRadius: 999,
                             border: `1px solid color-mix(in srgb, var(--purple) ${on ? 60 : 25}%, transparent)`,
                             background: on ? "color-mix(in srgb, var(--purple) 18%, transparent)" : "transparent",
                             color: on ? "var(--purple-b)" : "var(--purple-d)",
                             transition: "all .15s ease" }}
                  >{t}</button>
                );
              })}
            </div>
            {(tagsOverflow || tagsOpen) && (
              <button
                onClick={() => setTagsOpen((o) => !o)}
                title={tagsOpen ? "collapse tags to one row" : "show all tags"}
                style={{ appearance: "none", cursor: "pointer", flex: "none", fontFamily: "inherit",
                         fontSize: "var(--t10)", letterSpacing: 1, padding: "4px 4px",
                         border: 0, background: "transparent", color: "var(--txd)" }}
              >{tagsOpen ? "LESS ▴" : "MORE ▾"}</button>
            )}
          </div>
        )}
        {!drill && tab === "recent" && (
          <button
            onClick={toggleForm} title="start a session — current worktree or a new one"
            onMouseEnter={() => setNsBtnHov(true)} onMouseLeave={() => setNsBtnHov(false)}
            style={{
              width: "100%", marginTop: 7, appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 11,
              border: `1px solid ${nsOpen ? "color-mix(in srgb, var(--purple) 50%, transparent)" : "color-mix(in srgb, var(--acc) 30%, transparent)"}`,
              background: nsOpen ? "color-mix(in srgb, var(--purple) 12%, transparent)" : "color-mix(in srgb, var(--acc) 6%, transparent)",
              color: nsOpen ? "var(--purple-b)" : "var(--tx)",
              fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 2, padding: "8px 10px",
              transition: "all .15s ease", filter: nsBtnHov ? "brightness(1.18)" : "none",
            }}
          ><span style={{ fontSize: "var(--t12)", lineHeight: 0 }}>+</span>NEW SESSION</button>
        )}
      </div>

      <div ref={scrollRef} className="mscroll" style={{ flex: 1, padding: "9px 9px 11px" }}>
        {nsOpen && !nsScoped && nsForm}

        {drill ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 2px 11px" }}>
              <button
                onClick={() => setDrill(null)} title="back to projects"
                onMouseEnter={() => setBackHov(true)} onMouseLeave={() => setBackHov(false)}
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: backHov ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--tx)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "5px 10px" }}
              ><span style={{ fontSize: "var(--t13)", lineHeight: 0 }}>←</span>BACK</button>
              <span style={{ fontSize: "var(--t85)", letterSpacing: 0.5, color: drillTint.color, border: `1px solid ${drillTint.border}`, padding: "1px 6px", flex: "none" }}>{drillTint.tag}</span>
              <span style={{ fontSize: "var(--t105)", color: "var(--txh)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{drillGroup?.name ?? drill}</span>
              <span style={{ fontSize: "var(--t85)", letterSpacing: 1, color: "var(--txf)", flex: "none" }}>{drillSessions.length} SESS</span>
              <PlusBtn on={nsOpen && nsScoped && nsProject === drill} onClick={() => openFor(drill)} />
            </div>
            {nsOpen && nsScoped && nsProject === drill && nsForm}
            {/* Drilling into a busy project lists every one of its sessions, so
                off-screen rows skip layout/paint. RECENT gets the virtualizer
                instead — it is the one list long enough to be worth the code. */}
            <div className="vskip-card">{drillSessions.map((s, i) => rowFor(s, i, true, false))}</div>
          </>
        ) : (
          // Keyed on the tab so the swap replays an enter animation instead of
          // hard-cutting — same duration and curve as the pill, and it enters
          // from the side the pill just slid toward.
          <div key={tab} style={{ animation: `${tab === "recent" ? "enterLeft" : "enterRight"} .22s cubic-bezier(.2,.8,.2,1) both` }}>
            {tab === "recent" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 7px" }}>
                  <span style={{ fontSize: "var(--t11)", letterSpacing: 2.5, color: "var(--txl)", flex: "none" }}>RECENT SESSIONS</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: "var(--t10)", letterSpacing: 0.5, color: "var(--txf)", flex: "none" }}>{pins.size ? "pinned · newest first" : "newest first"}</span>
                </div>
                <div ref={listRef} style={{ position: "relative", height: rowV.getTotalSize() }}>
                  {rowV.getVirtualItems().map((vi) => (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={rowV.measureElement}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start - scrollMargin}px)` }}
                    >
                      {rowFor(sorted[vi.index], vi.index, false)}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 7, margin: "0 2px 2px", position: "relative" }}>
                  <span style={{ fontSize: "var(--t10)", letterSpacing: 2.5, color: "var(--txl)", flex: "none" }}>PROJECTS</span>
                  <span
                    title="grouped by project — a project shows its busy, pinned and open sessions; the rest hide behind SHOW MORE"
                    style={{ flex: "none", cursor: "help", width: 13, height: 13, borderRadius: "50%", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", color: "var(--txf)", fontSize: "var(--t8)", display: "flex", alignItems: "center", justifyContent: "center" }}
                  >?</span>
                  <span style={{ flex: 1 }} />
                  <button
                    onClick={() => setOrderMenu((o) => !o)} title="project order"
                    style={{ appearance: "none", cursor: "pointer", flex: "none", display: "flex", alignItems: "center", gap: 5, borderRadius: 8, border: `1px solid ${orderMenu ? "var(--acc)" : "color-mix(in srgb, var(--acc) 20%, transparent)"}`, background: orderMenu ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: orderMenu ? "var(--txb)" : "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "4px 9px" }}
                  >⇅ {ORDER_LABEL[order]}</button>
                  {orderMenu && (
                    <>
                      <div onClick={() => setOrderMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
                      <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 97, minWidth: 132, border: "1px solid color-mix(in srgb, var(--acc) 28%, transparent)", borderRadius: 10, background: "var(--panel)", boxShadow: "0 8px 22px var(--shadow-pop)", padding: 3, animation: "mslide .16s ease both" }}>
                        {(["recent", "alpha", "custom"] as OrderMode[]).map((m) => (
                          <button
                            key={m} onClick={() => { setOrder(m); setOrderMenu(false); }}
                            style={{ width: "100%", appearance: "none", cursor: "pointer", textAlign: "left", border: 0, background: order === m ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent", color: order === m ? "var(--txb)" : "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "6px 8px" }}
                          >{order === m ? "▸ " : "  "}{ORDER_LABEL[m]}</button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                {ordered.map((g) => {
                  const tint = projectTint(g.rel);
                  const shown = rowsFor(g.rel);
                  // Filtered rows are already the whole match set, and g.sessionCount
                  // counts the unfiltered project — so there is nothing more to show.
                  const more = sq || tagFilter ? 0 : g.sessionCount - shown.length;
                  const hidden = shut.has(g.rel);
                  const dragging = dragRel === g.rel;
                  const dropHere = !!dragRel && overRel === g.rel && !dragging;
                  return (
                    <div
                      key={g.rel}
                      // ponytail: native HTML5 DnD, no library. Only the header is
                      // draggable, so a stray drag on a session row reorders nothing.
                      onDragOver={dragRel ? (e) => { e.preventDefault(); setOverRel(g.rel); } : undefined}
                      onDrop={dragRel ? (e) => { e.preventDefault(); dropOn(g.rel); } : undefined}
                      style={{ opacity: dragging ? 0.4 : 1, borderTop: `2px solid ${dropHere ? "var(--acc)" : "transparent"}` }}
                    >
                      {/* In CUSTOM order the whole header is the drag handle — no
                          grip to aim at. The + opts out (draggable={false}) so
                          starting a session never turns into a reorder. */}
                      <div
                        draggable={order === "custom"}
                        onDragStart={order === "custom" ? (e) => { e.dataTransfer.effectAllowed = "move"; setDragRel(g.rel); } : undefined}
                        onDragEnd={order === "custom" ? () => { setDragRel(null); setOverRel(null); } : undefined}
                        title={order === "custom" ? "drag to reorder — pinned projects stay on top" : undefined}
                        style={{ display: "flex", alignItems: "center", gap: 7, margin: "9px 2px 5px",
                                 cursor: order === "custom" ? "grab" : undefined,
                                 userSelect: order === "custom" ? "none" : undefined }}
                      >
                        <button
                          onClick={() => setShut((c) => {
                            const n = new Set(c);
                            if (!n.delete(g.rel)) n.add(g.rel);
                            return n;
                          })}
                          title={hidden ? "expand" : "collapse"}
                          style={{ appearance: "none", cursor: "pointer", flex: "none", border: 0, background: "transparent", color: "var(--txf)", fontFamily: "inherit", fontSize: "var(--t9)", lineHeight: 1, padding: "3px 2px" }}
                        >{hidden ? "▸" : "▾"}</button>
                        <span style={{ fontSize: "var(--t10)", letterSpacing: 0.5, color: tint.color, border: `1px solid ${tint.border}`, borderRadius: 6, padding: "2px 7px", flex: "none" }}>{tint.tag}</span>
                        <span style={{ fontSize: "var(--t125)", fontWeight: 600, color: "var(--txb)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
                        <span style={{ flex: 1 }} />
                        {(activeBy.get(g.rel) ?? 0) > 0 && (
                          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--t10)", color: "var(--ok)", flex: "none" }} title="sessions working, waiting on you, or being checked">
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)" }} />
                            {activeBy.get(g.rel)} active
                          </span>
                        )}
                        <PlusBtn on={nsOpen && nsScoped && nsProject === g.rel} onClick={() => openFor(g.rel)} />
                      </div>
                      {nsOpen && nsScoped && nsProject === g.rel && nsForm}
                      {/* A search or tag filter drops the per-project cap, so this
                          can be every session in the store — skip off-screen rows. */}
                      {!hidden && <div className="vskip-card">{shown.map((s, i) => rowFor(s, i, true, false))}</div>}
                      {!hidden && more > 0 && (
                        <button
                          onClick={() => setDrill(g.rel)}
                          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t115)", padding: "9px 12px 4px", margin: "0 0 4px" }}
                        >show {more} more ↓</button>
                      )}
                      {!hidden && g.sessionCount === 0 && (
                        <DashedRow label="+ START SESSION" title="start a session in this project"
                          onClick={() => openFor(g.rel)} />
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
        {groups.length === 0 && (
          <div style={{ fontSize: "var(--t11)", color: "var(--txl)", padding: "10px 4px" }}>
            {booting ? "LOADING SESSIONS…" : "No projects with sessions yet."}
          </div>
        )}
        {groups.length > 0 && (sq || tagFilter) && sorted.length === 0 && (
          <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "10px 4px" }}>
            no session matches {sq ? `“${sessionQ.trim()}”` : `tag “${tagFilter}”`}
          </div>
        )}
      </div>
    </div>
  );
}
