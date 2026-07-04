import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  api,
  AUTH_REQUIRED,
  logStream,
  TOKEN,
  type AnswerSelection,
  type DashState,
  type EffortLevel,
  type EnrichedSession,
  type GitBadge,
  type ModelId,
  type RunningJob,
  type RunningSession,
  type SessionBrief,
  type SessionStatus,
  type UsageInfo,
} from "./api";
import { activeOf, estimateContextTokens, mergeDelta, type Turn } from "./chat";
import { useTelemetry } from "./lib/telemetry";
import { ago } from "./lib/surfaces";
import {
  loadSettings,
  saveSettings,
  themeCanvas,
  themeDef,
  themeFilter,
  themeFont,
  themeVars,
  THEME_TOKEN_KEYS,
  type HudSettings,
  type ThemeKey,
} from "./lib/theme";
import { useHostVitals, useRadio, useWeather } from "./lib/ambient";
import { Composer } from "./components/Composer";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Strip } from "./components/hud/Strip";
import { StatusBar } from "./components/hud/StatusBar";
import { TaskQueuePanel } from "./components/hud/TaskQueuePanel";
import { ProjectsPanel, type ProjectGroup } from "./components/hud/ProjectsPanel";
import { SessionsPanel } from "./components/hud/SessionsPanel";
import { Terminal } from "./components/hud/Terminal";
import { BootIntro } from "./components/hud/BootIntro";
import { ThemeModal } from "./components/hud/ThemeModal";
import { SettingsModal } from "./components/hud/SettingsModal";
import { ContextMenu, type CtxItem, type CtxState } from "./components/hud/ContextMenu";
import { AnalyzeModal } from "./components/hud/AnalyzeModal";
import { ManageProjectsModal } from "./components/hud/ManageProjectsModal";
import { RunningWindow } from "./components/design/RunningWindow";
import { AgentsPill } from "./components/AgentsPill";
import { usePreviewQueue } from "./components/design/usePreviewQueue";

type PermDefault = "plan" | "acceptEdits" | "auto";

function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}H${String(m).padStart(2, "0")}M`;
}

export function App() {
  const [state, setState] = useState<DashState | null>(null);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false); // true from select until its transcript first resolves
  const [turns, setTurns] = useState<Turn[]>([]);
  const [, setLogs] = useState<string[]>([]);
  const [model, setModel] = useState<ModelId>("opus");
  const [effort, setEffort] = useState<EffortLevel | "">("");
  const [permMode, setPermMode] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "history" | "memory">("chat");
  const [external, setExternal] = useState<RunningSession[]>([]);
  const [jobs, setJobs] = useState<RunningJob[]>([]);
  const [statusMap, setStatusMap] = useState<Map<string, SessionStatus>>(new Map());
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
  // Manage-projects bookkeeping. TODO(phase2-data): session-local only — the
  // bridge has no hide/remove/import endpoints yet.
  const [hiddenProjects, setHiddenProjects] = useState<Record<string, boolean>>({});
  const [removedProjects, setRemovedProjects] = useState<Record<string, boolean>>({});
  const [importedProjects, setImportedProjects] = useState<string[]>([]);

  // HUD chrome state.
  const [settings, setSettings] = useState<HudSettings>(() => loadSettings());
  const [themeOpen, setThemeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [analyzeProject, setAnalyzeProject] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxState | null>(null);
  const [ctxClosing, setCtxClosing] = useState(false);
  const ctxTimer = useRef<number | null>(null);
  const [defMode, setDefMode] = useState<PermDefault>("acceptEdits");

  const seqRef = useRef(0);
  const liveTurns = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Ambient widgets.
  const host = useHostVitals();
  const { weather, setCity, setUnit } = useWeather();
  const [wxSettings, setWxSettings] = useState(0); // nonce — opens the weather settings editor from the context menu
  const radio = useRadio();
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

  // Picking a theme also applies its default CRT toggles (design onPick).
  function setTheme(t: ThemeKey) {
    const d = themeDef(t);
    setSettings((s) => ({ ...s, theme: t, scanlines: d.crt, sweep: d.swp, glow: d.glw }));
  }
  function toggleCrt(key: "scanlines" | "sweep" | "glow") {
    setSettings((s) => ({ ...s, [key]: !s[key] }));
  }

  function openSession(id: string) {
    seqRef.current = 0;
    stickRef.current = true;
    setTurns([]);
    setLoadingSession(true);
    setSessionId(id);
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
    const tick = async () => {
      try {
        const t = await api.transcript(sessionId, seqRef.current);
        if (!live) return;
        setTurns((prev) => mergeDelta(prev, t));
        seqRef.current = t.next_cursor;
      } catch { /* ignore */ }
      finally { if (live) setLoadingSession(false); }
    };
    void tick();
    const id = setInterval(tick, 1500);
    return () => { live = false; clearInterval(id); };
  }, [sessionId]);

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

  useEffect(() => logStream((line) => setLogs((prev) => [...prev.slice(-2000), line])), []);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running();
        if (!live) return;
        setExternal(r.external);
        setJobs(r.jobs ?? []);
        setStatusMap(new Map(Object.entries(r.status ?? {})));
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => { live = false; clearInterval(id); };
  }, []);

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
        else if (themeOpen) setThemeOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (analyzeProject) setAnalyzeProject(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, previewProject, manageOpen, paletteOpen, themeOpen, settingsOpen, analyzeProject]);

  // Right-click context menu — reads data-ctx-* off the target chain.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.("[data-ctxmenu]")) { e.preventDefault(); return; }
      if (el.closest?.("input, textarea")) return;
      e.preventDefault();
      const node = el.closest?.("[data-ctx-type]") as HTMLElement | null;
      if (ctxTimer.current) window.clearTimeout(ctxTimer.current);
      setCtxClosing(false);
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
    setError(null);
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
        permission_mode: permMode || undefined,
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
      else setError((e as Error).message);
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
      if (!wt.ok) { setError(wt.output || "worktree failed"); return; }
      const { session } = await api.createSession(rel, wt.path);
      await loadSessions();
      openSession(session.id);
      setView("chat");
    } catch (e) { setError((e as Error).message); }
  }

  async function createProject(name: string, prompt: string) {
    try {
      const r = await api.createProject(name, prompt);
      await selectProject(r.project.rel);
      await loadSessions();
      if (r.session) openSession(r.session.id);
      setView("chat");
    } catch (e) { setError((e as Error).message); }
  }

  async function openFromHistory(s: EnrichedSession) {
    try { await api.select(s.project); setState(await api.state()); } catch { /* ignore */ }
    await loadSessions();
    openSession(s.id);
    setView("chat");
  }

  function replayBoot() {
    setThemeOpen(false); setSettingsOpen(false);
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
    const groups: ProjectGroup[] = [];
    for (const [rel, ss] of byProj) {
      ss.sort((a, b) => b.updated - a.updated);
      const running = ss.some((s) => {
        const st = statusMap.get(s.id)?.state;
        return st === "working" || st === "awaiting" || st === "live";
      });
      groups.push({
        rel, name: rel.replace(/\/+$/, "").split("/").pop() || rel,
        badge: gitBadges.get(rel), sessions: ss.slice(0, 3), sessionCount: ss.length, running,
      });
    }
    // Order by most-recent session activity. We deliberately do NOT pin the
    // active project to the top — selecting a project should highlight it in
    // place, not yank it to position 0 under the cursor.
    groups.sort((a, b) => {
      const am = a.sessions[0]?.updated ?? 0;
      const bm = b.sessions[0]?.updated ?? 0;
      return bm - am;
    });
    return groups;
  }, [sessions, gitBadges, statusMap, activeProject]);

  // HIDE keeps a project out of the sidebar; REMOVE detaches it (design manage modal).
  const visibleGroups = projectGroups.filter((g) => !hiddenProjects[g.rel] && !removedProjects[g.rel]);

  const activeBadge = activeProject ? gitBadges.get(activeProject) : undefined;
  const usedPct = Math.round(usage?.five_hour?.percent ?? 0);
  const resetLabel = fmtReset(usage?.five_hour?.resets_at);
  const projectNames = useMemo(() => projectGroups.map((g) => g.rel), [projectGroups]);

  const commands: Command[] = [
    { id: "new-chat", label: "New chat", group: "Session", icon: "+", run: () => activeProject && void newSession(activeProject) },
    { id: "compact", label: "Compact context (/compact)", group: "Session", icon: "▢", run: () => void send("/compact", []) },
    { id: "view-chat", label: "Go to Chat", group: "View", icon: "▣", run: () => setView("chat") },
    { id: "view-history", label: "Go to History", group: "View", icon: "◷", run: () => setView("history") },
    { id: "view-memory", label: "Go to Memory", group: "View", icon: "◆", run: () => setView("memory") },
    { id: "analyze", label: "Analyze active project", group: "Project", icon: "⊞", run: () => activeProject && setAnalyzeProject(activeProject) },
    { id: "theme", label: "Theme & CRT…", group: "Display", icon: "◐", run: () => setThemeOpen(true) },
    { id: "settings", label: "Dashboard settings…", group: "Display", icon: "⚙", run: () => setSettingsOpen(true) },
    { id: "radio", label: radio.radio.playing ? "Pause Claude·FM" : "Play Claude·FM", group: "Audio", icon: "♪", run: () => radio.toggle() },
    { id: "model-fable", label: "Use Fable", group: "Model", icon: "⌥", run: () => setModel("fable") },
    { id: "model-opus", label: "Use Opus", group: "Model", icon: "⌥", run: () => setModel("opus") },
    { id: "model-sonnet", label: "Use Sonnet", group: "Model", icon: "⌥", run: () => setModel("sonnet") },
    { id: "model-haiku", label: "Use Haiku", group: "Model", icon: "⌥", run: () => setModel("haiku") },
  ];

  // Context-menu items per target type.
  const ctxItems: CtxItem[] = useMemo(() => {
    if (!ctxMenu) return [];
    const cproj = analyzeProject || activeProject || "";
    const items: CtxItem[] = [];
    const copy = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* ignore */ } };
    if (ctxMenu.type === "session") {
      const s = sessions.find((x) => x.id === ctxMenu.id);
      items.push({ icon: "▸", label: "Attach & resume", onClick: () => s && openSession(s.id) });
      items.push({ icon: "⧉", label: "Copy session name", onClick: () => s && copy(s.title || "session") });
      items.push({ icon: "⌫", label: "Archive session", danger: true, onClick: () => void archiveSession(ctxMenu.id) });
      items.push({ divider: true });
    } else if (ctxMenu.type === "project") {
      items.push({ icon: "⊞", label: "Analyze project", onClick: () => setAnalyzeProject(ctxMenu.id) });
      items.push({ icon: "◉", label: "Select as active", onClick: () => void selectProject(ctxMenu.id) });
      items.push({ icon: "+", label: "New session here", onClick: () => void newSession(ctxMenu.id) });
      items.push({ icon: "◎", label: "Open issues", onClick: () => setAnalyzeProject(ctxMenu.id) });
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
    items.push({ icon: "◐", label: "Theme & CRT", onClick: () => setThemeOpen(true) });
    items.push({ icon: "⚙", label: "Dashboard settings", onClick: () => setSettingsOpen(true) });
    items.push({ icon: "↻", label: "Replay boot", onClick: () => replayBoot() });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, sessions, analyzeProject, activeProject, selected, radio, weather, setUnit]);

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
            />

            <div className="grid min-h-0 flex-1 gap-[13px] p-[13px]" style={{ gridTemplateColumns: "360px minmax(0,1fr) 358px", minWidth: 0 }}>
              {/* LEFT */}
              <div className="mscroll flex min-h-0 min-w-0 flex-col gap-[13px] pr-0.5">
                <SessionsPanel
                  sessions={sessions} groups={projectGroups} status={statusMap}
                  selectedSessionId={sessionId} loadingSessionId={loadingSession ? sessionId : null}
                  activeProject={activeProject}
                  onSelectSession={(s) => void selectSession(s)}
                  onAnalyze={(rel) => setAnalyzeProject(rel)}
                  onNewSession={(rel) => void newSession(rel)}
                  onWorktreeSession={(rel, branch, create, parent) => void worktreeSession(rel, branch, create, parent)}
                  onFeed={feed}
                />
              </div>

              {/* CENTER */}
              <Terminal
                view={view} onView={setView} selected={selected} sessionId={sessionId} activeProject={activeProject}
                branch={selected?.branch} model={model} turnCount={turns.length} turns={turns}
                activeId={active?.id ?? null} onRespond={(rid, o) => void respond(rid, o)} onReviewResolve={onReviewResolve} error={error}
                scrollRef={scrollRef} contentRef={contentRef}
                onSuggestPick={(t) => feed([t])}
                onOpenFromHistory={(s) => void openFromHistory(s)} liveTurns={liveTurns.current}
                trailingWorking={openWorking && !running} loading={loadingSession}
                composer={
                  <>
                    <AgentsPill sessionId={sessionId} running={running} />
                    <Composer
                      disabled={!sessionId || pendingCount > 0} running={running} model={model} effort={effort}
                      permissionMode={state?.permission_mode} injectedText={inject.text} injectNonce={inject.nonce} sessionId={sessionId}
                      contextTokens={contextTokens} resetLabel={resetLabel} onModel={setModel} onEffort={setEffort}
                      perm={permMode} onPerm={setPermMode} onSend={(t, i) => void send(t, i)} onStop={() => void stop()}
                      onCompact={() => void send("/compact", [])}
                      queued={queue.queued.map((q) => ({ id: q.id, text: q.text }))}
                      onCancelQueued={(id) => queue.remove(id)}
                    />
                  </>
                }
              />

              {/* RIGHT */}
              <div className="mscroll flex min-h-0 min-w-0 flex-col gap-[13px] pr-0.5">
                <ProjectsPanel
                  groups={visibleGroups} activeProject={activeProject}
                  onSelectProject={(rel) => void selectProject(rel)}
                  onAnalyze={(rel) => setAnalyzeProject(rel)}
                  onPreview={(rel) => setPreviewProject(rel)}
                  onManage={() => setManageOpen(true)}
                  onCreateProject={(name, prompt) => void createProject(name, prompt)}
                />
                <TaskQueuePanel projects={projectNames} onFeed={feed} />
              </div>
            </div>

            <StatusBar
              mount={wsRoot} usedPct={usedPct} repo={activeProject ?? "—"}
              changes={activeBadge?.dirty ?? 0} onPalette={() => setPaletteOpen(true)}
            />

            {analyzeProject && (
              <AnalyzeModal
                project={analyzeProject} badge={gitBadges.get(analyzeProject)}
                sessions={sessions.filter((s) => s.project === analyzeProject)} status={statusMap}
                onClose={() => setAnalyzeProject(null)} onFeed={feed}
                onSelectSession={(s) => { void selectSession(s); setAnalyzeProject(null); setView("chat"); }}
                onNewSession={(rel) => { void newSession(rel); setAnalyzeProject(null); }}
                onWorktreeSession={(rel, branch, create, parent) => { void worktreeSession(rel, branch, create, parent); setAnalyzeProject(null); }}
                attachedSessionId={sessionId}
              />
            )}
            <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
            {previewProject && (
              <RunningWindow
                project={previewProject}
                branch={gitBadges.get(previewProject)?.branch}
                sessionId={sessionId}
                onClose={() => setPreviewProject(null)}
              />
            )}
            {manageOpen && (
              <ManageProjectsModal
                groups={projectGroups.filter((g) => !removedProjects[g.rel])}
                imported={importedProjects.filter((rel) => !removedProjects[rel])}
                hidden={hiddenProjects}
                onToggleHide={(rel) => setHiddenProjects((p) => ({ ...p, [rel]: !p[rel] }))}
                onRemove={(rel) => {
                  setRemovedProjects((p) => ({ ...p, [rel]: true }));
                  setPreviewProject((cur) => (cur === rel ? null : cur));
                }}
                onImport={importProject}
                onClose={() => setManageOpen(false)}
              />
            )}
            {themeOpen && (
              <ThemeModal settings={settings} onTheme={setTheme} onToggle={toggleCrt}
                onReplayBoot={replayBoot} onClose={() => setThemeOpen(false)} />
            )}
            {settingsOpen && (
              <SettingsModal wsRoot={wsRoot} host={host.host} port={location.port || "8790"}
                settings={settings} onTheme={setTheme} onToggle={toggleCrt}
                defModel={model} defMode={defMode}
                onDefModel={setModel} onDefMode={(m) => { setDefMode(m); setPermMode(m); }}
                onClose={() => setSettingsOpen(false)} />
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
