import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SessionBrief, SessionStatus } from "../../api";
import { api } from "../../api";
import { ago, projectTint } from "../../lib/surfaces";
import { Spinner } from "../ui";
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
  loadingSessionId: string | null;
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
  checking: { c: "var(--purple)", l: "CHECK" },
  live: { c: "var(--info)", l: "LIVE" },
  idle: { c: "var(--txf)", l: "IDLE" },
  done: { c: "var(--acc)", l: "DONE" },
};

const BUSY_NOW = ["working", "awaiting", "checking"];

function statusView(s: SessionStatus | undefined, done = false) {
  // DONE (finished, unopened) outranks idle/live, but never a state it's in
  // *now* — working, awaiting you, or having a prompt checked against it.
  const state = s?.state ?? "idle";
  if (done && !BUSY_NOW.includes(state)) return STATUS_VIEW.done;
  return STATUS_VIEW[state] ?? STATUS_VIEW.idle;
}

function SessionRow({
  s, i, on, loading, sv, flag, branch, pinned, onPin, onAttach, onAnalyzeProj, animate = true,
}: {
  s: SessionBrief;
  i: number;
  on: boolean;
  loading: boolean;
  sv: { c: string; l: string };
  flag?: PromptFlag;
  branch: string;
  pinned: boolean;
  onPin: () => void;
  onAttach: () => void;
  onAnalyzeProj: () => void;
  animate?: boolean;
}) {
  const [hov, setHov] = useState(false);
  const [tagHov, setTagHov] = useState(false);
  const tint = projectTint(s.project);
  const idle = sv.l === "IDLE";
  const fv = flag ? FLAG_VIEW[flag] : null;
  return (
    <div
      onClick={onAttach}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      data-ctx-type="session" data-ctx-id={s.id} data-ctx-label={s.title || "session"}
      style={{
        display: "flex", gap: 10, padding: "10px 11px", marginBottom: 7, cursor: "pointer",
        border: `1px solid ${on ? "color-mix(in srgb, var(--acc) 30%, transparent)" : "color-mix(in srgb, var(--acc) 10%, transparent)"}`,
        borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`,
        background: on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : hov ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "color-mix(in srgb, var(--panel2) 35%, transparent)",
        transition: "background .18s ease",
        animation: animate ? "mfadeup .4s ease both" : "none",
        animationDelay: animate ? `${Math.min(i, 10) * 35}ms` : undefined,
      }}
    >
      {loading ? (
        <span style={{ color: "var(--acc)", flex: "none", marginTop: 3, display: "flex" }}><Spinner className="h-[9px] w-[9px] border" /></span>
      ) : (
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: sv.c, flex: "none", marginTop: 4, boxShadow: `0 0 7px ${idle ? "transparent" : sv.c}` }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.4, color: on ? "var(--txb)" : "var(--txh)", fontWeight: on ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {s.title || "untitled session"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 6 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onAnalyzeProj(); }} title="analyze project"
            onMouseEnter={() => setTagHov(true)} onMouseLeave={() => setTagHov(false)}
            style={{ appearance: "none", cursor: "pointer", flex: "none", fontSize: 8.5, letterSpacing: 0.5, color: tint.color, border: `1px solid ${tint.border}`, background: tagHov ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", fontFamily: "inherit", padding: "1px 6px" }}
          >{tint.tag}</button>
          <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: "var(--purple-d)", minWidth: 0 }} title="worktree">
            <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{branch}</span>
          </span>
          {(s.tags ?? []).slice(0, 2).map((t) => (
            <span
              key={t}
              title={`tag: ${t}`}
              style={{ flex: "none", fontSize: 8.5, letterSpacing: 0.4,
                       color: "var(--purple-d)", border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)",
                       borderRadius: 3, padding: "0 4px", maxWidth: 64,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >{t}</span>
          ))}
          {s.goal && (
            // Active goals pulse; a blocked one is the row that wants you.
            <span
              title={`goal (${s.goal.state}): ${s.goal.objective}`}
              style={{ flex: "none", fontSize: 9,
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
              color: pinned ? "var(--acc)" : "var(--txf)", fontFamily: "inherit", fontSize: 10,
              lineHeight: 1, padding: "1px 3px", transition: "opacity .15s ease",
              // Hidden until hovered, so a quiet row stays quiet — but a pin always shows.
              opacity: pinned || hov ? 1 : 0, pointerEvents: pinned || hov ? "auto" : "none",
            }}
          >{pinned ? "★" : "☆"}</button>
          {fv && (
            <span
              title={fv.t}
              style={{
                fontSize: 8, letterSpacing: 0.8, color: fv.c, flex: "none", padding: "1px 5px",
                border: `1px solid color-mix(in srgb, ${fv.c} 45%, transparent)`,
                background: `color-mix(in srgb, ${fv.c} 10%, transparent)`,
                animation: flag === "checking" ? "twinkle 1.1s ease-in-out infinite" : undefined,
              }}
            >{fv.l}</span>
          )}
          <span style={{ fontSize: 8.5, letterSpacing: 1, color: sv.c, flex: "none" }}>{loading ? "LOADING…" : sv.l}</span>
          <span style={{ fontSize: 9, color: "var(--txl)", flex: "none" }}>{ago(s.updated)}</span>
        </div>
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
        color: hov ? "var(--tx)" : "#7f9d97", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5,
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
      onClick={onClick} title="new session in this project"
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        appearance: "none", cursor: "pointer", flex: "none", lineHeight: 0, padding: "5px 9px 6px",
        border: `1px solid ${on || hov ? "var(--purple)" : "color-mix(in srgb, var(--purple) 28%, transparent)"}`,
        background: on || hov ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent",
        color: on || hov ? "var(--purple-b)" : "var(--purple-h)", fontFamily: "inherit", fontSize: 14,
      }}
    >{on ? "✕" : "+"}</button>
  );
}

export function SessionsPanel(props: Props) {
  const {
    sessions, groups, status, done, flags, pins, selectedSessionId, loadingSessionId, activeProject,
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
  const [dragRel, setDragRel] = useState<string | null>(null);
  const [overRel, setOverRel] = useState<string | null>(null);
  const [drill, setDrill] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sessionQ, setSessionQ] = useState("");
  // Tag strip is capped at two rows — a tagged machine grows dozens of them and
  // they push the list off screen. Measured, so a short strip skips the toggle.
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagsOverflow, setTagsOverflow] = useState(false);
  const tagWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ tab, order, custom: customOrder })); }
    catch { /* ignore */ }
  }, [tab, order, customOrder]);

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
  // Every tag in play, for the filter strip. Sorted so the strip doesn't reshuffle
  // itself as sessions come and go.
  const allTags = [...new Set(sessions.flatMap((s) => s.tags ?? []))].sort();
  const sq = sessionQ.trim().toLowerCase();
  // Pinned first, then newest-first. Every list below slices this one, so a pin
  // holds the top of the RECENT list and of its own project's rows alike — and the
  // tag filter + search applied here reach RECENT and BY PROJECT from one place.
  const sorted = [...sessions]
    .filter((s) => !tagFilter || (s.tags ?? []).includes(tagFilter))
    .filter((s) => !sq || `${s.title ?? ""} ${(s.tags ?? []).join(" ")}`.toLowerCase().includes(sq))
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
    estimateSize: () => 66,
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

  const rowFor = (s: SessionBrief, i: number, animate = true) => (
    <SessionRow
      key={s.id} s={s} i={i} animate={animate}
      on={s.id === selectedSessionId} loading={s.id === loadingSessionId}
      sv={statusView(status.get(s.id), done.has(s.id))} flag={flags.get(s.id)}
      branch={s.branch || branchOf.get(s.project) || "main"}
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
        <span style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--purple-h)" }}>NEW SESSION</span>
        {nsScoped && (
          <span style={{ fontSize: 9.5, color: "var(--txm)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            · {groups.find((g) => g.rel === nsProject)?.name ?? nsProject}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setNsOpen(false)} title="close"
          onMouseEnter={() => setCloseHov(true)} onMouseLeave={() => setCloseHov(false)}
          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: closeHov ? "var(--purple-h)" : "var(--purple-g)", fontFamily: "inherit", fontSize: 13, lineHeight: 1, padding: "2px 4px" }}
        >✕</button>
      </div>
      {!nsScoped && (<>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <span style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>PROJECT</span>
        <input
          value={projQ} onChange={(e) => setProjQ(e.target.value)} placeholder="search projects…"
          style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "4px 7px" }}
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
                fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "4px 8px", minWidth: 0, maxWidth: "100%",
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
            style={{ appearance: "none", cursor: "pointer", border: "1px dashed color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 9, letterSpacing: 0.5, padding: "4px 8px" }}
          >SHOW ALL · {projHidden} MORE</button>
        )}
        {projAll && projList.length > PROJ_CAP && (
          <button
            onClick={() => setProjAll(false)}
            style={{ appearance: "none", cursor: "pointer", border: "1px dashed color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 9, letterSpacing: 0.5, padding: "4px 8px" }}
          >COLLAPSE</button>
        )}
        {projList.length === 0 && (
          <span style={{ fontSize: 9.5, color: "var(--txl)", padding: "4px 2px" }}>no project matches “{projQ}”</span>
        )}
      </div>
      </>)}
      <div style={{ display: "flex", alignItems: "center", gap: 7, margin: "12px 0 6px" }}>
        <span style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>WORKTREE</span>
        {branches.length > 5 && (
          <input
            value={branchQ} onChange={(e) => setBranchQ(e.target.value)} placeholder="search branches…"
            style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--purple) 25%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "4px 7px" }}
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
                fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "5px 8px", maxWidth: "100%", minWidth: 0,
              }}
            >
              <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b}</span>
            </button>
          );
        })}
        <button
          onClick={() => setNsNewOpen((o) => !o)} title="create a new worktree branch"
          style={{ appearance: "none", cursor: "pointer", border: `1px solid ${nsNewOpen ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`, background: nsNewOpen ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent", color: "var(--purple-h)", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 0.5, padding: "5px 9px" }}
        >+ NEW WORKTREE</button>
      </div>
      {nsNewOpen && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--purple-g)", flex: "none" }}>FROM</span>
            <button
              onClick={cycleParent} title="parent branch — click to cycle"
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)", background: "color-mix(in srgb, var(--purple) 6%, transparent)", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9, padding: "3px 7px", minWidth: 0 }}
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
            style={{ width: "100%", boxSizing: "border-box", marginTop: 7, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "7px 9px" }}
          />
        </>
      )}
      <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
        <button
          onClick={start}
          onMouseEnter={() => setStartHov(true)} onMouseLeave={() => setStartHov(false)}
          style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--purple)", background: startHov ? "color-mix(in srgb, var(--purple) 26%, transparent)" : "color-mix(in srgb, var(--purple) 16%, transparent)", color: "var(--purple-b)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 9, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
        ><span style={{ color: "var(--purple)" }}>▸</span>START SESSION</button>
        <button
          onClick={() => setNsOpen(false)}
          onMouseEnter={() => setCancelHov(true)} onMouseLeave={() => setCancelHov(false)}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: cancelHov ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "9px 12px" }}
        >CANCEL</button>
      </div>
    </div>
  );

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", animation: "enterLeft .55s cubic-bezier(.2,.8,.2,1) both .12s", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", flex: "none" }}>
        <span style={{ fontSize: 10.5, letterSpacing: 2.5, color: "var(--txl)" }}>SESSIONS</span>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--acc)" }}>{groups.length} PROJ · {sessionTotal} SESS</span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),color-mix(in srgb, var(--acc) 5%, transparent))", transformOrigin: "left", animation: "drawline .7s ease both .16s", flex: "none" }} />

      {/* Tabs pinned above the scroller so NEW SESSION sits right under them —
          RECENT owns the catch-all button; BY PROJECT starts sessions from each
          project's own header instead. */}
      <div style={{ flex: "none", padding: "10px 10px 2px" }}>
        {!drill && (
        <div style={{ display: "flex", gap: 3, border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", background: "color-mix(in srgb, var(--panel2) 30%, transparent)", padding: 3 }}>
          <button
            onClick={() => { setTab("recent"); setNsOpen(false); }}
            style={{ flex: 1, appearance: "none", cursor: "pointer", border: 0, background: tab === "recent" ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent", color: tab === "recent" ? "var(--txb)" : "var(--txf)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: 7, transition: "all .15s ease" }}
          >RECENT</button>
          <button
            onClick={() => { setTab("grouped"); setNsOpen(false); }}
            style={{ flex: 1, appearance: "none", cursor: "pointer", border: 0, background: tab === "grouped" ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent", color: tab === "grouped" ? "var(--txb)" : "var(--txf)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: 7, transition: "all .15s ease" }}
          >BY PROJECT</button>
        </div>
        )}
        {/* Search over titles + tags. Stays visible inside a project drill-down —
            the filter still applies there, so hiding the box reads as broken. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel2) 45%, transparent)", padding: "0 7px" }}>
          <span style={{ fontSize: 9, color: "var(--txf)", flex: "none" }}>⌕</span>
          <input
            value={sessionQ} onChange={(e) => setSessionQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setSessionQ(""); }}
            placeholder="search sessions — title or tag"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "5px 0" }}
          />
          {sessionQ && (
            <button
              onClick={() => setSessionQ("")} title="clear search"
              style={{ appearance: "none", cursor: "pointer", flex: "none", border: 0, background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 10, lineHeight: 1, padding: "2px 1px" }}
            >✕</button>
          )}
        </div>
        {/* Tag filter. Only appears once something is tagged, so an untagged
            machine never pays for a control it can't use. */}
        {allTags.length > 0 && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 4, marginTop: 6 }}>
            <div
              ref={tagWrapRef}
              style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: 4,
                       maxHeight: tagsOpen ? undefined : 42, overflow: "hidden" }}
            >
              {allTags.map((t) => {
                const on = tagFilter === t;
                return (
                  <button
                    key={t}
                    onClick={() => setTagFilter(on ? null : t)}
                    title={on ? `showing only ${t} — click to clear` : `show only ${t}`}
                    style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit",
                             fontSize: 9, letterSpacing: 0.5, padding: "2px 7px",
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
                title={tagsOpen ? "collapse tags to two rows" : "show all tags"}
                style={{ appearance: "none", cursor: "pointer", flex: "none", fontFamily: "inherit",
                         fontSize: 9, letterSpacing: 0.5, padding: "2px 6px",
                         border: "1px dashed color-mix(in srgb, var(--purple) 30%, transparent)",
                         background: "transparent", color: "var(--txd)" }}
              >{tagsOpen ? "LESS" : "MORE"}</button>
            )}
          </div>
        )}
        {!drill && tab === "recent" && (
          <button
            onClick={toggleForm} title="start a session — current worktree or a new one"
            onMouseEnter={() => setNsBtnHov(true)} onMouseLeave={() => setNsBtnHov(false)}
            style={{
              width: "100%", marginTop: 6, appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              border: `1px solid ${nsOpen ? "color-mix(in srgb, var(--purple) 50%, transparent)" : "color-mix(in srgb, var(--acc) 30%, transparent)"}`,
              background: nsOpen ? "color-mix(in srgb, var(--purple) 12%, transparent)" : "color-mix(in srgb, var(--acc) 6%, transparent)",
              color: nsOpen ? "var(--purple-b)" : "var(--tx)",
              fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "6px 10px",
              transition: "all .15s ease", filter: nsBtnHov ? "brightness(1.18)" : "none",
            }}
          ><span style={{ fontSize: 12, lineHeight: 0 }}>+</span>NEW SESSION</button>
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
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: backHov ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--tx)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "5px 10px" }}
              ><span style={{ fontSize: 13, lineHeight: 0 }}>←</span>BACK</button>
              <span style={{ fontSize: 8.5, letterSpacing: 0.5, color: drillTint.color, border: `1px solid ${drillTint.border}`, padding: "1px 6px", flex: "none" }}>{drillTint.tag}</span>
              <span style={{ fontSize: 10.5, color: "var(--txh)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{drillGroup?.name ?? drill}</span>
              <span style={{ fontSize: 8.5, letterSpacing: 1, color: "var(--txf)", flex: "none" }}>{drillSessions.length} SESS</span>
              <PlusBtn on={nsOpen && nsScoped && nsProject === drill} onClick={() => openFor(drill)} />
            </div>
            {nsOpen && nsScoped && nsProject === drill && nsForm}
            {/* Drilling into a busy project lists every one of its sessions, so
                off-screen rows skip layout/paint. RECENT gets the virtualizer
                instead — it is the one list long enough to be worth the code. */}
            <div className="vskip-card">{drillSessions.map((s, i) => rowFor(s, i))}</div>
          </>
        ) : (
          <>
            {tab === "recent" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 10px" }}>
                  <span style={{ fontSize: 9.5, letterSpacing: 2, color: "var(--txl)", flex: "none" }}>RECENT SESSIONS</span>
                  <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />
                  <span style={{ fontSize: 8.5, letterSpacing: 0.5, color: "var(--txf)", flex: "none" }}>{pins.size ? "pinned · newest first" : "newest first"}</span>
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
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 10px", position: "relative" }}>
                  <span style={{ fontSize: 9.5, letterSpacing: 2, color: "var(--txl)", flex: "none" }}>PROJECTS</span>
                  <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />
                  <button
                    onClick={() => setOrderMenu((o) => !o)} title="project order"
                    style={{ appearance: "none", cursor: "pointer", flex: "none", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${orderMenu ? "var(--acc)" : "color-mix(in srgb, var(--acc) 20%, transparent)"}`, background: orderMenu ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: orderMenu ? "var(--txb)" : "var(--txd)", fontFamily: "inherit", fontSize: 8.5, letterSpacing: 1, padding: "3px 7px" }}
                  >⇅ {ORDER_LABEL[order]} ▾</button>
                  {orderMenu && (
                    <>
                      <div onClick={() => setOrderMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
                      <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 97, minWidth: 132, border: "1px solid color-mix(in srgb, var(--acc) 28%, transparent)", background: "var(--panel)", boxShadow: "0 8px 22px var(--shadow-pop)", padding: 3, animation: "mslide .16s ease both" }}>
                        {(["recent", "alpha", "custom"] as OrderMode[]).map((m) => (
                          <button
                            key={m} onClick={() => { setOrder(m); setOrderMenu(false); }}
                            style={{ width: "100%", appearance: "none", cursor: "pointer", textAlign: "left", border: 0, background: order === m ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent", color: order === m ? "var(--txb)" : "var(--txd)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 8px" }}
                          >{order === m ? "▸ " : "  "}{ORDER_LABEL[m]}</button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                {order === "custom" && (
                  <div style={{ fontSize: 8.5, letterSpacing: 0.5, color: "var(--txf)", margin: "-2px 2px 8px" }}>
                    drag ⠿ to reorder — pinned projects stay on top
                  </div>
                )}
                {ordered.map((g) => {
                  const tint = projectTint(g.rel);
                  const shown = rowsFor(g.rel);
                  // Filtered rows are already the whole match set, and g.sessionCount
                  // counts the unfiltered project — so there is nothing more to show.
                  const more = sq || tagFilter ? 0 : g.sessionCount - shown.length;
                  const dragging = dragRel === g.rel;
                  const dropHere = !!dragRel && overRel === g.rel && !dragging;
                  return (
                    <div
                      key={g.rel}
                      // ponytail: native HTML5 DnD, no library — and only the grip is
                      // draggable, so a stray drag on a row can't reorder anything.
                      onDragOver={dragRel ? (e) => { e.preventDefault(); setOverRel(g.rel); } : undefined}
                      onDrop={dragRel ? (e) => { e.preventDefault(); dropOn(g.rel); } : undefined}
                      style={{ opacity: dragging ? 0.4 : 1, borderTop: `2px solid ${dropHere ? "var(--acc)" : "transparent"}` }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 7, margin: "13px 2px 8px" }}>
                        {order === "custom" && (
                          <span
                            draggable
                            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragRel(g.rel); }}
                            onDragEnd={() => { setDragRel(null); setOverRel(null); }}
                            title="drag to reorder"
                            style={{ cursor: "grab", flex: "none", color: "var(--txf)", fontSize: 11, lineHeight: 1, userSelect: "none" }}
                          >⠿</span>
                        )}
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: tint.color, flex: "none" }} />
                        <span style={{ fontSize: 8.5, letterSpacing: 0.5, color: tint.color, border: `1px solid ${tint.border}`, padding: "1px 6px", flex: "none" }}>{tint.tag}</span>
                        <span style={{ fontSize: 10.5, color: "var(--txm)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
                        <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />
                        <span style={{ fontSize: 8.5, color: "var(--txf)", flex: "none" }}>{g.sessionCount} SESS</span>
                        <PlusBtn on={nsOpen && nsScoped && nsProject === g.rel} onClick={() => openFor(g.rel)} />
                      </div>
                      {nsOpen && nsScoped && nsProject === g.rel && nsForm}
                      {/* A search or tag filter drops the per-project cap, so this
                          can be every session in the store — skip off-screen rows. */}
                      <div className="vskip-card">{shown.map((s, i) => rowFor(s, i))}</div>
                      {more > 0 && <DashedRow label={`SHOW MORE · ${more} →`} onClick={() => setDrill(g.rel)} />}
                      {g.sessionCount === 0 && (
                        <DashedRow label="+ START SESSION" title="start a session in this project"
                          onClick={() => openFor(g.rel)} />
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
        {groups.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--txl)", padding: "10px 4px" }}>No projects with sessions yet.</div>
        )}
        {groups.length > 0 && (sq || tagFilter) && sorted.length === 0 && (
          <div style={{ fontSize: 10.5, color: "var(--txl)", padding: "10px 4px" }}>
            no session matches {sq ? `“${sessionQ.trim()}”` : `tag “${tagFilter}”`}
          </div>
        )}
      </div>
    </div>
  );
}
