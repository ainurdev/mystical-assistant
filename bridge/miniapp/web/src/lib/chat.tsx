import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import type { AnswerSelection, PendingRequest, RunEvent, RunStatus } from "./api";

const KEY = "miniapp:chat:v1";

export interface Attachment {
  id: string;
  name: string;
  dataUrl: string;
}

export interface Turn {
  id: string;
  prompt: string;
  attachments: Attachment[];
  jobId: string;
  events: RunEvent[];
  cursor: number;
  status: "running" | "done" | "error";
  pending: PendingRequest[];
  stale?: boolean; // job vanished after a bridge restart
}

interface ChatState {
  turns: Turn[];
  draft: string;
  draftAttachments: Attachment[];
}

const EMPTY: ChatState = { turns: [], draft: "", draftAttachments: [] };

function load(): ChatState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChatState>;
      if (parsed && Array.isArray(parsed.turns)) {
        return { ...EMPTY, ...parsed, draftAttachments: parsed.draftAttachments ?? [] };
      }
    }
  } catch {
    // corrupt / unavailable — start fresh
  }
  return EMPTY;
}

/** Persist chat state. On a quota error, retry without image attachments
 *  (transcript text is worth more than previews); if still failing, skip. */
function persist(state: ChatState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return;
  } catch {
    /* fall through to slim retry */
  }
  try {
    const slim: ChatState = {
      ...state,
      draftAttachments: [],
      turns: state.turns.map((t) => ({ ...t, attachments: [] })),
    };
    localStorage.setItem(KEY, JSON.stringify(slim));
  } catch {
    // give up — in-memory only
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Merge a poll/respond snapshot into a turn, robust against overlapping
 *  responses (poll and a respond() can both fetch from the same cursor). */
function applySnapshot(prev: ChatState, jobId: string, res: RunStatus): ChatState {
  let changed = false;
  const resPending = res.pending ?? [];
  const turns = prev.turns.map((t) => {
    if (t.jobId !== jobId) return t;
    const respStart = res.next_cursor - res.events.length;
    const skip = Math.max(0, t.cursor - respStart);
    const fresh = res.events.slice(skip);
    const newCursor = Math.max(t.cursor, res.next_cursor);
    const samePending =
      t.pending.length === resPending.length &&
      t.pending.every((p, i) => p.request_id === resPending[i]?.request_id);
    if (!fresh.length && newCursor === t.cursor && t.status === res.status && samePending) {
      return t; // nothing new — keep the same reference
    }
    changed = true;
    return {
      ...t,
      events: fresh.length ? [...t.events, ...fresh] : t.events,
      cursor: newCursor,
      status: res.status,
      pending: resPending,
    };
  });
  return changed ? { ...prev, turns } : prev;
}

function markStale(prev: ChatState, jobId: string): ChatState {
  return {
    ...prev,
    turns: prev.turns.map((t) =>
      t.jobId === jobId ? { ...t, status: "error", stale: true, pending: [] } : t,
    ),
  };
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
  pending: PendingRequest[];
  sendError: ApiError | null;
  send: () => Promise<void>;
  respond: (
    requestId: string,
    opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
  ) => Promise<void>;
  newChat: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatState>(load);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const fileIdRef = useRef(0);

  useEffect(() => persist(state), [state]);

  const stateQuery = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 5000,
  });

  const lastTurn = state.turns.length ? state.turns[state.turns.length - 1] : null;
  const activeTurn = lastTurn && lastTurn.status === "running" ? lastTurn : null;
  const activeJobId = activeTurn?.jobId ?? null;
  const cursor = activeTurn?.cursor ?? 0;

  // Poll the active turn. Mounted in Layout, so it survives tab navigation.
  useQuery({
    queryKey: ["run", activeJobId, cursor],
    queryFn: async () => {
      try {
        const res = await api.runStatus(activeJobId as string, cursor);
        setState((prev) => applySnapshot(prev, activeJobId as string, res));
        return res;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setState((prev) => markStale(prev, activeJobId as string));
          return { status: "error", events: [], next_cursor: cursor, pending: [] } as RunStatus;
        }
        throw e;
      }
    },
    enabled: activeJobId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1500 : false,
  });

  const isRunning = activeTurn !== null;
  const pending = activeTurn?.pending ?? [];

  async function addAttachments(files: FileList | null) {
    if (!files) return;
    const added: Attachment[] = [];
    for (const file of Array.from(files)) {
      const dataUrl = await readAsDataUrl(file);
      added.push({ id: `att-${fileIdRef.current++}-${file.name}`, name: file.name, dataUrl });
    }
    setState((prev) => ({ ...prev, draftAttachments: [...prev.draftAttachments, ...added] }));
  }

  function removeAttachment(id: string) {
    setState((prev) => ({
      ...prev,
      draftAttachments: prev.draftAttachments.filter((a) => a.id !== id),
    }));
  }

  async function send() {
    const text = state.draft.trim();
    if (!text || isRunning || pending.length > 0) return;
    const attachments = state.draftAttachments;
    const fresh = state.turns.length === 0;
    const project = stateQuery.data?.project?.rel;
    setSendError(null);
    try {
      const res = await api.run(text, attachments.map((a) => a.dataUrl), project, fresh);
      setState((prev) => ({
        ...prev,
        draft: "",
        draftAttachments: [],
        turns: [
          ...prev.turns,
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
        ],
      }));
    } catch (e) {
      if (e instanceof ApiError) setSendError(e);
      else setSendError(new ApiError(0, "Failed to start run."));
    }
  }

  async function respond(
    requestId: string,
    opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
  ) {
    if (!activeTurn) return;
    const jobId = activeTurn.jobId;
    const res = await api.respond(jobId, {
      request_id: requestId,
      behavior: opts.behavior,
      answers: opts.answers,
      cursor: activeTurn.cursor,
    });
    setState((prev) => applySnapshot(prev, jobId, res));
  }

  function newChat() {
    setSendError(null);
    setState((prev) => ({ ...EMPTY, draft: prev.draft, draftAttachments: prev.draftAttachments }));
  }

  const value: ChatContextValue = {
    turns: state.turns,
    draft: state.draft,
    setDraft: (v) => setState((prev) => ({ ...prev, draft: v })),
    draftAttachments: state.draftAttachments,
    addAttachments,
    removeAttachment,
    activeTurn,
    isRunning,
    pending,
    sendError,
    send,
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
