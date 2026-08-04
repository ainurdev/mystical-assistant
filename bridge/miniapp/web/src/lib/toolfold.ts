// Folding runs of plain tool chips in a transcript turn. Pure — the renderer
// decides what a "block" is, this only groups.

/** Events that render nothing, so they can't break a run of chips. */
const INVISIBLE = new Set(["tool_done", "permission_resolved", "question_answered"]);

/** Shortest run worth folding — two chips is not yet noise. */
export const MIN_RUN = 3;

/**
 * Group consecutive plain tool chips so a turn reads as commands and prose
 * instead of a wall of "READ x / GREP y" rows.
 *
 * `blocky(i)` marks tool events that draw a full block of their own (a Bash
 * terminal, an edit diff) — those break a run rather than joining it.
 *
 * Returns the head index of each fold mapped to every index in it (head
 * included), plus `headOf`: each swallowed index mapped back to its head, so a
 * renderer that opens a fold knows which rows to bring back.
 */
export function foldChips(
  events: { type: string }[],
  blocky: (i: number) => boolean,
): { folds: Map<number, number[]>; headOf: Map<number, number> } {
  const folds = new Map<number, number[]>();
  const headOf = new Map<number, number>();
  let run: number[] = [];

  const flush = () => {
    if (run.length >= MIN_RUN) {
      folds.set(run[0], run);
      for (const i of run.slice(1)) headOf.set(i, run[0]);
    }
    run = [];
  };

  events.forEach((e, i) => {
    if (e.type === "tool" && !blocky(i)) {
      run.push(i);
    } else if (!INVISIBLE.has(e.type)) {
      flush();
    }
  });
  flush();
  return { folds, headOf };
}
