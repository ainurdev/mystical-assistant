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
  type ModelId,
  type SessionBrief,
  type SessionStatus,
  type UsageInfo,
} from "./api";
import { modelOptions, latestPerFamily } from "./models";
import { activeOf, estimateContextTokens, mergeDelta, type Turn } from "./chat";
import { useTelemetry } from "./lib/telemetry";
import { ago, useProjectTints } from "./lib/surfaces";
import {
  autoTextScale,
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
import { Composer } from "./components/Composer";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Strip } from "./components/hud/Strip";
import { StatusBar } from "./components/hud/StatusBar";
import { TaskQueuePanel } from "./components/hud/TaskQueuePanel";
import { ProjectsPanel, type ProjectGroup } from "./components/hud/ProjectsPanel";
import { FilesPanel } from "./components/hud/FilesPanel";
import { SkillsPanel } from "./components/hud/SkillsTab";
import { RightPanel, type PanelTab } from "./components/RightPanel";
import { SessionsPanel } from "./components/hud/SessionsPanel";
import { Terminal } from "./components/hud/Terminal";
import { notify } from "./components/hud/Notifications";
import { BootIntro } from "./components/hud/BootIntro";
import { SettingsModal } from "./components/hud/SettingsModal";
import { ContextMenu, type CtxItem, type CtxState } from "./components/hud/ContextMenu";
import { AnalyzeModal } from "./components/hud/AnalyzeModal";
import { ManageProjectsModal } from "./components/hud/ManageProjectsModal";
import { ProjectPreviewModal } from "./components/hud/ProjectPreviewModal";
import { AgentsPill } from "./components/AgentsPill";
import { usePreviewQueue } from "./components/design/usePreviewQueue";


function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}H${String(m).padStart(2, "0")}M`;
}

// Manage-projects choices survive a reload / bridge restart.
// ponytail: localStorage = per-browser, like every other HUD pref (see
// lib/surfaces.ts); move to a bridge endpoint if cross-device sync matters.
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

export function App() {
  useProjectTints(); // re-render on saved project tag/colour edits
  const [state, setState] = useState<DashState | null>(null);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false); // true from select until its transcript first resolves
  const [turns, setTurns] = useState<Turn[]>([]);
  const [view, setView] = useState<"chat" | "history" | "memory">("chat");
  const [statusMap, setStatusMap] = useState<Map<string, SessionStatus>>(new Map());
  const [doneIds, setDoneIds] = useState<Set<string>>(loadDone);
  const [gitBadges, setGitBadges] = useState<Map<string, GitBadge>>(new Map());
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [inject, setInject] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // ?skipboot bypasses the intro (handy on revisits + for screenshots).
  const skipBoot = new URLSearchParams(location.search).has("skipboot");
  const [booting, setBooting] = useState(!skipBoot);
  const [showDashboard, setShowDashboard] = useState(skipBoot);
  const [manageOpen, setManageOpen] = useState(false);
  const [previewProject, setPreviewProject] = useState<string | null>(null);
  // Manage-projects bookkeeping. TODO(phase2-data): the bridge has no
  // hide/remove/import endpoints, so the choices persist client-side.
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
  const [ctxMenu, setCtxMenu] = useState<CtxState | null>(null);
  // The browser items we took away by preventDefault()-ing, rebuilt per open.
  const [nativeCtx, setNativeCtx] = useState<{ top: CtxItem[]; page: CtxItem[] }>({ top: [], page: [] });
  const [ctxClosing, setCtxClosing] = useState(false);
  const ctxTimer = useRef<number | null>(null);

  const seqRef = useRef(0);
  const liveTurns = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

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
  // except within a family (AURORA's colours, CLAUDE's light/dark), which is one
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
  function openAnalyze(rel: string, file?: { path: string; branch?: string }) {
    setAnalyzeFile(file ?? null);
    setAnalyzeProject(rel);
  }

  function openSession(id: string) {
    seqRef.current = 0;
    stickRef.current = true;
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
    try { const p = await api.projects(); setDiscovered(p.projects ?? []); }
    catch { /* old backend without discovery — panel stays session-derived */ }
  }, []);
  useEffect(() => {
    void refreshProjects();
    const id = setInterval(refreshProjects, 10000);
    return () => clearInterval(id);
  }, [refreshProjects]);

  const loadSessions = useCallback(async () => {
    try { const { sessions: list } = await api.sessions(); setSessions(list); return list; }
    catch { return [] as SessionBrief[]; }
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
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => { if (stickRef.current) el.scrollTop = el.scrollHeight; });
    ro.observe(content);
    if (stickRef.current) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => { el.removeEventListener("scroll", onScroll); ro.disconnect(); };
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
        else if (manageOpen) setManageOpen(false);
        else if (paletteOpen) setPaletteOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (analyzeProject) setAnalyzeProject(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, previewProject, manageOpen, paletteOpen, settingsOpen, analyzeProject]);

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

  async function send(text: string, images: string[]) {
    if (!sessionId) return;
    const project = selected?.project ?? state?.project?.rel ?? undefined;
    const enqueue = () => queue.enqueue({
      text, prompt: text, images, project,
      model, effort: effort || undefined, permission_mode: permMode || undefined,
    });
    // A turn is already in flight for this session — queue the prompt to run
    // after it (and any earlier queued prompts) instead of blocking on STOP.
    if (running) { enqueue(); return; }
    try {
      const res = await api.run({
        prompt: text, images, project,
        session_id: sessionId, model, effort: effort || undefined,
        permission_mode: permMode || undefined, ponytail: ponytail || undefined,
      });
      liveTurns.current.add(res.job_id);
      stickRef.current = true;
      setTurns((prev) => [
        ...prev,
        { id: res.job_id, prompt: text, events: [], status: "running", pending: [], attachments: images },
      ]);
    } catch (e) {
      // Lost the race: the run slot filled between our check and the request.
      // Queue it rather than surfacing a "busy" error.
      if ((e as Error).message === "busy") enqueue();
      else notify("error", (e as Error).message);
    }
  }

  async function respond(requestId: string, opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] }) {
    if (!active) return;
    try { await api.respond(active.id, { request_id: requestId, ...opts }); } catch { /* poll reconciles */ }
  }
  async function stop() {
    if (!active) return;
    try { await api.interrupt(active.id); } catch { /* poll reconciles */ }
  }

  // The continuous poll picks up the resulting `review_resolved` event on its own,
  // so no manual state update / invalidation is needed here.
  const onReviewResolve = (itemId: string, action: "keep" | "skip") => {
    void api.learningItem(itemId, action);
  };

  function feed(texts: string[]) {
    const text = texts.join("\n");
    setInject((p) => ({ text, nonce: p.nonce + 1 }));
    setView("chat");
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

  // TODO(phase2-data): local-only import — no bridge endpoint to attach a repo yet.
  function importProject(path: string) {
    const rel = path.trim().replace(/\/+$/, "");
    if (!rel) return;
    setImportedProjects((prev) => (prev.includes(rel) ? prev : [...prev, rel]));
    setRemovedProjects((p) => ({ ...p, [rel]: false }));
    setHiddenProjects((p) => ({ ...p, [rel]: false }));
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

  // The open session's working tree — its worktree branch when it has one.
  const sessionProject = selected?.project ?? activeProject;
  const sessionBranch = selected?.branch;

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
      id: "files", label: "Files", icon: "▤",
      render: () => (
        <FilesPanel
          project={sessionProject} branch={sessionBranch}
          onOpenFile={(path) => sessionProject && openAnalyze(sessionProject, { path, branch: sessionBranch })}
        />
      ),
    },
    {
      id: "skills", label: "Skills", icon: "✦",
      render: () => <SkillsPanel project={sessionProject} />,
    },
    { id: "queue", label: "Queue", icon: "≡", render: () => <TaskQueuePanel projects={projectNames} onFeed={feed} /> },
  ];

  const activeBadge = activeProject ? gitBadges.get(activeProject) : undefined;
  const usedPct = Math.round(usage?.five_hour?.percent ?? 0);
  const resetLabel = fmtReset(usage?.five_hour?.resets_at);
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

  const commands: Command[] = [
    { id: "new-chat", label: "New chat", group: "Session", icon: "+", run: () => activeProject && void newSession(activeProject) },
    { id: "compact", label: "Compact context (/compact)", group: "Session", icon: "▢", run: () => void send("/compact", []) },
    { id: "view-chat", label: "Go to Chat", group: "View", icon: "▣", run: () => setView("chat") },
    { id: "view-history", label: "Go to History", group: "View", icon: "◷", run: () => setView("history") },
    { id: "view-memory", label: "Go to Memory", group: "View", icon: "◆", run: () => setView("memory") },
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
      items.push({ icon: "⌫", label: "Archive session", danger: true, onClick: () => void archiveSession(ctxMenu.id) });
      items.push({ divider: true });
    } else if (ctxMenu.type === "project") {
      items.push({ icon: "⊞", label: "Analyze project", onClick: () => openAnalyze(ctxMenu.id) });
      items.push({ icon: "◉", label: "Select as active", onClick: () => void selectProject(ctxMenu.id) });
      items.push({ icon: "+", label: "New session here", onClick: () => void newSession(ctxMenu.id) });
      items.push({ icon: "◎", label: "Open issues", onClick: () => openAnalyze(ctxMenu.id) });
      items.push({ divider: true });
    } else if (ctxMenu.type === "issue") {
      items.push({ icon: "▸", label: "Feed to Claude", onClick: () => feed([`Address issue #${ctxMenu.id} in ${cproj}`]) });
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
  }, [ctxMenu, nativeCtx, sessions, analyzeProject, activeProject, selected, radio, weather, setUnit]);

  async function archiveSession(id: string) {
    try {
      await api.archiveSession(id);
      if (sessionId === id) setSessionId(null);
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
              {/* LEFT */}
              <div className="mscroll flex min-h-0 min-w-0 flex-col gap-[13px] pr-0.5">
                <SessionsPanel
                  sessions={sessions} groups={projectGroups} status={statusMap} done={doneIds}
                  selectedSessionId={sessionId} loadingSessionId={loadingSession ? sessionId : null}
                  activeProject={activeProject}
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
                activeId={active?.id ?? null} onRespond={(rid, o) => void respond(rid, o)} onReviewResolve={onReviewResolve}
                scrollRef={scrollRef} contentRef={contentRef}
                onSuggestPick={(t) => feed([t])}
                onOpenFromHistory={(s) => void openFromHistory(s)} liveTurns={liveTurns.current}
                trailingWorking={openWorking && !running} loading={loadingSession} hud={settings}
                composer={
                  <>
                    <AgentsPill sessionId={sessionId} running={running} />
                    <Composer
                      disabled={!sessionId || pendingCount > 0} running={running} model={model} models={composerModels} effort={effort}
                      injectedText={inject.text} injectNonce={inject.nonce} sessionId={sessionId}
                      contextTokens={contextTokens} resetLabel={resetLabel} onModel={setModel} onEffort={setEffort}
                      perm={permMode} onPerm={setPermMode} ponytail={ponytail} onPonytail={setPonytail}
                      onSend={(t, i) => void send(t, i)} onStop={() => void stop()}
                      onCompact={() => void send("/compact", [])}
                      queued={queue.queued.map((q) => ({ id: q.id, text: q.text }))}
                      onCancelQueued={(id) => queue.remove(id)}
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
              mount={wsRoot} usedPct={usedPct} repo={activeProject ?? "—"}
              changes={activeBadge?.dirty ?? 0} onPalette={() => setPaletteOpen(true)}
            />

            {analyzeProject && (
              <AnalyzeModal
                // The file is part of the key so a second deep-link (same
                // project, different file) remounts on that file.
                key={`${analyzeProject}:${analyzeFile?.path ?? ""}`}
                project={analyzeProject} badge={gitBadges.get(analyzeProject)}
                initialFile={analyzeFile?.path} initialBranch={analyzeFile?.branch}
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
                sessionId={sessionId}
                onClose={() => setPreviewProject(null)}
              />
            )}
            {manageOpen && (
              <ManageProjectsModal
                groups={projectGroups.filter((g) => !removedProjects[g.rel])}
                imported={importedProjects.filter((rel) => !removedProjects[rel])}
                hidden={hiddenProjects}
                onSetHidden={(rels, hide) => setHiddenProjects((p) => {
                  const next = { ...p };
                  for (const rel of rels) next[rel] = hide;
                  return next;
                })}
                onRemove={(rel) => {
                  setRemovedProjects((p) => ({ ...p, [rel]: true }));
                  setPreviewProject((cur) => (cur === rel ? null : cur));
                }}
                onImport={importProject}
                onClose={() => setManageOpen(false)}
              />
            )}
            {settingsOpen && (
              <SettingsModal host={host.host} port={location.port || "8790"}
                settings={settings} onTheme={setTheme} onToggle={toggleCrt} onPatch={patchSettings}
                models={modelOpts} weather={weather} onSetCity={setCity} onSetUnit={setUnit}
                station={radio.station} onStation={radio.setStation} onFeed={feed}
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
