import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
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
} from "./api";
import { activeOf, mergeDelta, type Turn } from "./chat";
import { useTelemetry } from "./lib/telemetry";
import { GitTab } from "./components/GitTab";
import { IssuesTab } from "./components/IssuesTab";
import { RunTab } from "./components/RunTab";
import { DiffTab } from "./components/DiffTab";
import { Composer } from "./components/Composer";
import { Logs } from "./components/Logs";
import { RightPanel, type PanelTab } from "./components/RightPanel";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Strip } from "./components/hud/Strip";
import { StatusBar } from "./components/hud/StatusBar";
import { WorkspacePanel } from "./components/hud/WorkspacePanel";
import { TelemetryPanel } from "./components/hud/TelemetryPanel";
import { ContextMatrixPanel } from "./components/hud/ContextMatrixPanel";
import { ProjectsPanel } from "./components/hud/ProjectsPanel";
import { SessionsPanel } from "./components/hud/SessionsPanel";
import { JobsPanel } from "./components/hud/JobsPanel";
import { Terminal } from "./components/hud/Terminal";
import { BootIntro } from "./components/hud/BootIntro";

export function App() {
  const [state, setState] = useState<DashState | null>(null);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [model, setModel] = useState<ModelId>("opus");
  const [effort, setEffort] = useState<EffortLevel | "">("");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [external, setExternal] = useState<RunningSession[]>([]);
  const [jobs, setJobs] = useState<RunningJob[]>([]);
  const [bridgeIds, setBridgeIds] = useState<Set<string>>(new Set());
  const [awaiting, setAwaiting] = useState<Map<string, "question" | "permission">>(new Map());
  const [gitBadges, setGitBadges] = useState<Map<string, GitBadge>>(new Map());
  const [activeTab, setActiveTab] = useState("git");
  const [diffFile, setDiffFile] = useState<{ project: string; path: string } | null>(null);
  // Bumped to prefill the composer (e.g. "Feed to Claude" from the Issues tab).
  const [inject, setInject] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  const [browsing, setBrowsing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [booting, setBooting] = useState(true);
  // Dashboard mounts only as the boot intro fades, so its panel entrance
  // animations (boot/drawline/mfadeup) play on reveal, per the design.
  const [showDashboard, setShowDashboard] = useState(false);
  const seqRef = useRef(0);
  // Turns started from this client this session — their results "type" in live.
  const liveTurns = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef(false);

  const active = activeOf(turns);
  const running = active !== null;
  const pendingCount = active?.pending.length ?? 0;
  const vscodeLive = external.some((r) => r.source === "vscode");
  const selected = sessions.find((s) => s.id === sessionId) ?? null;
  const activeProject = state?.project?.rel ?? null;

  // Real-derived telemetry inputs (counts over the live transcript).
  const toolCount = turns.reduce(
    (n, t) => n + t.events.filter((e) => e.type === "tool").length,
    0,
  );
  const eventCount = turns.reduce((n, t) => n + t.events.length, 0);
  const cost = turns.reduce(
    (n, t) => n + t.events.reduce((c, e) => c + (e.type === "result" ? e.cost : 0), 0),
    0,
  );
  const errorCount = turns.reduce(
    (n, t) => n + t.events.filter((e) => e.type === "error").length,
    0,
  );
  const tele = useTelemetry({ running, toolCount, eventCount });

  function openSession(id: string) {
    seqRef.current = 0;
    pendingScrollRef.current = true; // jump to latest once this session's turns load
    setTurns([]);
    setSessionId(id);
  }

  // Global state poll (project / busy / server / preview).
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const s = await api.state();
        if (live) setState(s);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const { sessions: list } = await api.sessions();
      setSessions(list);
      return list;
    } catch {
      return [] as SessionBrief[];
    }
  }, []);

  // Load sessions; auto-select one for the current project on first load.
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
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [loadSessions, projectRel, sessionId]);

  // Transcript poll for the selected session.
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const tick = async () => {
      try {
        const t = await api.transcript(sessionId, seqRef.current);
        if (!live) return;
        setTurns((prev) => mergeDelta(prev, t));
        seqRef.current = t.next_cursor;
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 1500);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [sessionId]);

  // When a session is opened, jump to the latest message once its turns load.
  useEffect(() => {
    if (!pendingScrollRef.current || turns.length === 0) return;
    pendingScrollRef.current = false;
    const el = scrollRef.current;
    if (el) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }));
  }, [turns]);

  // Live dev-server logs (SSE).
  useEffect(() => logStream((line) => setLogs((prev) => [...prev.slice(-2000), line])), []);

  // ⌘K / Ctrl-K toggles the command palette; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Machine-wide running sessions: powers the sidebar dots + header VS chip.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running();
        if (!live) return;
        setExternal(r.external);
        setJobs(r.jobs ?? []);
        setBridgeIds(new Set(r.bridge_running));
        setAwaiting(new Map((r.awaiting ?? []).map((a) => [a.session_id, a.kind])));
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  // Per-repo git badges for the sidebar.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const { repos } = await api.gitAll();
        if (live) setGitBadges(new Map(Object.entries(repos)));
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 10000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  async function send(text: string, images: string[]) {
    if (!sessionId) return;
    setError(null);
    try {
      const res = await api.run({
        prompt: text,
        images,
        project: state?.project?.rel,
        session_id: sessionId,
        model,
        effort: effort || undefined,
      });
      liveTurns.current.add(res.job_id);
      setTurns((prev) => [
        ...prev,
        { id: res.job_id, prompt: text, events: [], status: "running", pending: [] },
      ]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function respond(
    requestId: string,
    opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
  ) {
    if (!active) return;
    try {
      await api.respond(active.id, { request_id: requestId, ...opts });
    } catch {
      /* the poll reconciles */
    }
  }

  async function stop() {
    if (!active) return;
    try {
      await api.interrupt(active.id);
    } catch {
      /* the poll reconciles */
    }
  }

  // Prefill the composer with an issue (or any prompt) and jump to chat so the
  // user can review/tweak model+effort before sending.
  function feedIssue(prompt: string) {
    setInject((p) => ({ text: prompt, nonce: p.nonce + 1 }));
    setView("chat");
  }

  async function newSession() {
    const proj = state?.project?.rel;
    if (proj === undefined || proj === null) return;
    try {
      const { session } = await api.createSession(proj);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
    } catch {
      /* ignore */
    }
  }

  // Resume any session from History: switch the active project first (so the
  // next message resumes in the right cwd), then open it and return to chat.
  async function openFromHistory(s: EnrichedSession) {
    try {
      await api.select(s.project);
      setState(await api.state());
    } catch {
      /* repo gone: transcript still viewable, project unchanged */
    }
    await loadSessions();
    openSession(s.id);
    setView("chat");
  }

  if (!TOKEN) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Missing token. Open the dashboard via the URL the bridge printed (it includes
        <span className="font-mono"> ?token=…</span>).
      </div>
    );
  }

  const serverRunning = state?.server.status === "running";
  const previewOpen = !!state?.preview.url;
  const commands: Command[] = [
    { id: "new-chat", label: "New chat", group: "Session", icon: "+", run: () => void newSession() },
    { id: "compact", label: "Compact context (/compact)", group: "Session", icon: "▢", run: () => void send("/compact", []) },
    { id: "switch-project", label: "Switch project…", group: "Session", icon: "⇄", run: () => setBrowsing(true) },
    { id: "view-chat", label: "Go to Chat", group: "View", icon: "▣", run: () => setView("chat") },
    { id: "view-history", label: "Go to History", group: "View", icon: "◷", run: () => setView("history") },
    {
      id: "server",
      label: serverRunning ? "Stop dev server" : "Start dev server",
      group: "Server",
      icon: "▸",
      run: () => void api.server(serverRunning ? "stop" : "start").catch(() => {}),
    },
    {
      id: "preview",
      label: previewOpen ? "Stop preview" : "Open preview",
      group: "Server",
      icon: "◰",
      run: () => void api.preview(previewOpen ? "stop" : "start").catch(() => {}),
    },
    { id: "tab-git", label: "Open Git", group: "Panel", icon: "⎇", run: () => setActiveTab("git") },
    { id: "tab-issues", label: "Open GitHub issues", group: "Panel", icon: "◉", run: () => setActiveTab("issues") },
    { id: "tab-run", label: "Open Run (dev server)", group: "Panel", icon: "▸", run: () => setActiveTab("run") },
    { id: "tab-diff", label: "View changes (diff)", group: "Panel", icon: "±", run: () => setActiveTab("diff") },
    { id: "tab-logs", label: "Open logs", group: "Panel", icon: "≣", run: () => setActiveTab("logs") },
    { id: "git-commit", label: "Git: commit changes…", group: "Git", icon: "✓", run: () => setActiveTab("git") },
    { id: "git-push", label: "Git: push to origin…", group: "Git", icon: "↑", run: () => setActiveTab("git") },
    { id: "model-opus", label: "Use Opus", group: "Model", icon: "⌥", run: () => setModel("opus") },
    { id: "model-sonnet", label: "Use Sonnet", group: "Model", icon: "⌥", run: () => setModel("sonnet") },
    { id: "model-haiku", label: "Use Haiku", group: "Model", icon: "⌥", run: () => setModel("haiku") },
  ];

  const panelTabs: PanelTab[] = [
    {
      id: "git",
      label: "Git",
      badge: (activeProject && gitBadges.get(activeProject)?.dirty)
        ? String(gitBadges.get(activeProject)!.dirty)
        : null,
      render: () => (
        <GitTab
          project={activeProject}
          onOpenDiff={(path) => {
            if (activeProject) {
              setDiffFile({ project: activeProject, path });
              setActiveTab("diff");
            }
          }}
        />
      ),
    },
    { id: "issues", label: "Issues", render: () => <IssuesTab project={activeProject} onFeed={feedIssue} /> },
    { id: "run", label: "Run", render: () => <RunTab project={activeProject} server={state?.server ?? undefined} /> },
    { id: "diff", label: "Diff", render: () => <DiffTab file={diffFile} /> },
    { id: "logs", label: "Logs", render: () => <Logs lines={logs} /> },
  ];

  const activeBadge = activeProject ? gitBadges.get(activeProject) : undefined;

  return (
    <div className="flex h-full flex-col bg-background">
      {booting && (
        <BootIntro
          onReveal={() => setShowDashboard(true)}
          onDone={() => {
            setShowDashboard(true);
            setBooting(false);
          }}
        />
      )}
      {showDashboard && (
        <>
          <div className="crt" />
          <div className="sweep" />
          <Strip host={location.host} />

          <div
            className="grid min-h-0 flex-1 gap-[13px] p-[13px]"
        style={{ gridTemplateColumns: "344px minmax(0,1fr) 368px" }}
      >
        {/* LEFT */}
        <div className="flex min-h-0 min-w-0 flex-col gap-[13px] overflow-y-auto overflow-x-hidden pr-0.5">
          <WorkspacePanel
            tele={tele}
            model={model}
            vscodeLive={vscodeLive}
            projectRel={projectRel}
            sessions={sessions}
            open={browsing}
            onOpenChange={setBrowsing}
            onSelectProject={() => void loadSessions()}
            onNewSession={() => void newSession()}
          />
          <TelemetryPanel tele={tele} turns={turns.length} tools={toolCount} cost={cost} errors={errorCount} />
          <ContextMatrixPanel permissionMode={state?.permission_mode} />
          <ProjectsPanel
            sessions={sessions}
            gitBadges={gitBadges}
            bridgeIds={bridgeIds}
            activeProject={activeProject}
            onSelectProject={() => void loadSessions()}
          />
        </div>

        {/* CENTER */}
        <Terminal
          view={view}
          onView={setView}
          selected={selected}
          model={model}
          turnCount={turns.length}
          turns={turns}
          activeId={active?.id ?? null}
          onRespond={(rid, o) => void respond(rid, o)}
          error={error}
          scrollRef={scrollRef}
          onOpenFromHistory={(s) => void openFromHistory(s)}
          liveTurns={liveTurns.current}
          composer={
            <Composer
              disabled={running || pendingCount > 0}
              running={running}
              model={model}
              effort={effort}
              permissionMode={state?.permission_mode}
              injectedText={inject.text}
              injectNonce={inject.nonce}
              onModel={setModel}
              onEffort={setEffort}
              onSend={(t, i) => void send(t, i)}
              onStop={() => void stop()}
              onCompact={() => void send("/compact", [])}
            />
          }
        />

        {/* RIGHT */}
        <div className="flex min-h-0 min-w-0 flex-col gap-[13px] overflow-y-auto overflow-x-hidden pr-0.5">
          <JobsPanel jobs={jobs} selectedId={sessionId} onSelect={openSession} />
          <SessionsPanel
            sessions={sessions}
            external={external}
            bridgeIds={bridgeIds}
            awaiting={awaiting}
            selectedId={sessionId}
            onSelect={openSession}
            tele={tele}
          />
          <RightPanel tabs={panelTabs} activeId={activeTab} onActiveChange={setActiveTab} />
        </div>
      </div>

      <StatusBar
        mount={state?.project?.rel ?? "/"}
        repo={activeProject ?? "—"}
        changes={activeBadge?.dirty ?? 0}
        onPalette={() => setPaletteOpen(true)}
      />
          <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
        </>
      )}
    </div>
  );
}
