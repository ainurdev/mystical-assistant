// Cutting a turn into what was SAID and what was DONE. Pure — the renderer
// decides how a fold draws, this only decides what goes in one.
//
// A turn used to render as one flat column: a thought, four commands, a
// paragraph, a thought, an edit, the answer — and the paragraph, which is the
// one thing in it you came to read, was a row like the others. So the stream is
// cut at every piece of prose, and everything between two pieces of prose is
// folded into one STEPS row (what it ran, edited, read). The prose stays in the
// flow at full size; the work sits under a one-line header until you open it.
//
// A thought is prose. What reaches us as `thinking` with text is the agent's
// own status line — "the list is right now; next, the two console errors" —
// and the CLI sometimes hands back a message written just before a tool call
// as exactly that, reworded, so the same kind of sentence lands as `text` one
// time and `thinking` the next. It used to sit under its own THINKING fold,
// shut: the messages that happened to be reworded were the ones you never saw,
// and a block's thoughts sat in one pile away from the steps they named. Now
// each stays where it was said, and the steps after it fold under it:
// thought, steps, thought, steps.

/** Only what the cut reads: the discriminator, plus the text that decides
 *  whether a `thinking` event is a thought or just a pause. */
type Ev = { type: string; text?: string };

export type SegKind = "prose" | "steps";

/** A contiguous-in-meaning slice of a turn: `idx` are indices into the events
 *  array, ascending. A prose segment is always exactly one event. `start` is
 *  where the segment's stretch begins in the whole turn, even when `from` cut
 *  it — the name a renderer keys a fold by. */
export type Seg = { kind: SegKind; idx: number[]; start: number };

/** The conversation itself — the agent's words, the answer, your steers, and
 *  anything that asks you something. Each of these breaks the work around it,
 *  the way a paragraph breaks a run of chips. `error` and `stopped` are here
 *  because they end the turn and must never hide inside a fold; `divider` (a
 *  device run's "Mystical restarted") because a stretch with no tool in it
 *  draws nothing, and the line would go with it. */
const PROSE = new Set(["text", "result", "steer", "permission", "question", "error", "stopped", "divider"]);

/** Events that render a row when they land in a steps fold. `tool_done`,
 *  `permission_resolved` and a textless `thinking` inside a run draw nothing,
 *  so a block holding only those is not a fold worth a header. */
const STEP = new Set(["tool", "log"]);

/**
 * Cut `events[from..]` into prose and steps segments: every prose event and
 * every thought with text is its own segment, and whatever lies between two of
 * them is one steps fold — dropped when nothing in it draws (bookkeeping, a
 * textless thinking, which is a pause).
 *
 * `inFlow(i)` cuts a step out as if it were prose: a tool that came back with a
 * picture, which a shut fold would hide. The caller decides — the picture rides
 * on the paired tool_done, which this doesn't read.
 *
 * `atFoot(i)` lifts an event out of the flow and draws it last, from behind
 * `from` too: a card still waiting on you. Background agents keep streaming
 * after the main thread asks, which pushed the card up the turn and then behind
 * EARLIER STEPS while the sidebar said NEEDS YOU. Once answered it goes back to
 * where it was asked.
 */
export function segmentsOf(
  events: Ev[], from = 0, inFlow: (i: number) => boolean = () => false,
  atFoot: (i: number) => boolean = () => false,
): Seg[] {
  const out: Seg[] = [];
  const cuts = (i: number) => {
    const e = events[i];
    return PROSE.has(e.type) || (e.type === "thinking" && !!e.text) || inFlow(i);
  };
  // The stretch `from` lands in starts back at the prose before it. The tail
  // window moves `from` on every event of a long running turn, and a fold named
  // by its first row on screen was a new fold each time: one you'd opened
  // mounted shut again.
  let start = from;
  while (start > 0 && (atFoot(start - 1) || !cuts(start - 1))) start--;
  let steps: number[] = [];
  let stepsSeen = false;

  const flush = () => {
    if (steps.length && stepsSeen) out.push({ kind: "steps", idx: steps, start });
    steps = [];
    stepsSeen = false;
  };

  const foot: Seg[] = [];
  for (let i = 0; i < events.length; i++) if (atFoot(i)) foot.push({ kind: "prose", idx: [i], start: i });

  for (let i = from; i < events.length; i++) {
    if (atFoot(i)) continue;
    if (cuts(i)) {
      flush();
      out.push({ kind: "prose", idx: [i], start: i });
      start = i + 1;
    } else {
      steps.push(i);
      if (STEP.has(events[i].type)) stepsSeen = true;
    }
  }
  flush();
  return out.concat(foot);
}

/** What one step was, for the fold's header. The renderer classifies (it has
 *  the tool_done pairing that says whether a call carried a patch); this only
 *  counts and phrases. */
export type StepCat =
  | "command" | "edit" | "read" | "write" | "search" | "fetch" | "call"
  | "agent" | "skill" | "log" | "step";

/** The order the header lists categories in: what changed the machine first,
 *  what only looked at it last. */
export const CAT_ORDER: StepCat[] = [
  "command", "edit", "write", "agent", "skill", "call", "fetch", "search", "read", "log", "step",
];

const CAT_WORD: Record<StepCat, [string, string]> = {
  command: ["command", "commands"],
  edit: ["edit", "edits"],
  write: ["file written", "files written"],
  agent: ["agent", "agents"],
  skill: ["skill", "skills"],
  call: ["call", "calls"],
  fetch: ["fetch", "fetches"],
  search: ["search", "searches"],
  read: ["file read", "files read"],
  log: ["log line", "log lines"],
  step: ["step", "steps"],
};

/** "3 commands · 2 edits · 5 files read" — the fold's title. Empty for no
 *  steps, which a caller should treat as "draw nothing". */
export function stepsTitle(cats: StepCat[]): string {
  const n = new Map<StepCat, number>();
  for (const c of cats) n.set(c, (n.get(c) ?? 0) + 1);
  return CAT_ORDER
    .filter((c) => n.has(c))
    .map((c) => `${n.get(c)} ${CAT_WORD[c][n.get(c) === 1 ? 0 : 1]}`)
    .join(" · ");
}
