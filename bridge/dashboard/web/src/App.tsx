import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  api,
  AUTH_REQUIRED,
  TOKEN,
  type AnswerSelection,
  type DashState,
  type EffortLevel,
  type EnrichedSession,
  type GitBadge,
  type GitStatus,
  type Lifecycle,
  type ModelId,
  type SessionBrief,
  type SessionStatus,
  type UsageInfo,
  type AccountInfo,
  type FreeAgentInfo,
} from "./api";
import { modelOptions, latestPerFamily, type AgentOption } from "./models";
import { activeOf, estimateContextTokens, mergeDelta, type Turn } from "./chat";
import { useTelemetry } from "./lib/telemetry";
import { ago, useProjectTints } from "./lib/surfaces";
import {
  autoTextScale,
  isLight,
  loadSettings,
  sameFamily,
  saveSettings,
  themeCanvas,
  themeDef,
  themeFilter,
  themeFont,
  themeVars,
  THEME_TOKEN_KEYS,
  type HudSettings,
  type RightTab,
  type ThemeKey,
} from "./lib/theme";
import { useHostVitals, useRadio, useWeather } from "./lib/ambient";
import { nativeCtxItems } from "./lib/nativeCtx";
import { useAiFeatures } from "./lib/ai";
import { useSessionPins } from "./lib/prefs";
import { stickToBottom } from "./lib/stick";
import { Composer } from "./components/Composer";
import { SuggestNewSessionCard } from "./components/SuggestNewSessionCard";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Strip } from "./components/hud/Strip";
import { StatusBar } from "./components/hud/StatusBar";
import { TaskQueuePanel } from "./components/hud/TaskQueuePanel";
import { ProjectsPanel, type ProjectGroup } from "./components/hud/ProjectsPanel";
import { FilesPanel } from "./components/hud/FilesPanel";
import { SkillsPanel } from "./components/hud/SkillsTab";
import { RightPanel, type PanelTab } from "./components/RightPanel";
import { GitTab } from "./components/GitTab";
import { SessionsPanel, type PromptFlag } from "./components/hud/SessionsPanel";
import { Terminal } from "./components/hud/Terminal";
import type { View } from "./components/hud/ViewTabs";
import { notify } from "./components/hud/Notifications";
import { BootIntro } from "./components/hud/BootIntro";
import { SettingsModal } from "./components/hud/SettingsModal";
import { ContextMenu, type CtxItem, type CtxState } from "./components/hud/ContextMenu";
import { AnalyzeModal, type Tab as AnalyzeTab } from "./components/hud/AnalyzeModal";
import { ManageProjectsModal } from "./components/hud/ManageProjectsModal";
import { ToolsModal } from "./components/hud/ToolsModal";
import { ProjectPreviewModal } from "./components/hud/ProjectPreviewModal";
import { AgentsPill } from "./components/AgentsPill";
import { GoalPill } from "./components/GoalPill";
import { usePreviewQueue } from "./components/design/usePreviewQueue";
import { Spinner } from "./components/ui";


function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}H${String(m).padStart(2, "0")}M`;
}

// Manage-projects choices survive a reload / bridge restart. HIDE is owned by
// the bridge (project_config.json, GET/POST /local/project*), so it syncs across
// browsers; the localStorage copy is only a cache for the pre-first-poll paint.
// ponytail: remove/import stay per-browser — no bridge endpoint for them yet.
const MANAGE_KEY = "hud-project-manage";
type ManagePrefs = { hidden: Record<string, boolean>; removed: Record<string, boolean>; imported: string[] };

function loadManage(): ManagePrefs {
  try {
    const r = JSON.parse(localStorage.getItem(MANAGE_KEY) || "{}") as Partial<ManagePrefs>;
    return { hidden: r.hidden ?? {}, removed: r.removed ?? {}, imported: r.imported ?? [] };
  } catch { return { hidden: {}, removed: {}, imported: [] }; }
}

// Sessions that finished a turn while you were looking elsewhere — flagged DONE
// in the session list until you open them. Persisted so a reload doesn't lose
// "you haven't seen this yet".
const DONE_KEY = "hud-sessions-done";

function loadDone(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || "[]") as string[]); }
  catch { return new Set(); }
}

// Composer text you typed but never sent, per session. Persisted so a reload
// doesn't silently drop it — the DRAFT flags in the session list promise it's
// still there. Image attachments stay in the composer and aren't part of this.
const DRAFTS_KEY = "hud-session-drafts";

function loadDrafts(): Record<string, string> {
  try {
    const r = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}") as unknown;
    if (!r || typeof r !== "object") return {};
    return Object.fromEntries(
      Object.entries(r as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string" && v.trim()),
    ) as Record<string, string>;
  } catch { return {}; }
}

/** The relevance check holds the run for ~10s before anything starts. Loud on
 *  purpose: the quiet one-liner this replaced read as the UI being stuck, and
 *  the prompt line shows exactly what's waiting (and in which session). */
function CheckingBanner({ prompt }: { prompt: string }) {
  return (
    <div
      style={{
        position: "relative", overflow: "hidden", margin: "0 16px 9px", padding: "10px 12px",
        border: "1px solid var(--purple)", background: "color-mix(in srgb, var(--purple) 13%, transparent)",
        boxShadow: "0 0 18px color-mix(in srgb, var(--purple) 22%, transparent)",
        animation: "mpop .18s ease both",
      }}
    >
      <span style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg,transparent,var(--purple),transparent)", backgroundSize: "200% 100%", animation: "awaitsweep 1.4s linear infinite" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span style={{ color: "var(--purple-b)", display: "flex", flex: "none" }}>
          <Spinner className="h-[11px] w-[11px] border" />
        </span>
        <span style={{ fontSize: 12, letterSpacing: 2, fontWeight: 600, color: "var(--purple-b)", flex: "none", animation: "twinkle 1.2s ease-in-out infinite" }}>
          CHECKING CONTEXT…
        </span>
        <span style={{ fontSize: 10, letterSpacing: 0.5, color: "var(--txd)" }}>
          deciding if this belongs in this session — nothing has run yet
        </span>
      </div>
      <div style={{ marginTop: 7, fontSize: 11, color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <span style={{ color: "var(--purple)" }}>❯ </span>{prompt}
      </div>
    </div>
  );
}

/** Drop one session's entry from a per-session map (same object if absent). */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

// A prompt the relevance guardrail parked, with everything needed to route it
// later — the session and project it was written in, not whichever is open when
// the user finally answers the card.
interface HeldPrompt {
  sid: string;
  project?: string;
  text: string;
  images: string[];
  reason: string;
  title: string | null;
}

export function App() {
  useProjectTints(); // re-render on saved project tag/colour edits
  const [state, setState] = useState<DashState | null>(null);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false); // true from select until its transcript first resolves
  const [turns, setTurns] = useState<Turn[]>([]);
  const [view, setView] = useState<View>("chat");
  // Which model-spending extras are on: each one owns a tab and a palette entry
  // that don't exist while it's off.
  const ai = useAiFeatures();
  const [statusMap, setStatusMap] = useState<Map<string, SessionStatus>>(new Map());
  const [doneIds, setDoneIds] = useState<Set<string>>(loadDone);
  const [pins, togglePin] = useSessionPins();
  const [gitBadges, setGitBadges] = useState<Map<string, GitBadge>>(new Map());
  // The open session's own working tree (its worktree when it has one), which
  // gitBadges can't answer — those are keyed by project, one badge per repo.
  const [sessionGit, setSessionGit] = useState<GitStatus | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  // Free-agent rungs that are ready to run right now (configured + opencode
  // installed) — the non-Claude half of the AGENT picker.
  const [freeAgents, setFreeAgents] = useState<FreeAgentInfo[]>([]);
  const [inject, setInject] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  // Prompts the relevance guardrail held back — still client-side, nothing ran.
  // Keyed by the session each one was written in: the check takes ~10s, and a
  // card about session A must not appear (or start work) in session B.
  const [heldMap, setHeldMap] = useState<Record<string, HeldPrompt>>({});
  const [heldBusy, setHeldBusy] = useState(false);
  // /local/run is in flight, per session. Normally ~instant, but a relevance
  // check makes it block for ~10s — without this the composer looks dead.
  const [checkingMap, setCheckingMap] = useState<Record<string, string>>({});
  // Typed but not sent, per session. Lives here (not in the composer) so it
  // survives a session switch and the session list can flag it as a DRAFT.
  const [drafts, setDrafts] = useState<Record<string, string>>(loadDrafts);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // ?skipboot bypasses the intro (handy on revisits + for screenshots).
  const skipBoot = new URLSearchParams(location.search).has("skipboot");
  const [booting, setBooting] = useState(!skipBoot);
  const [showDashboard, setShowDashboard] = useState(skipBoot);
  const [manageOpen, setManageOpen] = useState(false);
  const [toolsFor, setToolsFor] = useState<string | null>(null); // session id
  const [previewProject, setPreviewProject] = useState<string | null>(null);
  // Manage-projects bookkeeping. TODO(phase2-data): the bridge has no
  // remove/import endpoints, so those two persist client-side.
  const [hiddenProjects, setHiddenProjects] = useState<Record<string, boolean>>(() => loadManage().hidden);
  const [removedProjects, setRemovedProjects] = useState<Record<string, boolean>>(() => loadManage().removed);
  const [importedProjects, setImportedProjects] = useState<string[]>(() => loadManage().imported);
  // Git repos discovered on disk (org-folder nesting included) — so sessionless
  // projects still show up in the PROJECTS panel.
  const [discovered, setDiscovered] = useState<string[]>([]);

  // HUD chrome state.
  const [settings, setSettings] = useState<HudSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The composer's four run knobs live in settings so they survive a reload —
  // the SESSION tab and the composer's dropdowns write the same state.
  const model = settings.model as ModelId;
  const effort = settings.effort as EffortLevel | "";
  const permMode = settings.perm;
  const ponytail = settings.ponytail;
  const setModel = (m: ModelId) => patchSettings({ model: m });
  const setEffort = (e: EffortLevel | "") => patchSettings({ effort: e });
  const setPermMode = (m: string) => patchSettings({ perm: m });
  const setPonytail = (p: string) => patchSettings({ ponytail: p });
  const [analyzeProject, setAnalyzeProject] = useState<string | null>(null);
  // Set only when the modal is opened as a deep-link on a file (sidebar FILES).
  const [analyzeFile, setAnalyzeFile] = useState<{ path: string; branch?: string } | null>(null);
  // Set only when something opens the modal straight onto a tab (composer MAP).
  const [analyzeTab, setAnalyzeTab] = useState<AnalyzeTab | undefined>(undefined);
  // Set only by re-run on a transcript terminal block — typed into the PTY.
  const [analyzeCommand, setAnalyzeCommand] = useState<string | undefined>(undefined);
  const [ctxMenu, setCtxMenu] = useState<CtxState | null>(null);
  // The browser items we took away by preventDefault()-ing, rebuilt per open.
  const [nativeCtx, setNativeCtx] = useState<{ top: CtxItem[]; page: CtxItem[] }>({ top: [], page: [] });
  const [ctxClosing, setCtxClosing] = useState(false);
  const ctxTimer = useRef<number | null>(null);

  const seqRef = useRef(0);
  // The open session, readable from async work that outlives a session switch:
  // a send() awaiting its relevance check must know whether you're still here.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const liveTurns = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Mirror of stickRef for rendering — the ref drives the auto-scroll (no
  // re-render), the state drives the "jump to latest" button.
  const [atBottom, setAtBottom] = useState(true);
  const jumpToBottom = useCallback(() => {
    stickRef.current = true;
    setAtBottom(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // AUTO text size follows the window; a fixed textScale ignores this.
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const uiScale = settings.textScale || autoTextScale(vp.w, vp.h);

  // Ambient widgets.
  const host = useHostVitals();
  const { weather, setCity, setUnit } = useWeather();
  const [wxSettings, setWxSettings] = useState(0); // nonce — opens the weather settings editor from the context menu
  const radio = useRadio(settings.radioVolume);
  // Server-side per-session prompt queue: lets a new prompt be queued while a
  // turn is in flight (runs after it) instead of forcing a STOP first.
  const queue = usePreviewQueue(sessionId);

  const active = activeOf(turns);
  const running = active !== null;
  const pendingCount = active?.pending.length ?? 0;
  const selected = sessions.find((s) => s.id === sessionId) ?? null;
  const activeProject = state?.project?.rel ?? null;
  // Everything the composer shows is scoped to the open session — a check or a
  // held card belonging to another one stays with that one.
  const checking = sessionId ? checkingMap[sessionId] : undefined;
  const held = sessionId ? heldMap[sessionId] : undefined;
  const draft = (sessionId ? drafts[sessionId] : "") ?? "";
  const openWorking =
    (sessionId ? statusMap.get(sessionId)?.state : undefined) === "working";

  const contextTokens = estimateContextTokens(turns);
  const toolCount = turns.reduce(
    (n, t) => n + t.events.filter((e) => e.type === "tool").length, 0);
  const eventCount = turns.reduce((n, t) => n + t.events.length, 0);
  const tele = useTelemetry({ running, toolCount, eventCount });

  // Apply theme: hue-rotate filter on the dashboard, glow var, ambient bg.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--glow", settings.glow ? "8px" : "0px");
    // The UA chrome we don't paint — <select> option popups, native scrollbars,
    // autofill — follows color-scheme, so a light theme has to say so or those
    // render light-text-on-dark inside an otherwise white dashboard.
    root.style.colorScheme = isLight(settings.theme) ? "light" : "dark";
    // `data-light` drives the light-ground token overrides in index.css — the
    // alpha washes and borders authored for a dark ground are invisible on paper.
    if (isLight(settings.theme)) root.dataset.light = "";
    else delete root.dataset.light;
    // Palette themes override the design tokens on :root (not just the themed
    // wrapper) so the DERIVED tokens (--primary/--card/--border/--ac-*, defined
    // via var() in :root) re-resolve to the palette too. Filter themes clear
    // these and recolour via the container `filter` instead.
    const vars = themeVars(settings.theme);
    for (const k of THEME_TOKEN_KEYS) {
      const v = vars[k];
      if (v != null) root.style.setProperty(k, v);
      else root.style.removeProperty(k);
    }
    saveSettings(settings);
  }, [settings]);

  // Picking a theme also applies its default CRT toggles (design onPick) —
  // except within a family (AURORA's colours, CLAUDE's accents), which is one
  // profile, so your toggles survive the switch.
  function setTheme(t: ThemeKey) {
    const d = themeDef(t);
    setSettings((s) =>
      sameFamily(s.theme, t)
        ? { ...s, theme: t }
        : { ...s, theme: t, scanlines: d.crt, sweep: d.swp, glow: d.glw });
  }
  function toggleCrt(key: "scanlines" | "sweep" | "glow") {
    setSettings((s) => ({ ...s, [key]: !s[key] }));
  }
  function patchSettings(patch: Partial<HudSettings>) {
    setSettings((s) => ({ ...s, ...patch }));
  }
  function toggleRight() {
    setSettings((s) => ({ ...s, rightOpen: !s.rightOpen }));
  }
  // Tab click: the active tab collapses the sidebar, any other opens on it.
  function pickRightTab(id: string) {
    setSettings((s) => ({ ...s, rightTab: id as RightTab, rightOpen: !(s.rightOpen && s.rightTab === id) }));
  }

  // Every AnalyzeModal open goes through here so a stale file deep-link can't
  // survive into the next (plain) open.
  function openAnalyze(rel: string, file?: { path: string; branch?: string }, tab?: AnalyzeTab,
                       command?: string) {
    setAnalyzeFile(file ?? null);
    setAnalyzeTab(tab);
    setAnalyzeCommand(command);
    setAnalyzeProject(rel);
  }

  // Re-run a command from a transcript terminal block: the project's TERMINAL
  // tab, on a live PTY, with the command already typed in.
  function runCommand(command: string) {
    const rel = selected?.project ?? activeProject;
    if (rel) openAnalyze(rel, undefined, "terminal", command);
  }

  // A changed file opens on the GIT tab (diff view) — an editor buffer hides
  // which lines actually changed. Clean files still open in the editor.
  function openFileFromPanel(path: string, changed: boolean) {
    if (sessionProject) openAnalyze(sessionProject, { path, branch: sessionBranch }, changed ? "changes" : undefined);
  }

  function openSession(id: string) {
    seqRef.current = 0;
    stickRef.current = true;
    setAtBottom(true);
    setTurns([]);
    setLoadingSession(true);
    setSessionId(id);
    setDoneIds((d) => { if (!d.has(id)) return d; const n = new Set(d); n.delete(id); return n; });
  }

  async function selectSession(s: SessionBrief) {
    if (s.project !== activeProject) {
      try { await api.select(s.project); setState(await api.state()); } catch { /* ignore */ }
    }
    openSession(s.id);
  }

  // --- polls (unchanged data flow) ---
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const s = await api.state(); if (live) setState(s); } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { live = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(MANAGE_KEY, JSON.stringify({ hidden: hiddenProjects, removed: removedProjects, imported: importedProjects })); }
    catch { /* ignore */ }
  }, [hiddenProjects, removedProjects, importedProjects]);

  // Disk discovery polls like the session list, so a repo cloned or created
  // after load appears on its own — no rescan button, no reload.
  const refreshProjects = useCallback(async () => {
    try {
      const p = await api.projects();
      setDiscovered(p.projects ?? []);
      // The bridge is the source of truth for HIDE; an older backend omits the
      // field, in which case the cached localStorage set stands.
      if (p.hidden) setHiddenProjects(Object.fromEntries(p.hidden.map((rel) => [rel, true])));
    } catch { /* old backend without discovery — panel stays session-derived */ }
  }, []);
  useEffect(() => {
    void refreshProjects();
    const id = setInterval(refreshProjects, 10000);
    return () => clearInterval(id);
  }, [refreshProjects]);

  const loadSessions = useCallback(async () => {
    try {
      const { sessions: list } = await api.sessions();
      // A poll already in flight when a session is created comes back without
      // it and would drop the chat you just opened (startIn/newSession add it
      // optimistically) out of the lists — keep the open one until a poll
      // carries it.
      setSessions((prev) => {
        const sid = sessionIdRef.current;
        const open = sid && !list.some((s) => s.id === sid)
          ? prev.find((s) => s.id === sid) : undefined;
        return open ? [open, ...list] : list;
      });
      return list;
    } catch { return [] as SessionBrief[]; }
  }, []);

  const projectRel = state?.project?.rel ?? null;
  useEffect(() => {
    let live = true;
    void loadSessions().then((ss) => {
      if (!live) return;
      if (!sessionId) {
        const cur = ss.find((s) => s.project === projectRel) ?? ss[0];
        if (cur) openSession(cur.id);
      }
    });
    const id = setInterval(loadSessions, 5000);
    return () => { live = false; clearInterval(id); };
  }, [loadSessions, projectRel, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const fetchOnce = async () => {
      try {
        const t = await api.transcript(sessionId, seqRef.current);
        if (!live) return;
        setTurns((prev) => mergeDelta(prev, t));
        seqRef.current = t.next_cursor;
      } catch { /* ignore */ }
      finally { if (live) setLoadingSession(false); }
    };
    void fetchOnce();                                   // always load once on open
    // Then poll only while the session is actually producing output; an idle
    // session doesn't change, so re-effect on the running/working transitions
    // (this also captures the final delta the moment a turn completes).
    const id = setInterval(() => {
      if (running || openWorking) void fetchOnce();
    }, 1500);
    return () => { live = false; clearInterval(id); };
  }, [sessionId, running, openWorking]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let prev = el.scrollTop;
    const sync = () => {
      const stick = stickToBottom(el, prev);
      prev = el.scrollTop;
      stickRef.current = stick;
      setAtBottom(stick);           // no-op re-render-wise unless it flipped
    };
    el.addEventListener("scroll", sync, { passive: true });
    // Content grew/shrank: pull to the bottom if we were parked there, otherwise
    // re-check (a shrink can land us back at the bottom on its own).
    const ro = new ResizeObserver(() => { if (stickRef.current) el.scrollTop = el.scrollHeight; else sync(); });
    ro.observe(content);
    if (stickRef.current) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => { el.removeEventListener("scroll", sync); ro.disconnect(); };
  }, [view, showDashboard]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running();
        if (!live) return;
        setStatusMap(new Map(Object.entries(r.status ?? {})));
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => { live = false; clearInterval(id); };
  }, []);

  // working → not-working (and not awaiting, which the list already flags) on a
  // session you don't have open = it finished without you = DONE.
  // ponytail: only transitions this tab actually polls get flagged — a session
  // that finishes while the dashboard is closed won't. Needs a bridge-side
  // finished_at/seen_at pair to cover that.
  const prevStatus = useRef(statusMap);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = statusMap;
    const finished = [...prev]
      .filter(([id, st]) => st.state === "working" && id !== sessionId
        && !["working", "awaiting"].includes(statusMap.get(id)?.state ?? ""))
      .map(([id]) => id);
    if (finished.length) setDoneIds((d) => new Set([...d, ...finished]));
  }, [statusMap, sessionId]);

  useEffect(() => {
    try { localStorage.setItem(DONE_KEY, JSON.stringify([...doneIds])); } catch { /* ignore */ }
  }, [doneIds]);

  useEffect(() => {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* ignore */ }
  }, [drafts]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const { repos } = await api.gitAll(); if (live) setGitBadges(new Map(Object.entries(repos))); }
      catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 10000);
    return () => { live = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const u = await api.usage(); if (live) setUsage(u); } catch { /* ignore */ }
      // Same 60s tick: the per-account meters + which agents you can pick from.
      try {
        const a = await api.accounts();
        if (!live) return;
        setAccounts(a.accounts);
        setFreeAgents((a.free_agents?.providers ?? []).filter((p) => p.ready));
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 60000);
    return () => { live = false; clearInterval(id); };
  }, []);

  // ⌘K palette + Escape closes the topmost overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        if (ctxMenu) closeCtx();
        else if (previewProject) setPreviewProject(null);
        else if (toolsFor) setToolsFor(null);
        else if (manageOpen) setManageOpen(false);
        else if (paletteOpen) setPaletteOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (analyzeProject) setAnalyzeProject(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, previewProject, toolsFor, manageOpen, paletteOpen, settingsOpen, analyzeProject]);

  // Right-click context menu — reads data-ctx-* off the target chain.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.("[data-ctxmenu]")) { e.preventDefault(); return; }
      // Text fields keep the real browser menu (spellcheck, undo, paste), and
      // shift+right-click is the usual escape hatch to it everywhere else.
      if (el.closest?.("input, textarea") || e.shiftKey) return;
      e.preventDefault();
      const node = el.closest?.("[data-ctx-type]") as HTMLElement | null;
      if (ctxTimer.current) window.clearTimeout(ctxTimer.current);
      setCtxClosing(false);
      setNativeCtx(nativeCtxItems(e));
      setCtxMenu({
        x: e.clientX, y: e.clientY,
        type: node?.getAttribute("data-ctx-type") || "surface",
        id: node?.getAttribute("data-ctx-id") || "",
        label: node?.getAttribute("data-ctx-label") || "",
      });
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Sends are bound to the session the prompt was written in. The relevance
  // check blocks for ~10s, and you're free to open another session meanwhile —
  // so `sid` (not the open session) decides where the run, the queue fallback,
  // the held card and the optimistic turn all land.
  async function send(
    text: string, images: string[],
    opts?: { force?: boolean; sessionId?: string; project?: string },
  ) {
    const sid = opts?.sessionId ?? sessionId;
    if (!sid) return;
    // `/goal <objective>` sets the session's objective instead of prompting; a
    // bare `/goal` clears it. The loop itself is the bridge's (bridge/goals.py) —
    // this only records what the session is for.
    const goalCmd = /^\/goal\b\s*([\s\S]*)$/.exec(text.trim());
    if (goalCmd) {
      try {
        const { goal } = await api.setGoal(sid, goalCmd[1].trim());
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, goal } : s)));
        notify("info", goal ? `Goal set — ${goal.objective}` : "Goal cleared.");
      } catch (e) {
        notify("error", (e as Error).message);
      }
      return;
    }
    // The prompt's own session decides the project too — `opts.project` covers a
    // session just created, which this render's `sessions` doesn't know about.
    const project = opts?.project
      ?? sessions.find((s) => s.id === sid)?.project
      ?? state?.project?.rel ?? undefined;
    const sessionName = () =>
      sessions.find((s) => s.id === sid)?.title || "another session";
    const enqueue = () => queue.enqueue({
      text, prompt: text, images, project,
      model, effort: effort || undefined, permission_mode: permMode || undefined,
      agent: settings.agent || undefined,
    }, sid);
    // A turn is already in flight for this session — queue the prompt to run
    // after it (and any earlier queued prompts) instead of blocking on STOP.
    if (running && !opts?.sessionId) { enqueue(); return; }
    setCheckingFor(sid, text);
    try {
      const res = await api.run({
        prompt: text, images, project,
        session_id: sid, model, effort: effort || undefined,
        permission_mode: permMode || undefined, ponytail: ponytail || undefined,
        agent: settings.agent || undefined,
        force: opts?.force || undefined,
      });
      // Held: this looks like different work from the session it would resume.
      // Nothing ran — park the prompt on the card and let the user route it.
      if ("suggest_new" in res) {
        setHeldMap((m) => ({
          ...m,
          [sid]: { sid, project, text, images, reason: res.reason, title: res.suggested_title },
        }));
        if (sessionIdRef.current !== sid)
          notify("info", `Held a prompt in “${sessionName()}” — it may be different work.`);
        return;
      }
      setHeldMap((m) => omit(m, sid));
      liveTurns.current.add(res.job_id);
      // Only paint the turn if that session is still the one on screen; if you
      // moved on it belongs to the session you left, and its transcript poll
      // picks it up when you go back.
      if (sessionIdRef.current !== sid) {
        notify("info", `Started in “${sessionName()}” — the session you sent it from.`);
        return;
      }
      stickRef.current = true;      // your own prompt always pulls you back down
      setAtBottom(true);
      setTurns((prev) => [
        ...prev,
        { id: res.job_id, prompt: text, events: [], status: "running", pending: [], attachments: images },
      ]);
    } catch (e) {
      // Lost the race: the run slot filled between our check and the request.
      // Queue it rather than surfacing a "busy" error.
      if ((e as Error).message === "busy") enqueue();
      else notify("error", (e as Error).message);
    } finally {
      setCheckingFor(sid, null);
    }
  }

  function setCheckingFor(sid: string, prompt: string | null) {
    setCheckingMap((m) => (prompt === null ? omit(m, sid) : { ...m, [sid]: prompt }));
  }

  // "Start new session" on the held-prompt card: route it to a fresh session
  // pre-named with the suggested title, forced so the check isn't paid twice.
  async function heldStartNew(h: HeldPrompt) {
    const project = h.project ?? state?.project?.rel;
    if (!project) return;
    setHeldMap((m) => omit(m, h.sid));
    setHeldBusy(true);
    try {
      await startIn(project, h.text,
                    { images: h.images, title: h.title ?? undefined, force: true });
    } finally {
      setHeldBusy(false);
    }
  }

  // Composer text, stored against the session it's being written for (via the
  // ref, so it lands on the session on screen right now and not on a stale one).
  function setDraft(text: string) {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setDrafts((d) => (text ? { ...d, [sid]: text } : omit(d, sid)));
  }

  async function respond(requestId: string, opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] }) {
    if (!active) return;
    try { await api.respond(active.id, { request_id: requestId, ...opts }); } catch { /* poll reconciles */ }
  }
  async function stop() {
    if (!active) return;
    try { await api.interrupt(active.id); } catch { /* poll reconciles */ }
  }

  // A queued task or a GitHub issue carries the project it belongs to. Feeding it
  // into whatever session happens to be open would run it against the wrong repo,
  // so a project that isn't the open session's gets a session of its own and the
  // prompt starts there. No project (self-update errors, suggestions) = inject
  // into the current composer, as before.
  function feed(texts: string[], project?: string) {
    const text = texts.join("\n");
    if (project && project !== sessionProject) {
      void startIn(project, text);
      return;
    }
    setInject((p) => ({ text, nonce: p.nonce + 1 }));
    setView("chat");
  }

  // New session in `project`, then run `prompt` in it. The explicit sessionId is
  // what makes send() reusable here: it otherwise reads sessionId from state,
  // which React has not updated yet for the session we just created.
  async function startIn(
    project: string, prompt: string,
    opts?: { images?: string[]; title?: string; force?: boolean; cwd?: string },
  ) {
    try {
      const { session } = await api.createSession(project, opts?.cwd, opts?.title);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
      setView("chat");
      await send(prompt, opts?.images ?? [],
                 { sessionId: session.id, project, force: opts?.force });
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  // Pull a queued prompt out of a busy session into a fresh one, where it starts
  // immediately instead of waiting behind the current turn. Same project and
  // worktree; the view stays put and the new session shows up in the list.
  async function ejectQueued(itemId: string) {
    if (!sessionProject) return;
    try {
      const { session } = await api.createSession(sessionProject, selected?.cwd ?? undefined);
      setSessions((prev) => [session, ...prev]);
      await queue.move(itemId, session.id);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  async function selectProject(rel: string) {
    try { await api.select(rel); setState(await api.state()); } catch { /* ignore */ }
    const ss = await loadSessions();
    const cur = ss.find((s) => s.project === rel);
    if (cur) openSession(cur.id);
  }

  async function newSession(project: string) {
    try {
      const { session } = await api.createSession(project);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
      setView("chat");
    } catch { /* ignore */ }
  }

  async function worktreeSession(rel: string, branch: string, create: boolean, parent?: string) {
    try {
      const wt = await api.worktreeAdd(rel, branch, parent, create);
      if (!wt.ok) { notify("error", wt.output || "worktree failed"); return; }
      const { session } = await api.createSession(rel, wt.path);
      await loadSessions();
      openSession(session.id);
      setView("chat");
    } catch (e) { notify("error", (e as Error).message); }
  }

  async function createProject(name: string, prompt: string) {
    try {
      const r = await api.createProject(name, prompt);
      await selectProject(r.project.rel);
      await loadSessions();
      if (r.session) openSession(r.session.id);
      setView("chat");
    } catch (e) { notify("error", (e as Error).message); }
  }

  async function openFromHistory(s: EnrichedSession) {
    try { await api.select(s.project); setState(await api.state()); } catch { /* ignore */ }
    await loadSessions();
    openSession(s.id);
    setView("chat");
  }

  function replayBoot() {
    setSettingsOpen(false);
    setShowDashboard(false); setBooting(true);
  }

  // Animated context-menu close (design closeCtxAnim — ctxOut plays, then unmount).
  function closeCtx() {
    if (ctxTimer.current) window.clearTimeout(ctxTimer.current);
    setCtxClosing(true);
    ctxTimer.current = window.setTimeout(() => { setCtxMenu(null); setCtxClosing(false); }, 165);
  }

  // Optimistic locally, then persisted through the bridge (project_config.json)
  // so the choice outlives this browser — the poll would undo a local-only flip.
  function setHidden(rels: string[], hide: boolean) {
    setHiddenProjects((p) => {
      const next = { ...p };
      for (const rel of rels) next[rel] = hide;
      return next;
    });
    void Promise.all(rels.map((rel) =>
      api.setProjectSettings({ project: rel }, { hidden: hide }).catch(() => null),
    )).then(() => refreshProjects());
  }

  // TODO(phase2-data): local-only import — no bridge endpoint to attach a repo yet.
  function importProject(path: string) {
    const rel = path.trim().replace(/\/+$/, "");
    if (!rel) return;
    setImportedProjects((prev) => (prev.includes(rel) ? prev : [...prev, rel]));
    setRemovedProjects((p) => ({ ...p, [rel]: false }));
    setHidden([rel], false);
  }

  // --- derived ---
  const projectGroups = useMemo<ProjectGroup[]>(() => {
    const byProj = new Map<string, SessionBrief[]>();
    for (const s of sessions) {
      const arr = byProj.get(s.project) ?? [];
      arr.push(s);
      byProj.set(s.project, arr);
    }
    if (activeProject && !byProj.has(activeProject)) byProj.set(activeProject, []);
    for (const rel of discovered) if (!byProj.has(rel)) byProj.set(rel, []);
    const groups: ProjectGroup[] = [];
    for (const [rel, ss] of byProj) {
      ss.sort((a, b) => b.updated - a.updated);
      const running = ss.some((s) => {
        const st = statusMap.get(s.id)?.state;
        return st === "working" || st === "awaiting" || st === "live";
      });
      groups.push({
        // Basename only — the PROJECTS panel groups rows under a parent-path
        // header, so the org context lives on the group, not the row.
        rel, name: rel.replace(/\/+$/, "").split("/").pop() || rel,
        badge: gitBadges.get(rel), sessions: ss.slice(0, 3), sessionCount: ss.length, running,
      });
    }
    // Alphabetical by path — a fixed order. Activity sorting reshuffled rows
    // on every session update, and zero-session ties followed Map insertion
    // order, so selecting a project moved it (and others) under the cursor.
    groups.sort((a, b) => a.rel.localeCompare(b.rel));
    return groups;
  }, [sessions, gitBadges, statusMap, activeProject, discovered]);

  // HIDE keeps a project out of the sidebar; REMOVE detaches it (design manage modal).
  const visibleGroups = projectGroups.filter((g) => !hiddenProjects[g.rel] && !removedProjects[g.rel]);
  // …and out of the left session list, whose RECENT tab reads the flat list.
  const visibleSessions = sessions.filter(
    (s) => !hiddenProjects[s.project] && !removedProjects[s.project]);

  // Prompt state the session list flags, so work you left mid-flight is visible
  // from anywhere: a check still running, a card waiting on you, unsent text.
  const promptFlags = useMemo(() => {
    const m = new Map<string, PromptFlag>();
    for (const sid of Object.keys(drafts)) if (drafts[sid].trim()) m.set(sid, "draft");
    for (const sid of Object.keys(heldMap)) m.set(sid, "held");
    for (const sid of Object.keys(checkingMap)) m.set(sid, "checking");
    return m;
  }, [drafts, heldMap, checkingMap]);

  // The open session's working tree — its worktree branch when it has one.
  const sessionProject = selected?.project ?? activeProject;
  const sessionBranch = selected?.branch;

  // Footer git state for that tree. Same 10s cadence as the project badges;
  // clears on switch so the footer never shows the last session's branch.
  useEffect(() => {
    setSessionGit(null);
    if (!sessionProject) return;
    let live = true;
    const tick = async () => {
      try {
        const g = await api.git(sessionProject, sessionBranch || undefined);
        if (live) setSessionGit(g);
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 10000);
    return () => { live = false; clearInterval(id); };
  }, [sessionProject, sessionBranch]);

  const rightTabs: PanelTab[] = [
    {
      id: "projects", label: "Projects", icon: "⊞",
      render: () => (
        <ProjectsPanel
          groups={visibleGroups} activeProject={activeProject}
          onSelectProject={(rel) => void selectProject(rel)}
          onAnalyze={(rel) => openAnalyze(rel)}
          onPreview={(rel) => setPreviewProject(rel)}
          onManage={() => setManageOpen(true)}
          onCreateProject={(name, prompt) => void createProject(name, prompt)}
        />
      ),
    },
    {
      id: "files", label: "Files", icon: "▤", ownScroll: true,
      render: () => (
        <FilesPanel
          project={sessionProject} branch={sessionBranch}
          onOpenFile={openFileFromPanel}
        />
      ),
    },
    {
      id: "changes", label: "Changed files", icon: "◈", ownScroll: true,
      badge: gitBadges.get(sessionProject ?? "")?.dirty ? "●" : null,
      render: () => (
        <FilesPanel
          project={sessionProject} branch={sessionBranch} changedOnly
          onOpenFile={openFileFromPanel}
        />
      ),
    },
    {
      id: "git", label: "Source Control", icon: "⎇",
      badge: gitBadges.get(sessionProject ?? "")?.dirty ? "●" : null,
      render: () => <GitTab project={sessionProject} />,
    },
    {
      id: "skills", label: "Skills", icon: "✦",
      render: () => <SkillsPanel project={sessionProject} />,
    },
    { id: "queue", label: "Queue", icon: "≡", render: () => <TaskQueuePanel projects={projectNames} onFeed={feed} /> },
  ];

  const activeBadge = activeProject ? gitBadges.get(activeProject) : undefined;
  // No usage payload (no token / upstream down long enough that the bridge's
  // last-good copy went stale) reads as unknown — not as a real 0%.
  const fiveHour = usage?.available ? usage.five_hour : null;
  const usedPct = fiveHour ? Math.round(fiveHour.percent) : null;
  const resetLabel = fiveHour ? fmtReset(fiveHour.resets_at) : null;
  const projectNames = useMemo(() => projectGroups.map((g) => g.rel), [projectGroups]);
  // Model picker options — the live list served from /local/state (Models API).
  const modelOpts = useMemo(() => modelOptions(state?.models), [state?.models]);
  // The composer lists one model per family unless settings says otherwise;
  // SettingsModal keeps the full list so it can offer the SHOW ALL switch.
  const composerModels = useMemo(
    () => (settings.allModels ? modelOpts : latestPerFamily(modelOpts, model)),
    [modelOpts, settings.allModels, model],
  );
  // Once the live list loads, snap the selection to an available model (prefer
  // Opus) if the current one isn't offered — the old default was a fixed alias.
  useEffect(() => {
    if (!modelOpts.length || modelOpts.some((m) => m.id === model)) return;
    setModel((modelOpts.find((m) => m.id.includes("opus")) ?? modelOpts[0]).id);
  }, [modelOpts, model]);

  // AGENT picker — which platform runs the turn. Claude logins first (the
  // ambient one leads), then every ready free-agent rung. Option ids are the
  // strings the bridge stores as a turn's runtime, so the picker, the status
  // bar and the transcript badge all name the same thing.
  const agentOpts = useMemo<AgentOption[]>(() => [
    ...accounts.filter((a) => !a.disabled).map((a) => ({
      id: `claude:${a.slot}`,
      short: `A${a.slot} ${(a.email ?? "?").split("@")[0]}`,
      label: `A${a.slot} · ${a.email ?? "unknown"}${a.left === null ? "" : ` · ${a.left}% LEFT`}`,
      free: false, def: a.default, left: a.left,
    })),
    ...freeAgents.map((p) => ({
      id: `opencode:${p.provider}`,
      short: `⚡ ${p.provider.toUpperCase()}`,
      label: `⚡ ${p.provider.toUpperCase()} · ${p.model}`,
      free: true, def: false, left: null,
    })),
  ], [accounts, freeAgents]);
  // "" is the ambient login — resolve it to that account's own id so the picker
  // and the status bar always name someone.
  const agentId = settings.agent || agentOpts.find((o) => o.def)?.id || agentOpts[0]?.id || "";
  const activeAgent = agentOpts.find((o) => o.id === agentId) ?? null;
  const setAgent = (id: string) => patchSettings({ agent: id });
  // A pick that went away (account removed, key cleared) falls back to the
  // default login instead of 400ing on the next send.
  useEffect(() => {
    if (!agentOpts.length || agentOpts.some((o) => o.id === agentId)) return;
    setAgent("");
  }, [agentOpts, agentId]);

  // Switched an extra off while looking at the view it owns: the tab is gone, so
  // sitting there would strand you on a screen with no way back to it. (The MEM
  // and TEACH panel tabs need no guard — RightPanel falls back to its first tab.)
  useEffect(() => {
    if (view === "next" && !ai.nextup) setView("chat");
  }, [view, ai]);

  const commands: Command[] = [
    { id: "new-chat", label: "New chat", group: "Session", icon: "+", run: () => activeProject && void newSession(activeProject) },
    { id: "compact", label: "Compact context (/compact)", group: "Session", icon: "▢", run: () => void send("/compact", []) },
    { id: "view-chat", label: "Go to Chat", group: "View", icon: "▣", run: () => setView("chat") },
    { id: "view-history", label: "Go to History", group: "View", icon: "◷", run: () => setView("history") },
    // Gated exactly like the tabs: an extra that's off has no way in at all.
    ...(ai.nextup
      ? [{ id: "view-next", label: "Go to Next up", group: "View", icon: "◈", run: () => setView("next") }]
      : []),
    { id: "analyze", label: "Analyze active project", group: "Project", icon: "⊞", run: () => activeProject && openAnalyze(activeProject) },
    { id: "right-panel", label: settings.rightOpen ? "Collapse right panel" : "Expand right panel", group: "View", icon: "▥", run: toggleRight },
    { id: "settings", label: "Dashboard settings…", group: "Display", icon: "⚙", run: () => setSettingsOpen(true) },
    { id: "radio", label: radio.radio.playing ? "Pause Claude·FM" : "Play Claude·FM", group: "Audio", icon: "♪", run: () => radio.toggle() },
    ...modelOpts.map((m) => ({
      id: `model-${m.id}`, label: `Use ${m.label}`, group: "Model",
      icon: "⌥", run: () => setModel(m.id),
    })),
  ];

  // Context-menu items per target type.
  // Worktrees of the session the context menu is open on — the relocate targets.
  // Must be declared above ctxItems: that useMemo's callback runs during this
  // render pass and reads relocTargets, so a later `const` would be in its TDZ.
  const [relocTargets, setRelocTargets] = useState<{ branch: string }[]>([]);
  useEffect(() => {
    const proj = ctxMenu?.type === "session"
      ? sessions.find((s) => s.id === ctxMenu.id)?.project : null;
    if (!proj) { setRelocTargets([]); return; }
    let live = true;
    void api.worktrees(proj)
      .then((r) => { if (live) setRelocTargets(r.worktrees.map((w) => ({ branch: w.branch }))); })
      .catch(() => { if (live) setRelocTargets([]); });
    return () => { live = false; };
  }, [ctxMenu, sessions]);

  const ctxItems: CtxItem[] = useMemo(() => {
    if (!ctxMenu) return [];
    const cproj = analyzeProject || activeProject || "";
    // Copy / open link / image act on what was under the cursor, so they lead.
    const items: CtxItem[] = nativeCtx.top.length ? [...nativeCtx.top, { divider: true }] : [];
    const copy = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* ignore */ } };
    if (ctxMenu.type === "session") {
      const s = sessions.find((x) => x.id === ctxMenu.id);
      items.push({ icon: "▸", label: "Attach & resume", onClick: () => s && openSession(s.id) });
      items.push({ icon: "⧉", label: "Copy session name", onClick: () => s && copy(s.title || "session") });
      const pinned = pins.has(ctxMenu.id);
      items.push({ icon: pinned ? "★" : "☆", label: pinned ? "Unpin session" : "Pin session",
        hint: "TOP", onClick: () => togglePin(ctxMenu.id) });
      // Usage-limit fallback policy for this session; the 5s session poll picks
      // up the new value, so the ● marker is fresh next open.
      const pol = s?.fallback_policy ?? null;
      const setPol = (v: string) => { void api.setPolicy(ctxMenu.id, v).then(() => void loadSessions()); };
      items.push({ divider: true });
      items.push({ icon: pol === null || pol === "ask" ? "●" : "○", label: "On limit: ask",
        hint: "offer account/free-agent choices", onClick: () => setPol("ask") });
      items.push({ icon: pol === "auto" ? "●" : "○", label: "On limit: auto-switch",
        hint: "take the best fallback silently", onClick: () => setPol("auto") });
      items.push({ icon: pol === "wait" ? "●" : "○", label: "On limit: wait",
        hint: "only wait for the reset", onClick: () => setPol("wait") });
      const nOff = s?.disabled_tools?.length ?? 0;
      items.push({ icon: "⚒", label: "Tools & MCP…",
        hint: nOff ? `${nOff} switched off` : "all on",
        onClick: () => setToolsFor(ctxMenu.id) });
      items.push({ divider: true });
      items.push({ icon: "⧉", label: "Duplicate session",
        hint: "copy the transcript into a new one",
        onClick: () => void duplicateSession(ctxMenu.id) });
      // One item per worktree of this session's project. A submenu would need a
      // picker; the branches are a short list, so they go straight in.
      for (const wt of relocTargets)
        items.push({ icon: "⇉", label: `Relocate to ${wt.branch}`,
          hint: "rewrites paths so the model never sees the move",
          onClick: () => void relocateSession(ctxMenu.id, s?.project ?? "", wt.branch) });
      items.push({ divider: true });
      // Lifecycle: all three take the session out of the active list, but which
      // one you picked is the difference between "shipped" and "come back to it".
      const lc = s?.lifecycle ?? null;
      items.push({ icon: lc === "done" ? "●" : "○", label: "Mark done",
        hint: "finished — out of the sidebar", onClick: () => void setLifecycle(ctxMenu.id, "done") });
      items.push({ icon: lc === "backlog" ? "●" : "○", label: "Move to backlog",
        hint: "not now, not dead", onClick: () => void setLifecycle(ctxMenu.id, "backlog") });
      items.push({ icon: lc === "abandoned" ? "●" : "○", label: "Abandon", danger: true,
        hint: "gave up on it", onClick: () => void setLifecycle(ctxMenu.id, "abandoned") });
      if (lc !== null)
        items.push({ icon: "↺", label: "Reopen", hint: "back to the active list",
          onClick: () => void setLifecycle(ctxMenu.id, null) });
      items.push({ divider: true });
    } else if (ctxMenu.type === "project") {
      items.push({ icon: "⊞", label: "Analyze project", onClick: () => openAnalyze(ctxMenu.id) });
      items.push({ icon: "◉", label: "Select as active", onClick: () => void selectProject(ctxMenu.id) });
      items.push({ icon: "+", label: "New session here", onClick: () => void newSession(ctxMenu.id) });
      items.push({ icon: "◎", label: "Open issues", onClick: () => openAnalyze(ctxMenu.id) });
      items.push({ divider: true });
    } else if (ctxMenu.type === "issue") {
      items.push({ icon: "▸", label: "Feed to Claude", onClick: () => feed([`Address issue #${ctxMenu.id} in ${cproj}`], cproj) });
      items.push({ icon: "⧉", label: "Copy issue ref", onClick: () => copy(`${cproj}#${ctxMenu.id}`) });
      items.push({ divider: true });
    } else if (ctxMenu.type === "terminal") {
      items.push({ icon: "⊙", label: "Copy session title", onClick: () => copy(selected?.title || "session") });
      items.push({ icon: "↥", label: "Scroll to top", onClick: () => { if (scrollRef.current) scrollRef.current.scrollTop = 0; } });
      items.push({ divider: true });
    } else if (ctxMenu.type === "weather") {
      const other = weather.unit === "F" ? "C" : "F";
      items.push({ icon: "✎", label: "Set city…", onClick: () => setWxSettings((n) => n + 1) });
      items.push({ icon: "°", label: `Use °${other} (${other === "F" ? "Fahrenheit" : "Celsius"})`, onClick: () => void setUnit(other === "F" ? "fahrenheit" : "celsius") });
      items.push({ divider: true });
    }
    items.push({ icon: "⊕", label: "Command palette", hint: "⌘K", onClick: () => setPaletteOpen(true) });
    items.push({ icon: "♪", label: "Toggle Claude·FM", onClick: () => radio.toggle() });
    items.push({ icon: "⚙", label: "Dashboard settings", onClick: () => setSettingsOpen(true) });
    items.push({ icon: "↻", label: "Replay boot", onClick: () => replayBoot() });
    items.push({ divider: true }, ...nativeCtx.page);
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, nativeCtx, sessions, pins, analyzeProject, activeProject, selected, radio, weather, setUnit, relocTargets]);

  async function duplicateSession(id: string) {
    try {
      const { session } = await api.duplicateSession(id);
      await loadSessions();
      setSessionId(session.id);          // land in the copy, not the original
      notify("info", `Duplicated — “${session.title ?? "session"}”`);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  async function relocateSession(id: string, project: string, branch: string) {
    try {
      const r = await api.relocateSession(id, project, branch);
      await loadSessions();
      notify("info", `Moved to ${branch} — ${r.rewritten} rows rewritten.`);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  /** Tools/MCP servers this session may not touch. Optimistic — the switch flips
   *  now and the 5s session poll confirms. Takes effect on the next turn. */
  function setSessionToolsFor(id: string, rules: string[]) {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, disabled_tools: rules } : s)));
    void api.setSessionTools(id, rules).then(() => void loadSessions()).catch(() => void loadSessions());
  }
  const setSessionTools = (rules: string[]) => {
    if (sessionId) setSessionToolsFor(sessionId, rules);
  };

  async function setLifecycle(id: string, state: Lifecycle | null) {
    try {
      await api.setLifecycle(id, state);
      // Only let go of the session if it just left the active list.
      if (state !== null && sessionId === id) setSessionId(null);
      await loadSessions();
    } catch { /* ignore */ }
  }

  if (AUTH_REQUIRED && !TOKEN) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Missing token. Open the dashboard via the URL the bridge printed (it includes
        <span className="font-mono"> ?token=…</span>).
      </div>
    );
  }

  const td = themeDef(settings.theme);
  const wsRoot = (activeProject || "/").replace(/\/[^/]*$/, "") || "/";

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--panel3)", position: "relative" }}>
      {settings.scanlines && <div className="crt" />}
      {settings.sweep && <div className="sweep" />}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: -1, background: td.bg, transition: "background .5s ease" }} />

      {showDashboard && (
        // ONE themed container: colour comes from the CSS filter, shape from
        // data-theme, ground/voice from canvas/font. Every surface — panels
        // and all modals below — inherits all three.
        <div
          data-theme={settings.theme}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            zoom: uiScale,
            filter: themeFilter(settings.theme),
            background: themeCanvas(settings.theme),
            fontFamily: themeFont(settings.theme) || undefined,
            ...themeVars(settings.theme),
          } as CSSProperties}
        >
            <Strip
              radio={radio.radio}
              onToggleRadio={radio.toggle}
              onNextRadio={radio.next}
              onOpenSettings={() => setSettingsOpen(true)}
              clock={tele.clock}
              weather={weather}
              onSetCity={setCity}
              onSetUnit={setUnit}
              openSettings={wxSettings}
              onFeed={feed}
            />

            <div
              className="grid min-h-0 flex-1 gap-[13px] p-[13px]"
              style={{ gridTemplateColumns: `360px minmax(0,1fr) ${settings.rightOpen ? "372px" : "30px"}`, minWidth: 0 }}
            >
              {/* LEFT — no scroller here: SessionsPanel owns the only scroll. */}
              <div className="flex min-h-0 min-w-0 flex-col gap-[13px] pr-0.5">
                <SessionsPanel
                  sessions={visibleSessions} groups={visibleGroups} status={statusMap} done={doneIds}
                  flags={promptFlags} pins={pins}
                  selectedSessionId={sessionId} loadingSessionId={loadingSession ? sessionId : null}
                  activeProject={activeProject}
                  onTogglePin={togglePin}
                  onSelectSession={(s) => void selectSession(s)}
                  onAnalyze={(rel) => openAnalyze(rel)}
                  onNewSession={(rel) => void newSession(rel)}
                  onWorktreeSession={(rel, branch, create, parent) => void worktreeSession(rel, branch, create, parent)}
                />
              </div>

              {/* CENTER */}
              <Terminal
                view={view} onView={setView} selected={selected} sessionId={sessionId} activeProject={activeProject}
                branch={selected?.branch} model={model} turnCount={turns.length} turns={turns}
                activeId={active?.id ?? null} onRespond={(rid, o) => void respond(rid, o)}
                scrollRef={scrollRef} contentRef={contentRef}
                atBottom={atBottom} onJumpBottom={jumpToBottom}
                onOpenFromHistory={(s) => void openFromHistory(s)}
                onStartNext={(it) => void startIn(it.project, it.prompt,
                  { title: it.title, cwd: it.cwd, force: true })}
                liveTurns={liveTurns.current}
                trailingWorking={openWorking && !running} loading={loadingSession} hud={settings}
                onRunCommand={runCommand}
                composer={
                  <>
                    {checking !== undefined && <CheckingBanner prompt={checking} />}
                    {held && (
                      <SuggestNewSessionCard
                        currentTitle={selected?.title ?? ""}
                        reason={held.reason}
                        suggestedTitle={held.title}
                        busy={heldBusy}
                        onStartNew={() => void heldStartNew(held)}
                        onContinue={() => {
                          setHeldMap((m) => omit(m, held.sid));
                          void send(held.text, held.images, { force: true, sessionId: held.sid });
                        }}
                        onDismiss={() => { feed([held.text]); setHeldMap((m) => omit(m, held.sid)); }}
                      />
                    )}
                    <AgentsPill sessionId={sessionId} running={running} />
                    <GoalPill
                      goal={sessions.find((s) => s.id === sessionId)?.goal}
                      onClear={() => void send("/goal", [])}
                    />
                    <Composer
                      disabled={!sessionId || pendingCount > 0} running={running} model={model} models={composerModels} effort={effort}
                      agent={agentId} agents={agentOpts} onAgent={setAgent}
                      injectedText={inject.text} injectNonce={inject.nonce} sessionId={sessionId}
                      draft={draft} onDraft={setDraft}
                      contextTokens={contextTokens} onModel={setModel} onEffort={setEffort}
                      perm={permMode} onPerm={setPermMode} ponytail={ponytail} onPonytail={setPonytail}
                      showPonytail={settings.ponytailUi}
                      onSend={(t, i) => void send(t, i)} onStop={() => void stop()}
                      onSteer={(t) => void queue.steer(t).then((ok) => { if (!ok) void send(t, []); })}
                      onCompact={() => void send("/compact", [])}
                      queued={queue.queued.map((q) => ({ id: q.id, text: q.text }))}
                      onCancelQueued={(id) => queue.remove(id)}
                      onEjectQueued={(id) => void ejectQueued(id)}
                      project={sessionProject}
                      onOpenMap={settings.graphUi && sessionProject ? () => openAnalyze(sessionProject, undefined, "map") : undefined}
                    />
                  </>
                }
              />

              {/* RIGHT — activity bar of icons; clicking the active one collapses
                  the body and unmounts the panel (which stops its polling). */}
              <RightPanel
                tabs={rightTabs} activeId={settings.rightTab}
                open={settings.rightOpen} onTab={pickRightTab}
              />
            </div>

            <StatusBar
              mount={wsRoot} usedPct={usedPct} resetLabel={resetLabel} accounts={accounts}
              agent={activeAgent}
              // The footer reports the session you have open, not the bridge's
              // active project — those differ while you read another session.
              repo={sessionProject ?? "—"} git={sessionGit}
              changes={sessionGit?.dirty ?? activeBadge?.dirty ?? 0}
              onPalette={() => setPaletteOpen(true)}
              agents={agentOpts} onPickAgent={setAgent}
            />

            {analyzeProject && (
              <AnalyzeModal
                // The file is part of the key so a second deep-link (same
                // project, different file) remounts on that file.
                key={`${analyzeProject}:${analyzeFile?.path ?? ""}:${analyzeTab ?? ""}:${analyzeCommand ?? ""}`}
                project={analyzeProject} badge={gitBadges.get(analyzeProject)}
                initialFile={analyzeFile?.path} initialBranch={analyzeFile?.branch}
                initialTab={analyzeTab} initialCommand={analyzeCommand}
                sessions={sessions.filter((s) => s.project === analyzeProject)} status={statusMap}
                onClose={() => setAnalyzeProject(null)} onFeed={feed}
                onSelectSession={(s) => { void selectSession(s); setAnalyzeProject(null); setView("chat"); }}
                onWorktreeSession={(rel, branch, create, parent) => { void worktreeSession(rel, branch, create, parent); setAnalyzeProject(null); }}
              />
            )}
            <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
            {previewProject && (
              <ProjectPreviewModal
                project={previewProject}
                onClose={() => setPreviewProject(null)}
              />
            )}
            {manageOpen && (
              <ManageProjectsModal
                groups={projectGroups.filter((g) => !removedProjects[g.rel])}
                imported={importedProjects.filter((rel) => !removedProjects[rel])}
                hidden={hiddenProjects}
                onSetHidden={setHidden}
                onRemove={(rel) => {
                  setRemovedProjects((p) => ({ ...p, [rel]: true }));
                  setPreviewProject((cur) => (cur === rel ? null : cur));
                }}
                onImport={importProject}
                onClose={() => setManageOpen(false)}
              />
            )}
            {toolsFor && (
              <ToolsModal
                title={sessions.find((s) => s.id === toolsFor)?.title || "session"}
                disabled={sessions.find((s) => s.id === toolsFor)?.disabled_tools ?? []}
                onChange={(rules) => setSessionToolsFor(toolsFor, rules)}
                onClose={() => setToolsFor(null)}
              />
            )}
            {settingsOpen && (
              <SettingsModal host={host.host} port={location.port || "8790"}
                settings={settings} onTheme={setTheme} onToggle={toggleCrt} onPatch={patchSettings}
                models={modelOpts} weather={weather} onSetCity={setCity} onSetUnit={setUnit}
                station={radio.station} onStation={radio.setStation} onFeed={feed}
                sessionTools={selected?.disabled_tools ?? []}
                onSessionTools={setSessionTools}
                onReplayBoot={replayBoot} onClose={() => setSettingsOpen(false)} />
            )}
            {ctxMenu && <ContextMenu ctx={ctxMenu} items={ctxItems} closing={ctxClosing} onClose={closeCtx} />}
        </div>
      )}

      {booting && (
        <BootIntro theme={settings.theme} scanlines={settings.scanlines} onReveal={() => setShowDashboard(true)} onDone={() => { setShowDashboard(true); setBooting(false); }} />
      )}
    </div>
  );
}
