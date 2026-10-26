// Run: node bridge/dashboard/web/src/lib/checkpoints.check.ts
// The TURNS tab's rows: your prompts numbered, the bridge's resumes folded into
// the turn they carry on, each turn outlined from its events when the chat has
// them and from the bridge's summary when it doesn't.
import type { Turn } from "../chat.ts";
import { fmtElapsed, resumeOf, timeSplit, toolName, turnRows } from "./checkpoints.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const RESTART = "⏮ You were interrupted mid-task by a bridge restart — not by the user. Review your recent transcript and continue exactly where you left off; finish the task you were doing. Don't start over.";
const LIMIT = "⏮ Your previous turn was cut off because the Claude usage limit was reached — not by the user. It has been resumed on another account. Review your recent transcript and continue exactly where you left off; finish the task you were doing. Don't start over.";
const ERROR = "⏮ Your previous turn was cut off by an error — not by the user. Review your recent transcript and continue exactly where you left off; finish the task you were doing. Don't start over.";

const turn = (id: string, prompt: string, over: Partial<Turn> = {}): Turn =>
  ({ id, prompt, events: [], status: "done", pending: [], started: 1000, ...over });

// --- what a resume is ---------------------------------------------------------
eq(resumeOf(LIMIT), "limit", "a usage-limit nudge");
eq(resumeOf(RESTART), "restart", "a bridge-restart nudge");
eq(resumeOf(ERROR), "error", "an error nudge");
eq(resumeOf("⏮ go on"), "error", "any other ⏮ nudge reads as an error resume");
eq(resumeOf("go"), null, "your own words are not a resume");

// --- numbering and folding ----------------------------------------------------
{
  const rows = turnRows([
    turn("a", "first", { elapsed: 60 }),
    turn("b", "go", { status: "error", elapsed: null, started: 2000, outcome: { code: "interrupted", label: "INTERRUPTED", detail: "" },
      sum: { answer: "", tools: 4, marks: [{ kind: "question", id: "q1", label: "Rijscholen", pick: "Approve", note: null }], ended: 2358 } }),
    turn("c", RESTART, { status: "error", elapsed: null, started: 2400, sum: { answer: "", tools: 2, marks: [], ended: 2717 } }),
    turn("d", RESTART, { elapsed: 552, started: 2800, sum: { answer: "Rijscholen is pushed.", tools: 3, marks: [], ended: 3352 } }),
    turn("e", "next", { elapsed: 10, started: 4000 }),
  ]);
  eq(rows.map((r) => r.n), [1, 2, 3], "resumes don't take a number");
  eq(rows[1].ids, ["b", "c", "d"], "the resumes fold into the turn they carry on");
  eq(rows[1].parts, [358, 317, 552], "a killed turn runs from its start to its last event");
  eq(rows[1].secs, 1227, "the row's time is its parts summed");
  eq(rows[1].status, "done", "a turn that resumed and finished reads as done");
  eq(rows[1].outcome, null, "and carries no failure");
  eq(rows[1].answer, "Rijscholen is pushed.", "the answer is the chain's last");
  eq(rows[1].tools, 9, "tools add up across the chain");
  eq(rows[1].resumes, ["restart", "restart"], "what cut it, in order");
  eq(rows[1].subs.map((s) => s.kind), ["question", "resume", "resume"], "asks and resumes in transcript order");
  eq(rows[1].subs[1], { kind: "resume", turnId: "c", why: "restart", at: 2400 }, "a resume names its own turn");
}

// --- a chain that is still broken ---------------------------------------------
{
  const rows = turnRows([turn("a", "ship it", { status: "error", elapsed: 2810, outcome: { code: "limit", label: "USAGE LIMIT", detail: "" } })]);
  eq([rows[0].status, rows[0].outcome], ["error", "USAGE LIMIT"], "a turn that failed last says why");
}

// --- outline from the chat's own events ----------------------------------------
{
  const t = turn("a", "build it", {
    status: "running", started: 100,
    events: [
      { type: "tool", name: "Bash", summary: "ls" },
      { type: "question", request_id: "q1", questions: [{ question: "Which?", header: "Design", options: [] }] },
      { type: "question_answered", request_id: "q1", answers: [{ header: "Design", labels: ["A · Map"] }] },
      { type: "steer", text: "also mobile" },
      { type: "question", request_id: "q2", questions: [{ question: "Push?", header: "Push", options: [] }] },
      { type: "result", result: "\n**Done.** All green.\nmore", cost: 0, elapsed: 0 },
    ],
    pending: [{ request_id: "q2", kind: "question", tool_name: "AskUserQuestion" }],
  });
  const [r] = turnRows([t], 234);
  eq(r.answer, "Done. All green.", "the answer's first line, its markdown marks gone");
  eq(r.tools, 1, "tools counted from the events");
  eq(r.secs, 134, "a running turn's time runs to now");
  eq(r.waiting, "question", "an open question is what it waits on");
  eq(r.subs, [
    { kind: "question", turnId: "a", key: "q1", label: "Design", pick: "A · Map", note: null, open: false },
    { kind: "steer", turnId: "a", key: "steer3", label: "also mobile" },
    { kind: "question", turnId: "a", key: "q2", label: "Push", pick: null, note: null, open: true },
  ], "asks carry your pick, steers their index, the open one is open");
}

// --- outline from the bridge's summary ----------------------------------------
{
  const [r] = turnRows([turn("a", "old one", {
    elapsed: 30,
    sum: { answer: "## Shipped `x_y`.", tools: 7, ended: 1030,
      marks: [{ kind: "steer", i: 5, label: "faster" }, { kind: "question", id: "q9", label: "Push", pick: null, note: "not yet" }] },
  })]);
  eq(r.answer, "Shipped x_y.", "a summary's answer is cleaned the same way");
  eq(r.subs, [
    { kind: "steer", turnId: "a", key: "steer5", label: "faster" },
    { kind: "question", turnId: "a", key: "q9", label: "Push", pick: null, note: "not yet", open: false },
  ], "summary marks become the same sub rows");
}

// --- carried over from the dropdown's checks ----------------------------------
{
  // A turn with no words of yours (the bridge's own follow-up) takes no number;
  // its marks join the turn above, still anchored on their own index.
  const rows = turnRows([
    turn("t1", "first", { events: [{ type: "steer", text: "actually, stop" }] }),
    turn("t2", "", { events: [{ type: "text", text: "resumed" }, { type: "steer", text: "and this" }] }),
    turn("t3", "second"),
  ]);
  eq(rows.map((r) => r.n), [1, 2], "a promptless turn takes no number");
  eq(rows[0].ids, ["t1", "t2"], "it folds into the turn above");
  eq(rows[0].subs.map((x) => x.kind === "steer" && x.key), ["steer0", "steer1"], "steers anchor on their own turn's index");
  eq(rows[0].subs.map((x) => x.turnId), ["t1", "t2"], "and on their own turn");
}
{
  const [a] = turnRows([turn("t1", "p", { events: [{ type: "result", result: "boom", cost: 0, elapsed: 41, is_error: true }] })]);
  eq([a.status, a.secs], ["error", 41], "an errored result fails the turn, and its elapsed is the time when the store has none");
  const [b] = turnRows([turn("t2", "p", { events: [{ type: "stopped" }] })]);
  eq([b.stopped, b.status], [true, "done"], "a stop is not a failure");
  const [c] = turnRows([turn("t3", "p", { status: "error" })]);
  eq(c.status, "error", "a turn that died mid-flight is failed with no result event");
}
{
  const q = { type: "question" as const, request_id: "r1", questions: [{ header: "Scope", question: "?", options: [] }] };
  const [live] = turnRows([turn("t1", "p", { events: [q], status: "running", pending: [{ request_id: "r1", kind: "question", tool_name: "AskUserQuestion" }] })]);
  eq([live.waiting, live.subs[0].kind === "question" && live.subs[0].open], ["question", true], "an unanswered question flags the turn");
  const [dead] = turnRows([turn("t1", "p", { events: [q], status: "error" })]);
  eq([dead.waiting, dead.subs[0].kind === "question" && dead.subs[0].open], [null, false], "a question whose turn ended stops waiting");
  const [perm] = turnRows([turn("t1", "p", { status: "running", pending: [{ request_id: "r2", kind: "permission", tool_name: "Bash" }] })]);
  eq(perm.waiting, "permission", "a permission it waits on is named as such");
}

// --- a pick reads as what you chose -------------------------------------------
{
  const [r] = turnRows([turn("a", "p", { sum: { answer: "", tools: 0, ended: null,
    marks: [{ kind: "question", id: "q", label: "Push", pick: "Push & open draft PR (Recommended)", note: null }] } })]);
  eq(r.subs[0].kind === "question" && r.subs[0].pick, "Push & open draft PR", "the option's (Recommended) tag is the model's, not your pick");
}

// --- anchors as the chat draws them, answers from prose, ends ------------------
{
  const [r] = turnRows([turn("a", "p", { events: [
    { type: "tool", name: "AskUserQuestion", summary: "" },
    { type: "tool", name: "Bash", summary: "ls" },
    { type: "steer", text: "faster" },
    { type: "text", text: "First reply." },
    { type: "text", text: "The last word.\nmore" },
  ] })]);
  eq(r.subs[0].kind === "steer" && r.subs[0].key, "steer1", "a steer after an ask anchors where RunStream draws it");
  eq(r.tools, 1, "the ask's own tool row isn't a tool you'd count");
  eq(r.answer, "The last word.", "a turn with no result answers with its last prose");
}
{
  const rows = turnRows([
    turn("a", "ship", { status: "error", elapsed: 60, started: 1000 }),
    turn("b", LIMIT, { elapsed: 30, started: 9000 }),
  ]);
  eq(rows[0].ended, 9030, "a chain ends where its last turn does, not at its start plus the summed time");
}

// --- the prompt, as one line ---------------------------------------------------
eq(turnRows([turn("a", "  two\n\nlines  ")])[0].prompt, "two lines", "a prompt reads as one line");

// --- durations ------------------------------------------------------------------
eq([fmtElapsed(31), fmtElapsed(1172), fmtElapsed(4787)], ["31s", "19m 32s", "1h 19m"], "an hour rolls over");

// --- the TIME dock ----------------------------------------------------------------
{
  const spend = (union_s: number, calls = 1) => ({ calls, union_s, naive_s: union_s, avg_s: union_s / calls, unfinished: 0 });
  const t = timeSplit({
    wall: 600, thinking_s: 200, waiting_s: 50, model_s: 150, tokens: null, capped: 0, turns: 2,
    tools: { Read: spend(5, 3), Bash: spend(120, 9), mcp__playwright__browser_click: spend(60), Edit: spend(1, 2) },
  }, 2);
  eq(t.tools.map((x) => x.name), ["Bash", "playwright · browser_click"], "tools rank by real time, MCP names shortened");
  eq([t.rest, t.restSecs], [2, 6], "the tools past the top fold into a count and a sum");
  eq(t.kinds.map((k) => [k.k, k.secs]), [["think", 200], ["gen", 150], ["tools", 186], ["you", 50]], "four kinds, tools summed");
}
eq([toolName("Bash"), toolName("mcp__verify__Attach"), toolName("mcp__goals__List__x")], ["Bash", "verify · Attach", "goals · List__x"], "an MCP name splits on its first __ pair");
