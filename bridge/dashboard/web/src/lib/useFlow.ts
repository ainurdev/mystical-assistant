import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Flow, FlowOption, FlowSet } from "./flowview";

/* The open session's path for the prompt box's FLOW chip (Composer), read as the SESSION
   tab reads it: on the turn's edges, and every few seconds while a turn runs or its
   tickets build. A change made from the chip or from the SESSION tab goes out as one
   window event, so both show it at once instead of on their next read. */

export const FLOW_EVENT = "hud:flow";
export type FlowAct = { kind: "set"; key: FlowOption; on: boolean | null } | { kind: "reset" } | { kind: "skip"; to: string };

export function flowChanged(session: string, flow: Flow) {
  window.dispatchEvent(new CustomEvent(FLOW_EVENT, { detail: { session, flow } }));
}

/** `edge` changes on a turn's start and end (any string that does). */
export function useFlow(sessionId: string | undefined, on: boolean, edge: string, running: boolean) {
  const [st, setSt] = useState<{ sid: string; flow: Flow | null; set: FlowSet | null } | null>(null);
  const cur = on && st && st.sid === sessionId ? st : null;
  const busy = running || cur?.set?.status === "building" || cur?.set?.status === "merging";
  useEffect(() => {
    if (!sessionId || !on) return;
    let live = true;
    const read = () => api.getFlow(sessionId).then((r) => { if (live) setSt({ sid: sessionId, flow: r.flow, set: r.set ?? null }); }, () => {});
    read();
    const id = busy ? window.setInterval(read, 4000) : 0;
    return () => { live = false; window.clearInterval(id); };
  }, [sessionId, on, edge, busy]);
  useEffect(() => {
    const heard = (e: Event) => {
      const d = (e as CustomEvent<{ session: string; flow: Flow }>).detail;
      if (d.session === sessionId) setSt((s) => ({ sid: d.session, flow: d.flow, set: s?.sid === d.session ? s.set : null }));
    };
    window.addEventListener(FLOW_EVENT, heard);
    return () => window.removeEventListener(FLOW_EVENT, heard);
  }, [sessionId]);
  const act = useCallback((a: FlowAct): Promise<void> => {
    if (!sessionId) return Promise.resolve();
    const call = a.kind === "set" ? api.setFlowOption(sessionId, a.key, a.on)
      : a.kind === "reset" ? api.resetFlow(sessionId) : api.flowSkipTo(sessionId, a.to);
    return call.then((r) => flowChanged(sessionId, r.flow));
  }, [sessionId]);
  return { flow: cur?.flow ?? null, set: cur?.set ?? null, act };
}
