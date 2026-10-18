// DOSSIER's one structural idea: a turn has three tiers, and only one of them
// is work. Pure — RunStream decides how each tier draws, this decides which
// tier a segment is in and what the WORK header says about the ones it hides.
//
// The other five languages rank rows against each other: a fold is a row, a
// paragraph is a row, the answer is a bigger row. Read on a phone that is a
// column of equally-boxed things in which the two you came for — what you
// asked and what you got back — are found by reading all of it. DOSSIER ranks
// tiers instead:
//
//   1  your prompt and the turn's answer   (Transcript / FinalResult) — and
//      a steer, which is yours too          (RunStream, drawn as a prompt)
//   2  anything waiting on you              (question, permission)
//   3  everything between                   (thoughts, interim notes, tools,
//                                            hooks) — one WORK zone
//
// so `zonesOf` cuts segmentsOf's output at every tier-1/2 segment and wraps each
// run of the rest in one zone. An error or a stop ends the turn, and lib/segments
// already refuses to hide those in a fold; a zone is a fold, so they stay out too.

import type { Seg, StepCat } from "./segments";

/** What a segment's head event is, for the cut — the renderer's own view of it
 *  (a `text` that a question card follows reads as the answer, so the caller
 *  says which segments are tier 1/2; this module never sees event payloads). */
export type Zone = { kind: "top" | "work"; segs: Seg[] };

/** Event types that are tier 1 or 2 by type alone: the answer and what ends a
 *  turn, what waits on you, and your steer — yours, so never inside the work
 *  (it used to be a row in the zone, hidden whenever the zone was shut). A
 *  `text` is the renderer's call (the last one is the answer, one a card
 *  follows introduces it), so it is not here. */
export const TOP_TYPES: ReadonlySet<string> = new Set([
  "result", "question", "permission", "error", "stopped", "steer",
]);

/** Cut segments into zones: every `isTop` segment is its own zone, and each
 *  maximal run of the others is one work zone. Order is the turn's. */
export function zonesOf(segs: Seg[], isTop: (s: Seg) => boolean): Zone[] {
  const out: Zone[] = [];
  for (const s of segs) {
    if (isTop(s)) { out.push({ kind: "top", segs: [s] }); continue; }
    const last = out[out.length - 1];
    if (last && last.kind === "work") last.segs.push(s);
    else out.push({ kind: "work", segs: [s] });
  }
  return out;
}

/** One glyph per thing the zone holds, for the header's strip — so a shut
 *  zone still shows its shape (three commands then a note then a failure)
 *  without opening it. The same glyphs head the rows inside. */
export type Mark = "think" | "note" | "hook" | StepCat | "fail";

export const MARK_GLYPH: Record<Mark, string> = {
  think: "∴", note: "◆", hook: "⚙", fail: "✕",
  command: "$", edit: "✎", write: "✎", read: "◧", search: "⌕", fetch: "⇄",
  call: "⌁", agent: "◈", log: "⚙", step: "·",
};

/** Past this many the strip stops being a shape and starts being a ruler. */
export const STRIP_MAX = 28;

/** The strip, capped: the first STRIP_MAX marks and how many more there are. */
export function stripOf(marks: Mark[]): { shown: Mark[]; more: number } {
  return marks.length <= STRIP_MAX
    ? { shown: marks, more: 0 }
    : { shown: marks.slice(0, STRIP_MAX), more: marks.length - STRIP_MAX };
}

/** The header's words: what it ran (stepsTitle's own words, passed in) and how
 *  many times the agent spoke inside it. Thoughts and interim notes are both
 *  "notes" here — the distinction is drawn by the rows, not the count. */
export function workTitle(steps: string, notes: number): string {
  const n = notes ? `${notes} note${notes === 1 ? "" : "s"}` : "";
  return [steps, n].filter(Boolean).join(" · ");
}
