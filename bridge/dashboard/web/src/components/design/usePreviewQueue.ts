import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, queueStream, sessionStream,
  type QueueSnapshot, type StoreEvent,
} from "../../api";

const EMPTY: QueueSnapshot = { session_id: "", seq: 0, paused: false, items: [] };

export interface EnqueueInput {
  text: string;
  prompt: string;
  images?: string[];
  sel?: { tag: string; label: string }[];
  width?: number;
  project?: string;
  model?: string;
  effort?: string;
  permission_mode?: string;
}

/** Live view of a session's server-side prompt queue, plus the ops to mutate it.
 * The server returns the fresh snapshot from every op and pushes changes over SSE,
 * so we just adopt whatever the server reports (newest revision wins). */
export function usePreviewQueue(sessionId: string | null) {
  const [snap, setSnap] = useState<QueueSnapshot>(EMPTY);
  const seqRef = useRef(0);

  const apply = useCallback((s: QueueSnapshot) => {
    if (s.session_id && sessionId && s.session_id !== sessionId) return;
    if (s.seq < seqRef.current) return;   // a stale POST reply can't clobber newer SSE
    seqRef.current = s.seq;
    setSnap(s);
  }, [sessionId]);

  useEffect(() => {
    seqRef.current = 0;
    setSnap(EMPTY);
    if (!sessionId) return;
    let live = true;
    api.queue(sessionId).then((s) => { if (live) apply(s); }).catch(() => {});
    const stop = queueStream(sessionId, (s) => { if (live) apply(s); });
    return () => { live = false; stop(); };
  }, [sessionId, apply]);

  const run = useCallback((p: Promise<QueueSnapshot>) => { p.then(apply).catch(() => {}); }, [apply]);

  const enqueue = useCallback((input: EnqueueInput) => {
    if (!sessionId) return;
    run(api.queueEnqueue({ session_id: sessionId, surface: "dashboard", ...input }));
  }, [sessionId, run]);

  const sid = sessionId ?? "";
  return {
    items: snap.items,
    paused: snap.paused,
    running: snap.items.find((x) => x.status === "running") ?? null,
    queued: snap.items.filter((x) => x.status === "queued"),
    enqueue,
    remove: (id: string) => run(api.queueOp("remove", { session_id: sid, item_id: id })),
    edit: (id: string, text: string) => run(api.queueOp("edit", { session_id: sid, item_id: id, text })),
    reorder: (from: string, to: string) => run(api.queueOp("reorder", { session_id: sid, from, to })),
    bump: (id: string) => run(api.queueOp("bump", { session_id: sid, item_id: id })),
    cancel: (id: string) => run(api.queueOp("cancel", { session_id: sid, item_id: id })),
    retry: (id: string) => run(api.queueOp("retry", { session_id: sid, item_id: id })),
    togglePause: () => run(api.queueOp(snap.paused ? "resume" : "pause", { session_id: sid })),
    clearDone: () => run(api.queueOp("clear-done", { session_id: sid })),
  };
}

export interface ToolEntry { name: string; summary: string; state: "running" | "done"; }
export interface RunProgress { tools: ToolEntry[]; result: string | null; error: string | null; }

const EMPTY_PROGRESS: RunProgress = { tools: [], result: null, error: null };

/** Accumulate the running prompt's live tool-call stream from the session SSE.
 * A turn's events carry turn_id === its job_id, so we keep only the running job's
 * events and resubscribe whenever the running job changes. */
export function useRunProgress(sessionId: string | null, jobId: string | null): RunProgress {
  const [prog, setProg] = useState<RunProgress>(EMPTY_PROGRESS);
  useEffect(() => {
    setProg(EMPTY_PROGRESS);
    if (!sessionId || !jobId) return;
    return sessionStream(sessionId, 0, (ev: StoreEvent) => {
      if (ev.turn_id !== jobId) return;
      setProg((p) => {
        const settle = () => p.tools.map((t) => ({ ...t, state: "done" as const }));
        if (ev.type === "tool") {
          return { ...p, tools: [...settle(), { name: ev.name, summary: ev.summary, state: "running" }] };
        }
        if (ev.type === "tool_done") return { ...p, tools: settle() };
        if (ev.type === "result") return { ...p, tools: settle(), result: ev.result };
        if (ev.type === "error") return { ...p, tools: settle(), error: ev.message };
        return p;
      });
    });
  }, [sessionId, jobId]);
  return prog;
}
