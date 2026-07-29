import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SessionBrief, SessionStatus } from "../../api";
import { api } from "../../api";
import { ago, projectTint } from "../../lib/surfaces";
import { Spinner } from "../ui";
import type { ProjectGroup } from "./ProjectsPanel";

interface Props {
  sessions: SessionBrief[]; // full list — the RECENT view + drill-down need more than the capped group slices
  groups: ProjectGroup[];
  status: Map<string, SessionStatus>;
  done: Set<string>; // finished a turn, not opened since
  selectedSessionId: string | null;
  loadingSessionId: string | null;
  activeProject: string | null;
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
  live: { c: "var(--info)", l: "LIVE" },
  idle: { c: "var(--txf)", l: "IDLE" },
  done: { c: "var(--acc)", l: "DONE" },
};

function statusView(s: SessionStatus | undefined, done = false) {
  // DONE (finished, unopened) outranks idle/live, but never a live working or
  // awaiting state — those are what it's doing *now*.
  const state = s?.state ?? "idle";
  if (done && state !== "working" && state !== "awaiting") return STATUS_VIEW.done;
  return STATUS_VIEW[state] ?? STATUS_VIEW.idle;
}

function SessionRow({
  s, i, on, loading, sv, branch, onAttach, onAnalyzeProj, animate = true,
}: {
  s: SessionBrief;
  i: number;
  on: boolean;
  loading: boolean;
  sv: { c: string; l: string };
  branch: string;
  onAttach: () => void;
  onAnalyzeProj: () => void;
  animate?: boolean;
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
        <div style={{ fontSize: 12.5, lineHeight: 1.4, color: on ? "#eafff9" : "var(--txh)", fontWeight: on ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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
          <span style={{ flex: 1 }} />
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
        appearance: "none", cursor: "pointer", flex: "none", lineHeight: 0, padding: "3px 6px 4px",
        border: `1px solid ${on || hov ? "var(--purple)" : "color-mix(in srgb, var(--purple) 28%, transparent)"}`,
        background: on || hov ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent",
        color: on || hov ? "var(--purple-b)" : "var(--purple-h)", fontFamily: "inherit", fontSize: 12,
      }}
    >{on ? "✕" : "+"}</button>
  );
}

export function SessionsPanel(props: Props) {
  const {
    sessions, groups, status, done, selectedSessionId, loadingSessionId, activeProject,
    onSelectSession, onAnalyze, onNewSession, onWorktreeSession,
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
  const sorted = [...sessions].sort((a, b) => b.updated - a.updated);
  // BY PROJECT: most-recently-used project first. g.sessions is already
  // newest-first, so [0] is the project's last activity; no sessions → last.
  const byLastUsed = [...groups].sort((a, b) => (b.sessions[0]?.updated ?? 0) - (a.sessions[0]?.updated ?? 0));
  // CUSTOM: pinned positions first (sort is stable, so anything you never
  // dragged keeps its last-used order behind them).
  const rank = (rel: string) => { const i = customOrder.indexOf(rel); return i < 0 ? Infinity : i; };
  const ordered =
    order === "alpha" ? [...groups].sort((a, b) => a.name.localeCompare(b.name))
      : order === "custom" ? [...byLastUsed].sort((a, b) => rank(a.rel) - rank(b.rel))
        : byLastUsed;
  // RECENT tab: newest-first, matching the design mock's "newest first".
  const recentSorted = [...sessions].sort((a, b) => b.updated - a.updated);

  // Virtualize the uncapped RECENT list against the shared .mscroll scroller.
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const recentActive = !drill && tab === "recent";
  const rowV = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: recentActive ? recentSorted.length : 0,
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
      sv={statusView(status.get(s.id), done.has(s.id))}
      branch={s.branch || branchOf.get(s.project) || "main"}
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
      {!drill && (
      <div style={{ flex: "none", padding: "10px 10px 2px" }}>
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
        {tab === "recent" && (
          <button
            onClick={toggleForm} title="start a session — current worktree or a new one"
            onMouseEnter={() => setNsBtnHov(true)} onMouseLeave={() => setNsBtnHov(false)}
            style={{
              width: "100%", marginTop: 7, appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              border: `1px solid ${nsOpen ? "color-mix(in srgb, var(--purple) 50%, transparent)" : "color-mix(in srgb, var(--acc) 30%, transparent)"}`,
              background: nsOpen ? "color-mix(in srgb, var(--purple) 12%, transparent)" : "color-mix(in srgb, var(--acc) 6%, transparent)",
              color: nsOpen ? "var(--purple-b)" : "var(--tx)",
              fontFamily: "inherit", fontSize: 10.5, letterSpacing: 1.5, padding: "10px 8px",
              transition: "all .15s ease", filter: nsBtnHov ? "brightness(1.18)" : "none",
            }}
          ><span style={{ fontSize: 14, lineHeight: 0 }}>+</span>NEW SESSION</button>
        )}
      </div>
      )}

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
            {drillSessions.map((s, i) => rowFor(s, i))}
          </>
        ) : (
          <>
            {tab === "recent" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 10px" }}>
                  <span style={{ fontSize: 9.5, letterSpacing: 2, color: "var(--txl)", flex: "none" }}>RECENT SESSIONS</span>
                  <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />
                  <span style={{ fontSize: 8.5, letterSpacing: 0.5, color: "var(--txf)", flex: "none" }}>newest first</span>
                </div>
                <div ref={listRef} style={{ position: "relative", height: rowV.getTotalSize() }}>
                  {rowV.getVirtualItems().map((vi) => (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={rowV.measureElement}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start - scrollMargin}px)` }}
                    >
                      {rowFor(recentSorted[vi.index], vi.index, false)}
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
                      <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 97, minWidth: 132, border: "1px solid color-mix(in srgb, var(--acc) 28%, transparent)", background: "var(--panel)", boxShadow: "0 8px 22px rgba(0,0,0,.45)", padding: 3, animation: "mslide .16s ease both" }}>
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
                  const more = g.sessionCount - g.sessions.length;
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
                      {g.sessions.map((s, i) => rowFor(s, i))}
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
      </div>
    </div>
  );
}
