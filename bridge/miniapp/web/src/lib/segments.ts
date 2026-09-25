// Trimmed copy of bridge/dashboard/web/src/lib/segments.ts — that file is the
// source of truth, same as the langfor / stick / toolfold pairs.
//
// Cutting a turn into what was SAID and what was DONE. Pure — the renderer
// decides how a fold draws, this only decides what goes in one.
//
// A turn used to render as one flat column: a thought, four commands, a
// paragraph, a thought, an edit, the answer — and the paragraph, which is the
// one thing in it you came to read, was a row like the others. So the stream is
// cut at every piece of prose, and everything between two pieces of prose is
// folded into at most two rows: THINKING (what the model reasoned) and STEPS
// (what it ran, edited, read). The prose stays in the flow at full size; the
// work sits under a one-line header until you open it.
//
// Why two folds and not one: a thought is the model talking to itself and a
// command is the model touching the machine — the reader who wants one rarely
// wants the other, and a single "work" fold would put a 40-line reasoning block
// above the diff you opened it for.

/** Only what the cut reads: the discriminator, plus the text that decides
 *  whether a `thinking` event is a thought or just a pause. */
type Ev = { type: string; text?: string };

export type SegKind = "prose" | "thinking" | "steps";

/** A contiguous-in-meaning slice of a turn: `idx` are indices into the events
 *  array, ascending. A prose segment is always exactly one event. */
export type Seg = { kind: SegKind; idx: number[] };

/** The conversation itself — the agent's words, the answer, your steers, and
 *  anything that asks you something. Each of these breaks the work around it,
 *  the way a paragraph breaks a run of chips. `error` and `stopped` are here
 *  because they end the turn and must never hide inside a fold. */
const PROSE = new Set(["text", "result", "steer", "permission", "question", "error", "stopped"]);

/** Events that render a row when they land in a steps fold. `tool_done`,
 *  `permission_resolved` and a textless `thinking` inside a run draw nothing,
 *  so a block holding only those is not a fold worth a header. */
const STEP = new Set(["tool", "log"]);

/**
 * Cut `events[from..]` into prose, thinking and steps segments. Between two
 * prose events there are at most two folds, ordered by where each began —
 * thinking first when the model reasoned before it acted, steps first when it
 * acted and reasoned afterwards. A block with no thought yields only STEPS; a
 * block with no visible step yields only THINKING; a block of nothing but
 * bookkeeping events is dropped (they render nothing).
 */
export function segmentsOf(events: Ev[], from = 0): Seg[] {
  const out: Seg[] = [];
  let think: number[] = [];
  let steps: number[] = [];
  let stepsSeen = false;

  const flush = () => {
    const t: Seg | null = think.length ? { kind: "thinking", idx: think } : null;
    const s: Seg | null = steps.length && stepsSeen ? { kind: "steps", idx: steps } : null;
    if (t && s) {
      if (t.idx[0] < s.idx[0]) out.push(t, s);
      else out.push(s, t);
    } else if (t) out.push(t);
    else if (s) out.push(s);
    think = [];
    steps = [];
    stepsSeen = false;
  };

  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (PROSE.has(e.type)) {
      flush();
      out.push({ kind: "prose", idx: [i] });
    } else if (e.type === "thinking" && e.text) {
      think.push(i);
    } else {
      steps.push(i);
      if (STEP.has(e.type)) stepsSeen = true;
    }
  }
  flush();
  return out;
}

/** What one step was, for the fold's header. The renderer classifies (it has
 *  the tool_done pairing that says whether a call carried a patch); this only
 *  counts and phrases. */
export type StepCat =
  | "command" | "edit" | "read" | "write" | "search" | "fetch" | "call"
  | "agent" | "log" | "step";

/** The order the header lists categories in: what changed the machine first,
 *  what only looked at it last. */
const CAT_ORDER: StepCat[] = [
  "command", "edit", "write", "agent", "call", "fetch", "search", "read", "log", "step",
];

const CAT_WORD: Record<StepCat, [string, string]> = {
  command: ["command", "commands"],
  edit: ["edit", "edits"],
  write: ["file written", "files written"],
  agent: ["agent", "agents"],
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
