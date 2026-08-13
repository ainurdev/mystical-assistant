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
  StoreTurn,
  Transcript,
} from "./api";
import { usePersistentState } from "./persistentState";
import { modelOptions } from "./models";

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
  status: "running" | "done" | "error";
  pending: PendingRequest[];
  // null/undefined = default Claude account; 'claude:<slot>' | 'opencode:<provider>'
  runtime?: string | null;
  started?: number; // epoch seconds — the run monitor's clock
  // Total tokens this turn spent; null = never reported (unknown, not free).
  tokens?: number | null;
}

/** A store turn's total token spend, or null when nothing was ever reported.
 *  Null and 0 are different answers: "we don't know" versus "none". */
function tokensOf(st: StoreTurn): number | null {
  const parts = [st.tok_in, st.tok_out, st.tok_cache_w, st.tok_cache_r];
  if (parts.every((n) => n == null)) return null;
  return parts.reduce((a: number, n) => a + (n ?? 0), 0);
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
  const touched = new Set<string>();

  for (const st of t.turns) {
    storeSeq.set(st.id, st.seq);
    const ex = map.get(st.id);
    // Prefer client-held attachments (just-sent, with data: URLs we can render);
    // otherwise rehydrate from the store's filenames so a reopened session still
    // shows that images were attached (the blob isn't persisted — see run.tsx).
    const fromStore = (): Attachment[] =>
      st.attachments.map((n, i) => ({ id: `${st.id}-a${i}`, name: n }));
    if (ex) {
      // Keep the same object when nothing changed: identity is what lets the
      // memoized RunStream skip every past turn on a long session's 1.5s poll.
      const attachments =
        ex.attachments.length || !st.attachments.length ? ex.attachments : fromStore();
      const prompt = ex.prompt || st.prompt;
      if (ex.status !== st.status || ex.prompt !== prompt || ex.attachments !== attachments
          || ex.runtime !== st.runtime) {
        map.set(st.id, { ...ex, status: st.status, prompt, attachments, runtime: st.runtime,
                         tokens: tokensOf(st) });
      }
      if (ex.status !== st.status) touched.add(st.id);   // a turn ending clears its pending
    } else {
      map.set(st.id, {
        id: st.id,
        prompt: st.prompt,
        attachments: fromStore(),
        jobId: st.id,
        events: [],
        status: st.status,
        pending: [],
        runtime: st.runtime,
        started: st.started,
        tokens: tokensOf(st),
      });
    }
  }

  for (const ev of t.events) {
    const turn = map.get(ev.turn_id);
    if (!turn) continue;
    if (turn.events.some((e) => seqOf(e) === ev.seq)) continue;
    map.set(ev.turn_id, { ...turn, events: [...turn.events, ev] });
    touched.add(ev.turn_id);
  }

  for (const id of touched) {
    const turn = map.get(id)!;
    // Only a live turn can be blocked on you: once it ends nothing is listening
    // for the answer (the respond endpoint 409s), so it is history, not a card.
    const pending = turn.status === "running" ? derivePending(turn.events) : [];
    if (pending.length || turn.pending.length) map.set(id, { ...turn, pending });
  }

  const out = [...map.values()];
  out.sort(
    (a, b) =>
      (storeSeq.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (storeSeq.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  // Nothing changed (an idle poll) — keep the old array so nothing re-renders.
  if (out.length === prev.length && out.every((x, i) => x === prev[i])) return prev;
  return out;
}

export interface HeldPrompt {
  text: string;
  attachments: Attachment[];
  reason: string;
  title: string | null;
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
  models: { id: ModelId; label: string }[];
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
  ) => Promise<boolean>;
  /** The open session's transcript hasn't arrived yet (first load or a switch). */
  loadingSession: boolean;
  newChat: () => Promise<void>;
  held: HeldPrompt | null;
  heldBusy: boolean;
  checking: boolean;
  heldStartNew: () => Promise<void>;
  heldContinue: () => Promise<void>;
  heldDismiss: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([]);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  // A prompt the relevance guardrail held back — still client-side, nothing ran.
  const [held, setHeld] = useState<HeldPrompt | null>(null);
  const [heldBusy, setHeldBusy] = useState(false);
  // /api/run is in flight. Normally ~instant, but a relevance check makes it
  // block for ~10s — without this the composer looks dead after Send.
  const [checking, setChecking] = useState(false);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // The session resolver below hasn't settled yet, so "no turns" means "not
  // fetched", not "empty chat". Flips on failure too — never spin forever.
  const [resolving, setResolving] = useState(true);
  const [model, setModel] = usePersistentState<ModelId>("miniapp:model:v1", "opus");
  const [effort, setEffort] = usePersistentState<EffortLevel | "">("miniapp:effort:v1", "");
  // Per-message permission override ("" = use the session's mode). Lets you flip a
  // single run to ask/plan/full-auto from the phone, like Shift+Tab in the CLI.
  const [perm, setPerm] = usePersistentState<string>("miniapp:perm:v1", "");
  const fileIdRef = useRef(0);
  const seqRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null); // current session, for stale-free reads
  // A notification's panel button opens "?s=<session>&p=<repo>" (bridge/telegram.py
  // panel_kb). Held until the project switch lands, so the auto-resolver below
  // can't race it and drop us on the repo's latest session instead.
  const pinnedRef = useRef<string | null>(null);

  const stateQuery = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 5000,
  });
  const project = stateQuery.data?.project?.rel ?? null;
  // Model picker options — the live list served from /api/state (Models API).
  const models = modelOptions(stateQuery.data?.models);
  // Once the live list loads, snap the persisted selection to an available
  // model (prefer Opus) if the stored one isn't offered.
  useEffect(() => {
    if (!models.length || models.some((m) => m.id === model)) return;
    setModel((models.find((m) => m.id.includes("opus")) ?? models[0]).id);
  }, [models, model, setModel]);

  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const activeTurn = lastTurn && lastTurn.status === "running" ? lastTurn : null;
  const isRunning = activeTurn !== null;
  const pending = activeTurn?.pending ?? [];

  // Unified status (shared ["running"] cache with ActiveSessions / the header). Tells
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
    pinnedRef.current = null;   // an explicit pick outranks the deep link
    setTurns([]);
    setSessionId(id);
    setHeld(null);          // a card about the session we're leaving
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

  // Cold open from a Telegram notification: land on the session it was about.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const [s, p] = [q.get("s"), q.get("p")];
    if (!s) return;
    if (p) void openSessionInProject(p, s);
    else openSession(s);
    pinnedRef.current = s;             // set last: openSession clears the pin
  }, []);

  // Resolve the current session for the active project (latest, or create one).
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    (async () => {
      try {
        const { sessions: list } = await api.listSessions(project);
        if (cancelled) return;
        setSessions(list);
        if (pinnedRef.current) {
          // Deep-linked session: hold the view until its repo is the active one.
          if (list.some((s) => s.id === pinnedRef.current)) pinnedRef.current = null;
          return;
        }
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
      } finally {
        if (!cancelled) setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Load + live-poll the current session's transcript (session-seq cursor).
  const transcriptQ = useQuery({
    queryKey: ["transcript", sessionId],
    enabled: sessionId !== null,
    queryFn: async () => {
      const forId = sessionId as string;
      const t = await api.getSession(forId, seqRef.current);
      // A session switch (openSession) resets seqRef/turns and changes the key,
      // but this in-flight fetch for the OLD session must not merge into the new
      // one's list or clobber its cursor. Bail if we've since switched away.
      if (sessionIdRef.current !== forId) return t;
      setTurns((prev) => mergeDelta(prev, t));
      seqRef.current = t.next_cursor;
      return t;
    },
    refetchInterval: isRunning || sessionWorking ? 1500 : false,
  });
  // The very first fetch for this session — a poll refetch keeps the transcript
  // on screen, so only the load with nothing to show yet counts as loading. Each
  // term can end: no project (the resolver never runs) falls through to the
  // empty state rather than spinning forever.
  const loadingSession =
    stateQuery.isLoading || (project !== null && resolving) || transcriptQ.isLoading;

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
  // once the run is accepted (used by send() to clear the draft). `opts.sessionId`
  // targets a session React state doesn't know about yet (just created); `force`
  // skips the "unrelated to this session?" check.
  async function runPrompt(
    text: string,
    attachments: Attachment[],
    onSent?: () => void,
    opts?: { force?: boolean; sessionId?: string },
  ) {
    const sid = opts?.sessionId ?? sessionId;
    if (!text || !sid) return;
    if (!opts?.sessionId && (isRunning || pending.length > 0)) return;
    setSendError(null);
    setChecking(true);
    try {
      const res = await api.run(
        text,
        attachments.map((a) => a.dataUrl ?? "").filter(Boolean),
        project ?? undefined,
        sid,
        model,
        effort || undefined,
        perm || undefined,
        opts?.force,
      );
      // Held: this looks like different work from the session it would resume.
      // Nothing ran — park it on the card (draft untouched, so Dismiss is a no-op).
      if ("suggest_new" in res) {
        setHeld({ text, attachments, reason: res.reason, title: res.suggested_title });
        return;
      }
      setHeld(null);
      onSent?.();
      setTurns((prev) => [
        ...prev,
        {
          id: res.job_id,
          prompt: text,
          attachments,
          jobId: res.job_id,
          events: [],
          status: "running",
          pending: [],
          started: Date.now() / 1000,
        },
      ]);
      refresh();
    } catch (e) {
      if (e instanceof ApiError) setSendError(e);
      else setSendError(new ApiError(0, "Failed to start run."));
    } finally {
      setChecking(false);
    }
  }

  function clearDraft() {
    setDraft("");
    setDraftAttachments([]);
  }

  async function send() {
    await runPrompt(draft.trim(), draftAttachments, clearDraft);
  }

  // The held prompt's three exits. "Start new" routes it to a fresh session
  // pre-named with the suggested title; both re-sends force so the check isn't
  // paid twice. Dismiss just drops the card — the draft was never cleared.
  async function heldStartNew() {
    const h = held;
    if (!h || !project) return;
    setHeld(null);
    setHeldBusy(true);
    try {
      const { session } = await api.createSession(project, h.title ?? undefined);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
      await runPrompt(h.text, h.attachments, clearDraft,
                      { force: true, sessionId: session.id });
    } catch {
      setSendError(new ApiError(0, "Failed to start a new session."));
    } finally {
      setHeldBusy(false);
    }
  }

  async function heldContinue() {
    const h = held;
    if (!h) return;
    setHeld(null);
    await runPrompt(h.text, h.attachments, clearDraft, { force: true });
  }

  // Compact the conversation to reclaim context. `/compact` is a Claude Code
  // slash command honored on the resumed session (verified over stream-json).
  async function compact() {
    await runPrompt("/compact", []);
  }

  async function respond(
    requestId: string,
    opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
  ): Promise<boolean> {
    if (!activeTurn) return false;
    try {
      await api.respond(activeTurn.id, {
        request_id: requestId,
        behavior: opts.behavior,
        answers: opts.answers,
      });
    } catch {
      return false; // the card hands the button back instead of spinning forever
    }
    refresh();
    return true;
  }

  useEffect(() => {
    if (isRunning || sessionId === null) return;
    const t1 = setTimeout(() => qc.invalidateQueries({ queryKey: ["transcript", sessionId] }), 2500);
    const t2 = setTimeout(() => qc.invalidateQueries({ queryKey: ["transcript", sessionId] }), 6000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [isRunning, sessionId, qc]);

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
    models,
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
    loadingSession,
    newChat,
    held,
    heldBusy,
    checking,
    heldStartNew,
    heldContinue,
    heldDismiss: () => setHeld(null),
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
