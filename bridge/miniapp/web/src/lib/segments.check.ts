// Run: node bridge/miniapp/web/src/lib/segments.check.ts
import { segmentsOf, stepsTitle } from "./segments.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const t = (type: string, text?: string) => ({ type, text });
const kinds = (evs: { type: string; text?: string }[], from = 0) =>
  segmentsOf(evs, from).map((s) => `${s.kind}:${s.idx.join(",")}`).join(" ");

// A thought, two commands, a paragraph, then the answer: one fold, four prose rows.
{
  const evs = [t("thinking", "hm"), t("tool"), t("tool_done"), t("tool"), t("tool_done"), t("text", "here"), t("result")];
  ok(kinds(evs) === "prose:0 steps:1,2,3,4 prose:5 prose:6", `basic cut: ${kinds(evs)}`);
}

// Acting before a thought keeps the order the turn had.
{
  const evs = [t("tool"), t("tool_done"), t("thinking", "so"), t("text", "x")];
  ok(kinds(evs) === "steps:0,1 prose:2 prose:3", `steps-first block: ${kinds(evs)}`);
}

// A thought stays where it was said, and the tools after it fold under it —
// thought, steps, thought, steps, never all the thoughts in one pile.
{
  const evs = [t("thinking", "a"), t("tool"), t("thinking", "b"), t("tool"), t("thinking", "c"), t("result")];
  ok(kinds(evs) === "prose:0 steps:1 prose:2 steps:3 prose:4 prose:5", `interleaved: ${kinds(evs)}`);
}

// A textless thinking is a pause, not a thought: it rides with the steps.
{
  const evs = [t("thinking"), t("tool"), t("tool_done"), t("text", "x")];
  ok(kinds(evs) === "steps:0,1,2 prose:3", `pause joins steps: ${kinds(evs)}`);
}

// Bookkeeping alone (a resolved permission, a stray tool_done) is no fold.
{
  const evs = [t("permission"), t("permission_resolved"), t("text", "x")];
  ok(kinds(evs) === "prose:0 prose:2", `bookkeeping dropped: ${kinds(evs)}`);
}

// A lone pause between two paragraphs is not worth a header either.
{
  const evs = [t("text", "a"), t("thinking"), t("text", "b")];
  ok(kinds(evs) === "prose:0 prose:2", `lone pause dropped: ${kinds(evs)}`);
}

// Every prose type breaks the work, including the ones that end a turn.
{
  for (const p of ["text", "result", "steer", "permission", "question", "error", "stopped"]) {
    const evs = [t("tool"), t(p, "x"), t("tool")];
    ok(kinds(evs) === `steps:0 prose:1 steps:2`, `${p} breaks a block`);
  }
}

// A step the caller marks as in the flow (a tool that came back with a picture)
// breaks the work like prose does — a shut STEPS fold would hide the picture.
{
  const evs = [t("tool"), t("tool_done"), t("tool"), t("tool_done"), t("tool"), t("text", "x")];
  const cut = segmentsOf(evs, 0, (i) => i === 2).map((s) => `${s.kind}:${s.idx.join(",")}`).join(" ");
  ok(cut === "steps:0,1 prose:2 steps:3,4 prose:5", `a shot leaves the fold: ${cut}`);
}

// A log line is a step; a hook's output belongs with the work, not the words.
{
  const evs = [t("log", "hook said"), t("text", "x")];
  ok(kinds(evs) === "steps:0 prose:1", "a log is a step");
}

// `from` starts the cut mid-turn and indices stay absolute.
{
  const evs = [t("tool"), t("text", "a"), t("thinking", "b"), t("tool"), t("result")];
  ok(kinds(evs, 2) === "prose:2 steps:3 prose:4", `from=2: ${kinds(evs, 2)}`);
  ok(kinds([]) === "", "empty turn, no segments");
}

// The title counts, pluralises and orders: what changed the machine first.
{
  ok(stepsTitle(["read", "command", "read", "edit", "command", "command"]) === "3 commands · 1 edit · 2 files read",
     "title orders commands, edits, reads");
  ok(stepsTitle(["read"]) === "1 file read", "singular read");
  ok(stepsTitle(["search", "search", "fetch", "call", "agent", "log", "step", "write"])
     === "1 file written · 1 agent · 1 call · 1 fetch · 2 searches · 1 log line · 1 step",
     "every category phrases");
  ok(stepsTitle([]) === "", "no steps, no title");
}

console.log("segments.check: all ok");
