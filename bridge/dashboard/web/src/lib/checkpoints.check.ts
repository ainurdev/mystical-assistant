// Run: node bridge/dashboard/web/src/lib/checkpoints.check.ts
import type { Turn } from "../chat.ts";
import { marksOf, toneOf } from "./checkpoints.ts";

const ok = (cond: boolean | undefined, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const turn = (id: string, prompt: string, events: unknown[], extra = {}) =>
  ({ id, prompt, events, status: "done", pending: [], ...extra }) as unknown as Turn;

// Prompt numbering skips empty prompts; sub-marks nest under the prompt above.
{
  const marks = marksOf([
    turn("t1", "first", [{ type: "steer", text: "actually, stop" }]),
    turn("t2", "", [{ type: "text", text: "resumed" }]),
    turn("t3", "second", []),
  ]);
  ok(marks.map((m) => m.kind).join() === "prompt,steer,prompt", "empty prompt contributes no mark");
  ok(marks[0].n === 1 && marks[2].n === 2, "prompt numbering ignores the promptless turn");
  ok(marks[1].id === "ck-t1-steer0", "the steer anchors on its own index inside the turn");
}

// A prompt mark summarises its turn.
{
  const [m] = marksOf([
    turn("t1", "  ship   it\nnow ", [
      { type: "tool", name: "Bash", summary: "ls" },
      { type: "tool", name: "Edit", summary: "a.ts" },
      { type: "result", result: "done", cost: 0.12, elapsed: 41 },
    ], { sha: "abc1234" }),
  ]);
  ok(m.label === "ship it now", "whitespace collapses so the 2-line clamp holds real text");
  ok(m.tools === 2 && m.cost === 0.12 && m.elapsed === 41, "tools/cost/elapsed come off the events");
  ok(m.sha === "abc1234" && !m.failed && !m.waiting, "clean turn carries its checkpoint commit");
}

// Failure and stop are read off events even when the turn says 'done'.
{
  const [a] = marksOf([turn("t1", "p", [{ type: "result", result: "boom", cost: 0, elapsed: 1, is_error: true }])]);
  ok(a.failed && toneOf(a) === "var(--err)", "an errored result marks the checkpoint failed");
  const [b] = marksOf([turn("t2", "p", [{ type: "stopped" }])]);
  ok(b.stopped && !b.failed, "a stop is not a failure");
  const [c] = marksOf([turn("t3", "p", [], { status: "error" })]);
  ok(c.failed, "a turn that died mid-flight is failed with no result event");
}

// Waiting outranks everything: it is the one that needs a human.
{
  const q = { type: "question", request_id: "r1", questions: [{ header: "Scope", question: "?", options: [] }] };
  const marks = marksOf([turn("t1", "p", [q], { pending: [{ request_id: "r1", kind: "question" }], status: "running" })]);
  ok(marks[0].waiting && toneOf(marks[0]) === "var(--purple)", "an unanswered question flags the prompt");
  ok(marks[1].waiting && marks[1].label === "Scope", "the question mark labels off its header");
  const answered = marksOf([turn("t1", "p", [q, { type: "question_answered", request_id: "r1", answers: [] }])]);
  ok(!answered[1].waiting, "answered questions stop asking for attention");
  // Skipped/abandoned: the turn ended without an answer, so nothing is listening.
  const dead = marksOf([turn("t1", "p", [q], { status: "error" })]);
  ok(!dead[0].waiting && !dead[1].waiting, "a question whose turn ended stops waiting");
}

console.log("checkpoints ok");
