import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { main, queryClient, reread, type FlowAnswer } from "./queries";
import type { Flow, FlowOption, FlowSet } from "./flowview";

/* The open session's path for the prompt box's FLOW chip (Composer), read as the SESSION
   tab reads it (one shared read, lib/queries): on the turn's edges, and every few seconds
   while a turn runs or its tickets build. A change made from the chip or from the SESSION
   tab lands in that read and goes out as one window event, so both show it at once. */

export const FLOW_EVENT = "hud:flow";
export type FlowAct = { kind: "set"; key: FlowOption; on: boolean | null } | { kind: "reset" } | { kind: "skip"; to: string };

export function flowChanged(session: string, flow: Flow) {
  queryClient.setQueryData(main.flow({ session }).queryKey, (d: FlowAnswer | undefined) => (d ? { ...d, flow } : d));
  window.dispatchEvent(new CustomEvent(FLOW_EVENT, { detail: { session, flow } }));
}

/** `edge` changes on a turn's start and end (any string that does); null while the transcript loads. */
export function useFlow(sessionId: string | undefined, on: boolean, edge: string | null, running: boolean) {
  const key = main.flow({ session: sessionId ?? "" });
  const live = !!sessionId && on;
  const moving = (set?: FlowSet | null) => running || set?.status === "building" || set?.status === "merging";
  const got = useQuery({ ...key, enabled: live, refetchInterval: (q) => (moving(q.state.data?.set) ? main.flow.poll!.ms : false) }).data;
  const cur: { flow: Flow | null; set: FlowSet | null } | null = live && got ? { flow: got.flow, set: got.set ?? null } : null;
  // A turn's start and end: read again at once (the poll covers the rest).
  // null while the session's transcript loads: its landing is no turn edge, the open read covers it.
  const was = useRef<string | null>(null);
  useEffect(() => {
    const prev = was.current;
    was.current = edge;
    if (edge === null || prev === null || prev === edge) return;
    if (live) void reread(key.queryKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edge]);
  const act = useCallback((a: FlowAct): Promise<void> => {
    if (!sessionId) return Promise.resolve();
    const call = a.kind === "set" ? api.setFlowOption(sessionId, a.key, a.on)
      : a.kind === "reset" ? api.resetFlow(sessionId) : api.flowSkipTo(sessionId, a.to);
    return call.then((r) => flowChanged(sessionId, r.flow));
  }, [sessionId]);
  return { flow: cur?.flow ?? null, set: cur?.set ?? null, pack: live && !!got?.pack, act };
}
