import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, queueStream,
  type QueueSnapshot,
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
  agent?: string;
}

/** Live view of a session's server-side prompt queue, plus the ops to mutate it.
 * The server returns the fresh snapshot from every op and pushes changes over SSE,
 * so we just adopt whatever the server reports (newest revision wins). */
export function useSessionQueue(sessionId: string | null) {
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

  // `session` targets a session other than the open one — a prompt always
  // belongs to the session it was written in, even if you switched away while
  // it was in flight. `apply` drops snapshots for other sessions, so a foreign
  // enqueue can't clobber the open session's view.
  const enqueue = useCallback((input: EnqueueInput, session?: string) => {
    const target = session ?? sessionId;
    if (!target) return;
    run(api.queueEnqueue({ session_id: target, surface: "dashboard", ...input }));
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
    /** Hand a queued prompt to another session, where it runs instead. Returns the
     * promise (run() swallows errors) so the caller can report a failed move
     * instead of leaving the prompt silently stuck in this session's queue. */
    move: (id: string, to: string) =>
      api.queueOp("move", { session_id: sid, item_id: id, to }).then(apply),
    cancel: (id: string) => run(api.queueOp("cancel", { session_id: sid, item_id: id })),
    retry: (id: string) => run(api.queueOp("retry", { session_id: sid, item_id: id })),
    togglePause: () => run(api.queueOp(snap.paused ? "resume" : "pause", { session_id: sid })),
    /** Unpause only if paused — sending a prompt by hand means you want the loop
     * back, and a blind toggle would pause a queue that was already running. */
    resumeIfPaused: () => { if (snap.paused) run(api.queueOp("resume", { session_id: sid })); },
    clearDone: () => run(api.queueOp("clear-done", { session_id: sid })),
    /** Send text into the RUNNING turn (not the queue). Resolves false if the
     * server says nothing is running, so the caller can queue it instead. */
    steer: (text: string) =>
      api.queueOp("steer", { session_id: sid, text })
        .then((s) => { apply(s); return true; }).catch(() => false),
  };
}
