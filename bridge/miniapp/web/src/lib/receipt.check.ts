// Run: node --experimental-strip-types --no-warnings src/lib/receipt.check.ts
import { checksWord, receiptEmpty, receiptLine, receiptOf, shortTime, shortTokens } from "./receipt.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
let n = 0;
type D = Record<string, unknown>;
const tool = (name: string, summary: string, done: D, detail?: string) => {
  const id = `t${++n}`;
  return [{ type: "tool", name, id, summary, detail }, { type: "tool_done", id, ...done }];
};
const bash = (command: string, done: D) => tool("Bash", command, done, command);

{
  const r = receiptOf([]);
  ok(receiptEmpty(r), "an empty turn is empty");
  ok(receiptLine(r).length === 0, "and has no line");
}
{
  const r = receiptOf([
    ...tool("Edit", "a.py", { patch: ["@@ -1 +1 @@", "+x", "-y"] }),
    ...tool("Edit", "a.py", { patch: ["+z"] }),
    ...tool("Write", "new.md", {}),
    ...tool("Edit", "bad.py", { is_error: true, stat: "no match" }),
    ...tool("Read", "r.py", {}),
    { type: "tool", name: "Edit", id: "out", summary: "still.py" },
  ]);
  ok(r.files.length === 2, "files: failed, read and unfinished ones aren't changes");
  ok(r.files[0].add === 2 && r.files[0].del === 1, "edits to one file add up");
  ok(!r.files[1].patched, "a plain write has no diff to count");
  ok(receiptLine(r)[0] === "2 files +2 −1", `line: ${receiptLine(r)}`);
}
{
  const r = receiptOf([...tool("Write", "a", {})]);
  ok(receiptLine(r)[0] === "1 file", "no diff, no figures");
}
{
  const r = receiptOf([
    ...bash("git commit -m x", { output: "[master abc1234f] fix the thing\n 1 file changed" }),
    ...bash("git add . && git commit -m y", { output: "[feat/x (root-commit) 1234567] first" }),
    ...bash("git log", { output: "[master deadbee] not made here" }),
    ...bash("git commit -m z", { is_error: true, output: "nothing to commit" }),
  ]);
  ok(r.commits.map((c) => c.sha).join() === "abc1234f,1234567", `commits: ${JSON.stringify(r.commits)}`);
  ok(r.commits[1].branch === "feat/x", "branch read");
  ok(receiptLine(r)[0] === "2 commits", "several commits are counted");
}
{
  const r = receiptOf([
    ...bash("gh pr create --fill", { output: "https://github.com/a/b/pull/12\n" }),
    ...bash("git push", { output: "remote: https://github.com/a/b/pull/new/x\nremote: https://github.com/a/b/pull/12" }),
    ...bash("curl https://github.com/c/d/pull/9", { output: "https://github.com/c/d/pull/9" }),
  ]);
  ok(r.prs.length === 1 && r.prs[0].label === "PR #12", `prs: ${JSON.stringify(r.prs)}`);
  ok(!receiptLine(r).includes("PR #12"), "a PR is a link, not a word in the line");
  ok(!receiptEmpty(r), "a PR alone is a receipt");
}
{
  const r = receiptOf([
    ...bash("pytest a", { is_error: true, output: "1 failed, 2 passed" }),
    ...bash("pytest", { output: "3 passed" }),
  ]);
  ok(r.checks.length === 1 && r.checks[0].ok, `later success settles an earlier failure: ${JSON.stringify(r.checks)}`);
  ok(checksWord(r.checks) === "3 passed", "one check says its numbers");
}
{
  const r = receiptOf([
    ...bash("pytest", { output: "3 passed" }),
    ...bash("pytest", { is_error: true, output: "1 failed, 2 passed" }),
  ]);
  ok(r.checks.length === 1 && !r.checks[0].ok && checksWord(r.checks) === "1 failed · 2 passed", "the latest run of a command counts");
}
{
  const r = receiptOf([
    { type: "checks", command: "pytest", ok: true, passed: 10, failed: 7, skipped: null, new: [], known: ["a"], log: ".mystical/x.log" },
    ...bash("npm test", { output: "no numbers here" }),
  ]);
  ok(r.checks.length === 2, "a checks event and a test run");
  ok(r.checks[0].counts?.skipped === undefined && r.checks[0].known[0] === "a", "unknown count absent");
  ok(r.checks[1].counts === null, "unread output has no numbers");
  ok(checksWord(r.checks) === "2 checks passed", checksWord(r.checks));
}
{
  const r = receiptOf([{ type: "result", elapsed: 92 }], { tokens: 14000, agent: "Kimi", started: 1000 });
  ok(r.elapsed === 92 && r.at === 1092 && r.agent === "Kimi", "time, tokens, agent");
  ok(receiptLine(r).join("|") === "1m 32s|14k tok", receiptLine(r).join("|"));
  const none = receiptOf([{ type: "result", elapsed: 0 }], { tokens: null });
  ok(none.elapsed === undefined && none.tokens === undefined && receiptEmpty(none), "unknowns hidden");
}
ok(shortTime(3.21) === "3.2s" && shortTime(48.2) === "48s" && shortTime(3700) === "1h 1m", "times");
ok(shortTokens(900) === "900" && shortTokens(1234) === "1.2k" && shortTokens(2_500_000) === "2.5M", "tokens");
