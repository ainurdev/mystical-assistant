import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  logStream,
  TOKEN,
  type AnswerSelection,
  type DashState,
  type EffortLevel,
  type ModelId,
  type SessionBrief,
} from "./api";
import { activeOf, mergeDelta, type Turn } from "./chat";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { Logs } from "./components/Logs";

export function App() {
  const [state, setState] = useState<DashState | null>(null);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [model, setModel] = useState<ModelId>("opus");
  const [effort, setEffort] = useState<EffortLevel | "">("");
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const active = activeOf(turns);
  const running = active !== null;
  const pendingCount = active?.pending.length ?? 0;

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

  if (!TOKEN) {
    return (
      <div className="p-8 text-center text-sm text-zinc-400">
        Missing token. Open the dashboard via the URL the bridge printed (it includes
        <span className="font-mono"> ?token=…</span>).
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar
        projectRel={projectRel}
        sessions={sessions}
        selectedId={sessionId}
        onSelectSession={openSession}
        onNewSession={() => void newSession()}
        onProjectChanged={() => void loadSessions()}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
          <div className="text-sm font-semibold">{state?.project?.name ?? "Claude Bridge"}</div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            {state?.busy && (
              <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-white">busy</span>
            )}
            <ServerControls state={state} />
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <Transcript
            turns={turns}
            activeId={active?.id ?? null}
            onRespond={(rid, o) => void respond(rid, o)}
          />
          {error && (
            <div className="mt-2 rounded bg-red-500/15 px-2 py-1 text-sm text-red-300">{error}</div>
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
      </main>
      <section className="hidden w-96 shrink-0 border-l border-zinc-800 lg:flex lg:flex-col">
        <Logs lines={logs} />
      </section>
    </div>
  );
}

function ServerControls({ state }: { state: DashState | null }) {
  const running = state?.server.status === "running";
  const previewUrl = state?.preview.url;
  return (
    <div className="flex items-center gap-2">
      <button
        className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700"
        onClick={() => void api.server(running ? "stop" : "start").catch(() => {})}
      >
        {running ? "Stop server" : "Start server"}
      </button>
      <button
        className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700"
        onClick={() => void api.preview(previewUrl ? "stop" : "start").catch(() => {})}
      >
        {previewUrl ? "Stop preview" : "Preview"}
      </button>
      {previewUrl && (
        <a href={previewUrl} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
          open
        </a>
      )}
    </div>
  );
}
