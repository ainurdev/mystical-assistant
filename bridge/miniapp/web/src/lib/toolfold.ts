// Grouping runs of consecutive tool events in a transcript turn. Pure — the
// renderer decides what a "block" is, this only groups.
//
// The dashboard carries its own copy (bridge/dashboard/web/src/lib/toolfold.ts)
// for the reason lib/tools.ts is duplicated: two separate Vite builds.

/** Events that render nothing, so they can't break a run of chips. */
const INVISIBLE = new Set(["tool_done", "permission_resolved", "question_answered"]);

/** Shortest run worth folding — two chips is not yet noise. */
export const MIN_RUN = 3;

/**
 * Runs of `min`+ consecutive tool events sharing a key, ignoring events that
 * render nothing. `keyOf` returns null for events that group with nothing; a
 * different key starts a new run, so two MCP servers never share one card.
 */
export function runsOf(
  events: { type: string }[],
  keyOf: (i: number) => string | null,
  min: number,
): { folds: Map<number, number[]>; headOf: Map<number, number> } {
  const folds = new Map<number, number[]>();
  const headOf = new Map<number, number>();
  let run: number[] = [];
  let key: string | null = null;

  const flush = () => {
    if (run.length >= min) {
      folds.set(run[0], run);
      for (const i of run.slice(1)) headOf.set(i, run[0]);
    }
    run = [];
    key = null;
  };

  events.forEach((e, i) => {
    const k = e.type === "tool" ? keyOf(i) : null;
    if (k !== null) {
      if (k !== key) flush();
      key = k;
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
 *
 * Returns the head index of each fold mapped to every index in it (head
 * included), plus `headOf`: each swallowed index mapped back to its head, so a
 * renderer that opens a fold knows which rows to bring back.
 */
export function foldChips(
  events: { type: string }[],
  blocky: (i: number) => boolean,
): { folds: Map<number, number[]>; headOf: Map<number, number> } {
  return runsOf(events, (i) => (blocky(i) ? null : "chip"), MIN_RUN);
}


/**
 * Pull a render cut back so no visible event is orphaned. A folded run is drawn
 * entirely by its head, and its other members draw nothing — so cutting between
 * a head and its members would render neither, and those events would silently
 * vanish. Returns the earliest head owning anything at or after `cut`.
 *
 * Checking only `events[cut]` is not enough: an INVISIBLE event joins no run but
 * doesn't break one either, so a run can straddle the cut without `cut` itself
 * belonging to it.
 */
export function headSafeCut(
  count: number,
  cut: number,
  ...heads: Map<number, number>[]
): number {
  if (cut <= 0) return 0;
  let from = cut;
  for (let i = cut; i < count; i++)
    for (const h of heads) from = Math.min(from, h.get(i) ?? i);
  return from;
}
