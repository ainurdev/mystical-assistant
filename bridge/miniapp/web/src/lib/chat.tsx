import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import type {
  AnswerSelection,
  EffortLevel,
  ModelId,
  PendingRequest,
  RunEvent,
  SessionBrief,
  Transcript,
} from "./api";
import { usePersistentState } from "./persistentState";

export interface Attachment {
  id: string;
  name: string;
  dataUrl?: string; // present for just-attached images; absent for loaded history
}

export interface Turn {
  id: string; // == store turn id == job id
  prompt: string;
  attachments: Attachment[];
  jobId: string;
  events: RunEvent[];
  cursor: number; // unused under the transcript model; kept for the view's shape
  status: "running" | "done" | "error";
  pending: PendingRequest[];
  stale?: boolean;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Unresolved permission/question events are the actionable pending requests
 *  (derived from the transcript, so no separate live "pending" list is needed). */
function derivePending(events: RunEvent[]): PendingRequest[] {
  const resolved = new Set<string>();
  for (const e of events) {
    if (e.type === "permission_resolved" || e.type === "question_answered")
      resolved.add(e.request_id);
  }
  const out: PendingRequest[] = [];
  for (const e of events) {
    if (e.type === "permission" && !resolved.has(e.request_id))
      out.push({
        request_id: e.request_id,
        kind: "permission",
        tool_name: e.tool_name,
        summary: e.summary,
      });
    else if (e.type === "question" && !resolved.has(e.request_id))
      out.push({
        request_id: e.request_id,
        kind: "question",
        tool_name: "AskUserQuestion",
        questions: e.questions,
      });
  }
  return out;
}

function seqOf(e: RunEvent): number | undefined {
  return (e as { seq?: number }).seq;
}

/** Merge a transcript (full turn list + event delta) into the current turns,
 *  upserting turns by id and appending events by session-level seq. Everything
 *  is seq-keyed, so the active turn never mixes cursor spaces (and an optimistic
 *  turn already present by job id is updated, never duplicated). */
function mergeDelta(prev: Turn[], t: Transcript): Turn[] {
  const map = new Map<string, Turn>(prev.map((x) => [x.id, x]));
  const storeSeq = new Map<string, number>();

  for (const st of t.turns) {
    storeSeq.set(st.id, st.seq);
    const ex = map.get(st.id);
    if (ex) {
      map.set(st.id, { ...ex, status: st.status, prompt: ex.prompt || st.prompt });
    } else {
      map.set(st.id, {
        id: st.id,
        prompt: st.prompt,
        attachments: [], // history image blobs aren't persisted
        jobId: st.id,
        events: [],
        cursor: 0,
        status: st.status,
        pending: [],
      });
    }
  }

  for (const ev of t.events) {
    const turn = map.get(ev.turn_id);
    if (!turn) continue;
    if (turn.events.some((e) => seqOf(e) === ev.seq)) continue;
    map.set(ev.turn_id, { ...turn, events: [...turn.events, ev] });
  }

  const out = [...map.values()].map((turn) => ({
    ...turn,
    pending: derivePending(turn.events),
  }));
  out.sort(
    (a, b) =>
      (storeSeq.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (storeSeq.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  return out;
}

export interface ChatContextValue {
  turns: Turn[];
  draft: string;
  setDraft: (v: string) => void;
  draftAttachments: Attachment[];
  addAttachments: (files: FileList | null) => Promise<void>;
  removeAttachment: (id: string) => void;
  activeTurn: Turn | null;
  isRunning: boolean;
  // The open session's AI is working — a live bridge turn OR a native (VS Code)
  // session being written to right now (from the unified status map).
  sessionWorking: boolean;
  pending: PendingRequest[];
  sendError: ApiError | null;
  model: ModelId;
  setModel: (m: ModelId) => void;
  effort: EffortLevel | "";
  setEffort: (e: EffortLevel | "") => void;
  perm: string;
  setPerm: (p: string) => void;
  sessions: SessionBrief[];
  sessionId: string | null;
  selectSession: (id: string) => void;
  openSessionInProject: (project: string, id: string) => Promise<void>;
  send: () => Promise<void>;
  runPrompt: (text: string, attachments: Attachment[]) => Promise<void>;
  compact: () => Promise<void>;
  stop: () => Promise<void>;
  respond: (
    requestId: string,
    opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
  ) => Promise<void>;
  newChat: () => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([]);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [model, setModel] = usePersistentState<ModelId>("miniapp:model:v1", "opus");
  const [effort, setEffort] = usePersistentState<EffortLevel | "">("miniapp:effort:v1", "");
  // Per-message permission override ("" = use the session's mode). Lets you flip a
  // single run to ask/plan/full-auto from the phone, like Shift+Tab in the CLI.
  const [perm, setPerm] = usePersistentState<string>("miniapp:perm:v1", "");
  const fileIdRef = useRef(0);
  const seqRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null); // current session, for stale-free reads

  const stateQuery = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 5000,
  });
  const project = stateQuery.data?.project?.rel ?? null;

  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const activeTurn = lastTurn && lastTurn.status === "running" ? lastTurn : null;
  const isRunning = activeTurn !== null;
  const pending = activeTurn?.pending ?? [];

  // Unified status (shared ["running"] cache with RunningNow / the header). Tells
  // us when the open session is a live native (VS Code) session so we both stream
  // its transcript and show a working indicator, even with no bridge turn.
  const runningQuery = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  const sessionWorking =
    (sessionId ? runningQuery.data?.status?.[sessionId]?.state : undefined) === "working";

  function openSession(id: string) {
    seqRef.current = 0;
    sessionIdRef.current = id;
    setTurns([]);
    setSessionId(id);
  }

  // Open a session that may live in a different repo: switch the active project
  // first (so a resume runs in the right cwd), then load it by id. The transcript
  // poll keys off the id, so it loads regardless of the active project.
  async function openSessionInProject(proj: string, id: string) {
    openSession(id);
    try {
      await api.select(proj);
    } catch {
      return; // repo gone/invalid: transcript still viewable, project unchanged
    }
    void qc.invalidateQueries({ queryKey: ["state"] });
  }

  function refresh() {
    if (sessionId) void qc.invalidateQueries({ queryKey: ["transcript", sessionId] });
  }

  // Resolve the current session for the active project (latest, or create one).
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    (async () => {
      try {
        const { sessions: list } = await api.listSessions(project);
        if (cancelled) return;
        setSessions(list);
        // Keep an explicitly-opened session (e.g. from History) when the active
        // project changes; only auto-resolve when the current one isn't here.
        if (sessionIdRef.current && list.some((s) => s.id === sessionIdRef.current))
          return;
        if (list.length) {
          openSession(list[0].id);
        } else {
          const { session } = await api.createSession(project);
          if (cancelled) return;
          setSessions([session]);
          openSession(session.id);
        }
      } catch {
        /* leave current state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Load + live-poll the current session's transcript (session-seq cursor).
  useQuery({
    queryKey: ["transcript", sessionId],
    enabled: sessionId !== null,
    queryFn: async () => {
      const t = await api.getSession(sessionId as string, seqRef.current);
      setTurns((prev) => mergeDelta(prev, t));
      seqRef.current = t.next_cursor;
      return t;
    },
    refetchInterval: isRunning || sessionWorking ? 1500 : false,
  });

  async function addAttachments(files: FileList | null) {
    if (!files) return;
    const added: Attachment[] = [];
    for (const file of Array.from(files)) {
      const dataUrl = await readAsDataUrl(file);
      added.push({ id: `att-${fileIdRef.current++}-${file.name}`, name: file.name, dataUrl });
    }
    setDraftAttachments((prev) => [...prev, ...added]);
  }

  function removeAttachment(id: string) {
    setDraftAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  // Start a run for an arbitrary prompt on the current session. `onSent` fires
  // once the run is accepted (used by send() to clear the draft).
  async function runPrompt(
    text: string,
    attachments: Attachment[],
    onSent?: () => void,
  ) {
    if (!text || isRunning || pending.length > 0 || !sessionId) return;
    setSendError(null);
    try {
      const res = await api.run(
        text,
        attachments.map((a) => a.dataUrl ?? "").filter(Boolean),
        project ?? undefined,
        sessionId,
        model,
        effort || undefined,
        perm || undefined,
      );
      onSent?.();
      setTurns((prev) => [
        ...prev,
        {
          id: res.job_id,
          prompt: text,
          attachments,
          jobId: res.job_id,
          events: [],
          cursor: 0,
          status: "running",
          pending: [],
        },
      ]);
      refresh();
    } catch (e) {
      if (e instanceof ApiError) setSendError(e);
      else setSendError(new ApiError(0, "Failed to start run."));
    }
  }

  async function send() {
    await runPrompt(draft.trim(), draftAttachments, () => {
      setDraft("");
      setDraftAttachments([]);
    });
  }

  // Compact the conversation to reclaim context. `/compact` is a Claude Code
  // slash command honored on the resumed session (verified over stream-json).
  async function compact() {
    await runPrompt("/compact", []);
  }

  async function respond(
    requestId: string,
    opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
  ) {
    if (!activeTurn) return;
    try {
      await api.respond(activeTurn.id, {
        request_id: requestId,
        behavior: opts.behavior,
        answers: opts.answers,
      });
    } catch {
      /* the poll reconciles */
    }
    refresh();
  }

  async function stop() {
    if (!activeTurn) return;
    try {
      await api.interrupt(activeTurn.id, 0);
    } catch {
      /* 404/409: the poll reconciles */
    }
    refresh();
  }

  async function newChat() {
    if (!project) return;
    setSendError(null);
    try {
      const { session } = await api.createSession(project);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
    } catch {
      /* ignore */
    }
  }

  function selectSession(id: string) {
    if (id === sessionId) return;
    openSession(id);
  }

  const value: ChatContextValue = {
    turns,
    draft,
    setDraft,
    draftAttachments,
    addAttachments,
    removeAttachment,
    activeTurn,
    isRunning,
    sessionWorking,
    pending,
    sendError,
    model,
    setModel,
    effort,
    setEffort,
    perm,
    setPerm,
    sessions,
    sessionId,
    selectSession,
    openSessionInProject,
    send,
    runPrompt,
    compact,
    stop,
    respond,
    newChat,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
