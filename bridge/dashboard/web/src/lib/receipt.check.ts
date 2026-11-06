import assert from "node:assert/strict";
import { checksLine, receiptEmpty, receiptOf } from "./receipt.ts";

const tool = (id: string, name: string, summary: string, detail?: string) => ({ type: "tool", id, name, summary, detail });
const done = (id: string, more: Record<string, unknown> = {}) => ({ type: "tool_done", id, ...more });

const events = [
  tool("e1", "Edit", "src/a.ts"), done("e1", { patch: ["@@", "+x", "+y", "-z"] }),
  tool("e2", "Edit", "src/a.ts"), done("e2", { patch: ["+q"] }),
  tool("w", "Write", "src/b.ts"), done("w"),
  tool("eb", "Edit", "src/c.ts"), done("eb", { is_error: true, stat: "String not found" }),
  tool("t1", "Bash", "python3 -m pytest -q"), done("t1", { is_error: true, output: "Exit code 1\n===== 3301 passed, 7 failed in 19s =====" }),
  tool("t2", "Bash", "python3 -m pytest -q"), done("t2", { output: "3308 passed in 19s" }),
  tool("g1", "Bash", "git add -A && git commit -m 'fix: the thing'"), done("g1", { output: "[feat/x 1234abc] fix: the thing\n 2 files changed" }),
  tool("g2", "Bash", "git push -u origin feat/x"), done("g2", { output: "remote: https://github.com/o/r/pull/new/feat/x\n * [new branch]      feat/x -> feat/x" }),
  tool("g3", "Bash", "gh pr create --fill"), done("g3", { output: "Creating pull request\nhttps://github.com/o/r/pull/42\n" }),
  { type: "result", result: "done", elapsed: 134 },
];
const r = receiptOf(events, { tokens: 1200, runtime: "acp:kimi" });
assert.deepEqual(r.files.map((f) => [f.path, f.edits, f.add, f.del]), [["src/a.ts", 2, 3, 1], ["src/b.ts", 1, 0, 0]]);
assert.deepEqual(r.checks.map((c) => [c.ok, c.line, c.from]), [[true, "3308 passed", "command"]]);
assert.deepEqual(r.commits, [{ branch: "feat/x", sha: "1234abc", subject: "fix: the thing" }]);
assert.deepEqual(r.pushed, ["feat/x"]);
assert.deepEqual(r.prs, [{ url: "https://github.com/o/r/pull/42", n: 42 }]);
assert.equal(r.secs, 134);
assert.equal(r.tokens, 1200);
assert.equal(r.runtime, "acp:kimi");
assert.deepEqual(r.unresolved.map((f) => f.what), ["src/c.ts"]);

// checks events win over test commands
const c = receiptOf([
  tool("t", "Bash", "pytest"), done("t", { output: "1 passed" }),
  { type: "checks", command: "pytest -q", ok: false, code: 1, passed: 10, failed: 2, skipped: 0, new: ["test_a"], known: ["test_b"] },
]);
assert.deepEqual(c.checks.map((x) => [x.ok, x.line, x.fresh, x.known]), [[false, "10 passed, 2 failed · 1 new", ["test_a"], 1]]);

// a test command whose output can't be read still says how it ended
assert.equal(receiptOf([tool("t", "Bash", "npm test"), done("t", { output: "weird" })]).checks[0].line, "passed");
assert.equal(receiptOf([tool("t", "Bash", "npm test"), done("t", { is_error: true, output: "Exit code 1" })]).checks[0].line, "failed");

// failed commands and no-op pushes don't count; a push isn't a PR
assert.equal(receiptOf([tool("g", "Bash", "git commit -m x"), done("g", { is_error: true, output: "nothing to commit" })]).commits.length, 0);
assert.equal(receiptOf([tool("g", "Bash", "git push"), done("g", { output: "Everything up-to-date" })]).pushed.length, 0);
assert.equal(receiptOf([tool("g", "Bash", "git push"), done("g", { output: "remote: https://x/y/pull/new/z" })]).prs.length, 0);
// a commit whose output was trimmed still counts, by its command
assert.deepEqual(receiptOf([tool("g", "Bash", 'FOO=1 git -C x commit -am "subject\n\nbody"'), done("g", { output: "" })]).commits, [{ subject: "subject" }]);
// an unfinished call says nothing
assert.equal(receiptOf([tool("g", "Bash", "git push")]).pushed.length, 0);

// wording of the known failures
assert.equal(checksLine({ ok: true, passed: 3294, failed: 7, skipped: 0, new: [], known: ["a", "b", "c", "d", "e", "f", "g"] }), "3294 passed, 7 failed · all 7 known, none new");
assert.equal(checksLine({ ok: true, passed: 5, failed: 1, new: [], known: ["a"] }), "5 passed, 1 failed · the 1 known, none new");
assert.equal(checksLine({ ok: true, passed: 12, failed: 0, new: [], known: [] }), "12 passed");
assert.equal(checksLine({ ok: false, code: 3, passed: null, failed: null, new: [], known: [] }), "exit 3");
assert.equal(checksLine({ ok: true, code: 0, passed: null, failed: null }), "passed");

// nothing known, nothing drawn
assert.ok(receiptEmpty(receiptOf([{ type: "text", text: "hi" }])));
assert.ok(!receiptEmpty(receiptOf([{ type: "text", text: "hi" }], { elapsed: 3 })));
assert.equal(receiptOf([{ type: "text", text: "a", at: 100 }, { type: "text", text: "b", at: 160 }], { started: 90 }).secs, 70);
assert.equal(receiptOf([], { tokens: 0 }).tokens, null);
console.log("receipt.check: ok");
