import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  logStream,
  TOKEN,
  type AnswerSelection,
  type DashState,
  type EffortLevel,
  type EnrichedSession,
  type ModelId,
  type RunningSession,
  type SessionBrief,
} from "./api";
import { activeOf, mergeDelta, type Turn } from "./chat";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { HistoryView } from "./components/HistoryView";
import { Logs } from "./components/Logs";
import { RightPanel, type PanelTab } from "./components/RightPanel";

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
  const [bridgeIds, setBridgeIds] = useState<Set<string>>(new Set());
  const [awaiting, setAwaiting] = useState<Map<string, "question" | "permission">>(new Map());
  const seqRef = useRef(0);

  const active = activeOf(turns);
  const running = active !== null;
  const pendingCount = active?.pending.length ?? 0;
  const vscodeLive = external.some((r) => r.source === "vscode");

  function openSession(id: string) {
    seqRef.current = 0;
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

  // Live dev-server logs (SSE).
  useEffect(() => logStream((line) => setLogs((prev) => [...prev.slice(-2000), line])), []);

  // Machine-wide running sessions: powers the sidebar dots + header VS chip.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running();
        if (!live) return;
        setExternal(r.external);
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

  const panelTabs: PanelTab[] = [
    { id: "logs", label: "Logs", render: () => <Logs lines={logs} /> },
  ];

  return (
    <div className="flex h-full">
      <Sidebar
        projectRel={projectRel}
        sessions={sessions}
        selectedId={sessionId}
        onSelectSession={openSession}
        onNewSession={() => void newSession()}
        onProjectChanged={() => void loadSessions()}
        external={external}
        bridgeIds={bridgeIds}
        awaiting={awaiting}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          projectName={state?.project?.name ?? ""}
          view={view}
          onView={setView}
          vscodeLive={vscodeLive}
          state={state}
          onServer={() =>
            void api.server(state?.server.status === "running" ? "stop" : "start").catch(() => {})
          }
          onPreview={() =>
            void api.preview(state?.preview.url ? "stop" : "start").catch(() => {})
          }
        />
        {view === "history" ? (
          <HistoryView onOpen={(s) => void openFromHistory(s)} />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <Transcript
                turns={turns}
                activeId={active?.id ?? null}
                onRespond={(rid, o) => void respond(rid, o)}
              />
              {error && (
                <div className="mt-2 rounded bg-red-500/15 px-2 py-1 text-sm text-red-300">
                  {error}
                </div>
              )}
            </div>
            <Composer
              disabled={running || pendingCount > 0}
              running={running}
              model={model}
              effort={effort}
              onModel={setModel}
              onEffort={setEffort}
              onSend={(t, i) => void send(t, i)}
              onStop={() => void stop()}
            />
          </>
        )}
      </main>
      <RightPanel tabs={panelTabs} />
    </div>
  );
}
