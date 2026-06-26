import type { Question, RunEvent, Transcript } from "./api";

export interface PendingRequest {
  request_id: string;
  kind: "permission" | "question";
  tool_name: string;
  summary?: string;
  questions?: Question[];
}

export interface Turn {
  id: string;
  prompt: string;
  events: RunEvent[];
  status: "running" | "done" | "error";
  pending: PendingRequest[];
  // Images sent with the prompt. Client-sent turns carry data: URLs (rendered
  // inline); turns rehydrated from the store carry server paths (shown as a chip,
  // since the upload files are cleaned up after the run).
  attachments?: string[];
}

export function derivePending(events: RunEvent[]): PendingRequest[] {
  const resolved = new Set<string>();
  for (const e of events) {
    if (e.type === "permission_resolved" || e.type === "question_answered")
      resolved.add(e.request_id);
  }
  const out: PendingRequest[] = [];
  for (const e of events) {
    if (e.type === "permission" && !resolved.has(e.request_id))
      out.push({ request_id: e.request_id, kind: "permission", tool_name: e.tool_name, summary: e.summary });
    else if (e.type === "question" && !resolved.has(e.request_id))
      out.push({ request_id: e.request_id, kind: "question", tool_name: "AskUserQuestion", questions: e.questions });
  }
  return out;
}

function seqOf(e: RunEvent): number | undefined {
  return (e as { seq?: number }).seq;
}

/** Upsert turns by id, append events by session seq (dedup). Mirrors the phone. */
export function mergeDelta(prev: Turn[], t: Transcript): Turn[] {
  const map = new Map<string, Turn>(prev.map((x) => [x.id, x]));
  const storeSeq = new Map<string, number>();
  for (const st of t.turns) {
    storeSeq.set(st.id, st.seq);
    const ex = map.get(st.id);
    // Prefer attachments the client already holds (data: URLs we can render) over
    // the store's server paths; fall back to the store for rehydrated turns.
    if (ex)
      map.set(st.id, {
        ...ex,
        status: st.status,
        prompt: ex.prompt || st.prompt,
        attachments: ex.attachments?.length ? ex.attachments : st.attachments,
      });
    else
      map.set(st.id, {
        id: st.id,
        prompt: st.prompt,
        events: [],
        status: st.status,
        pending: [],
        attachments: st.attachments,
      });
  }
  for (const ev of t.events) {
    const turn = map.get(ev.turn_id);
    if (!turn) continue;
    if (turn.events.some((e) => seqOf(e) === ev.seq)) continue;
    map.set(ev.turn_id, { ...turn, events: [...turn.events, ev] });
  }
  const out = [...map.values()].map((turn) => ({ ...turn, pending: derivePending(turn.events) }));
  out.sort(
    (a, b) =>
      (storeSeq.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (storeSeq.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  return out;
}

export function activeOf(turns: Turn[]): Turn | null {
  const last = turns[turns.length - 1];
  return last && last.status === "running" ? last : null;
}

/** Rough client-side estimate of the conversation's context size. The backend
 *  records no token counts, so we approximate at ~4 chars/token over the visible
 *  prompt + event text. Good enough to surface "getting big — consider /compact". */
export function estimateContextTokens(turns: Turn[]): number {
  let chars = 0;
  for (const t of turns) {
    chars += t.prompt.length;
    for (const e of t.events) {
      if (e.type === "text") chars += e.text.length;
      else if (e.type === "tool") chars += e.name.length + e.summary.length;
      else if (e.type === "result") chars += e.result.length;
      else if (e.type === "error") chars += e.message.length;
    }
  }
  return Math.round(chars / 4);
}
