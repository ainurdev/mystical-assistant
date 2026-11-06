// The "said to you" tier: where a non-Claude agent's words go.
//
// An ACP agent narrates as it works. Kimi wrote 259 notes in 37 turns, one between
// most tool calls, and each drawn as a bubble makes the turn a wall you scroll past
// to reach its one answer. So its notes come out of the flow and sit in one place,
// the latest showing and the older ones behind a count. Everything else in the
// turn, tools and thinking alike, closes up into the work fold they were breaking
// apart. A Claude turn doesn't come here: its prose is few and it is the reply.
// Pure, like lib/segments, whose cut this reuses rather than repeats.

import { segmentsOf, type Seg } from "./segments.ts";

type Ev = { type: string; text?: string; result?: string };

export type SaidLayout = {
  segs: Seg[];
  /** Indices of the notes, oldest first. Not bound by `from`: an old note is still
   *  an old note, counted behind the latest. */
  notes: number[];
  /** The tier goes before this position in `segs`. */
  at: number;
};

/** A turn's closing rows stay under what it said; so does a card waiting on you. */
const CLOSING = new Set(["result", "stopped", "error"]);

export function resultOf(events: Ev[]): string {
  return (events.find((e) => e.type === "result")?.result ?? "").trim();
}

export function saidLayout(
  events: Ev[], from = 0, inFlow: (i: number) => boolean = () => false,
  atFoot: (i: number) => boolean = () => false,
): SaidLayout {
  const result = resultOf(events);
  const isNote = (e: Ev) => e.type === "text" && !!e.text && e.text.trim() !== result;
  const notes: number[] = [];
  events.forEach((e, i) => { if (isNote(e)) notes.push(i); });

  // Seen through segmentsOf: text is bookkeeping that cuts nothing, and a thought is
  // a step. Text left in a stretch is taken back out below.
  const seen = events.map((e): Ev => {
    if (e.type === "text") return { type: "tool_done" };   // a note, or the answer the result card draws
    if (e.type === "thinking" && e.text) return { type: "log" };
    return e;
  });
  const dropped = new Set(events.flatMap((e, i) => (e.type === "text" ? [i] : [])));
  const segs = segmentsOf(seen, from, inFlow, atFoot)
    .map((s) => (s.kind === "steps" ? { ...s, idx: s.idx.filter((i) => !dropped.has(i)) } : s));

  let at = segs.length;
  while (at > 0) {
    const s = segs[at - 1];
    const i = s.idx[0];
    if (s.kind !== "prose" || !(CLOSING.has(events[i].type) || atFoot(i))) break;
    at--;
  }
  return { segs, notes, at };
}

/** How a turn with no answer ended, for labelling its last note. Null when it
 *  answered, or hasn't ended. */
export function endedWithout(events: Ev[], ended: boolean): "stopped" | "cut" | null {
  if (!ended || resultOf(events)) return null;
  return events.some((e) => e.type === "stopped") ? "stopped" : "cut";
}
