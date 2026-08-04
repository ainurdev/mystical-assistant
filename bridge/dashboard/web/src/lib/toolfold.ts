// Grouping runs of consecutive tool events in a transcript turn. Pure — the
// renderer decides what a "block" is, this only groups.

/** Events that render nothing, so they can't break a run. */
const INVISIBLE = new Set(["tool_done", "permission_resolved", "question_answered"]);

/** Shortest run worth folding — two chips is not yet noise. */
export const MIN_RUN = 3;

/**
 * Runs of `min`+ consecutive tool events matching `match`, ignoring events that
 * render nothing.
 *
 * Returns `folds`: the head index of each run mapped to every index in it (head
 * included), plus `headOf`: each non-head index mapped back to its head, so a
 * renderer knows which rows the head now draws.
 */
export function runsOf(
  events: { type: string }[],
  match: (i: number) => boolean,
  min: number,
): { folds: Map<number, number[]>; headOf: Map<number, number> } {
  const folds = new Map<number, number[]>();
  const headOf = new Map<number, number>();
  let run: number[] = [];

  const flush = () => {
    if (run.length >= min) {
      folds.set(run[0], run);
      for (const i of run.slice(1)) headOf.set(i, run[0]);
    }
    run = [];
  };

  events.forEach((e, i) => {
    if (e.type === "tool" && match(i)) {
      run.push(i);
    } else if (!INVISIBLE.has(e.type)) {
      flush();
    }
  });
  flush();
  return { folds, headOf };
}

/**
 * Group consecutive plain tool chips so a turn reads as commands and prose
 * instead of a wall of "READ x / GREP y" rows.
 *
 * `blocky(i)` marks tool events that draw a full block of their own (a Bash
 * terminal, an edit diff) — those break a run rather than joining it.
 */
export function foldChips(
  events: { type: string }[],
  blocky: (i: number) => boolean,
): { folds: Map<number, number[]>; headOf: Map<number, number> } {
  return runsOf(events, (i) => !blocky(i), MIN_RUN);
}
