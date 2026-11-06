// Run: node --experimental-strip-types --no-warnings src/lib/failures.check.ts
import { failureState, type Ev } from "./failures.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
let n = 0;
const bash = (command: string, done: Partial<Ev>): Ev[] => {
  const id = `b${++n}`;
  return [{ type: "tool", name: "Bash", id, summary: command, detail: command }, { type: "tool_done", id, ...done }];
};
const tool = (name: string, summary: string, done: Partial<Ev>): Ev[] => {
  const id = `t${++n}`;
  return [{ type: "tool", name, id, summary }, { type: "tool_done", id, ...done }];
};

{
  const s = failureState([...bash("pytest a.py", { is_error: true, output: "Exit code 1\n1 failed" }),
                          ...bash("pytest a.py -x", { output: "3 passed" })]);
  ok(s.open.length === 0 && s.resolved.has(0), "a test failure that later passes stays quiet");
}
{
  const s = failureState([...bash("pytest", { output: "3 passed" }),
                          ...bash("pytest", { is_error: true, output: "Exit code 1\nboom\n1 failed" })]);
  ok(s.open.length === 1 && s.open[0].error === "boom\n1 failed", `success before doesn't count, exit line dropped: ${JSON.stringify(s.open)}`);
}
{
  const s = failureState([...bash("tsc -b", { is_error: true, output: "x" }), ...bash("pytest", { output: "ok" })]);
  ok(s.open.length === 1 && s.open[0].label === "tsc -b", "another kind doesn't make it good");
}
{
  const s = failureState([...tool("Edit", "a.py", { is_error: true, stat: "no match" }), ...tool("Edit", "b.py", {})]);
  ok(s.open.length === 1 && s.open[0].error === "no match", "an edit to another file doesn't make it good");
  const r = failureState([...tool("Edit", "a.py", { is_error: true, stat: "no match" }), ...tool("Write", "a.py", {})]);
  ok(r.open.length === 0, "writing that file does");
}
{
  const s = failureState([...bash("./a.sh", { is_error: true, output: "a" }), ...bash("./b.sh", { output: "b" })]);
  ok(s.open.length === 1, "two different scripts aren't a retry");
}
{
  const s = failureState([...bash("pytest", { is_error: true, output: "first" }), ...bash("pytest", { is_error: true, output: "second" })]);
  ok(s.open.length === 1 && s.open[0].error === "second" && s.resolved.has(0), "a repeat shows once, the latest");
}
{
  const s = failureState([...bash("grep nope f", { is_error: true, output: "Exit code 1\n" })]);
  ok(s.open.length === 0, "a search that found nothing isn't a failure");
  const g = failureState([...bash("grep x /nope", { is_error: true, output: "Exit code 2\ngrep: /nope: No such file" })]);
  ok(g.open.length === 1, "a search that broke is");
}
{
  const s = failureState([...tool("Write", "a", { is_error: true, stat: "The user declined this action." })]);
  ok(s.open.length === 0 && s.resolved.size === 1, "your own no isn't a failure");
}
{
  const c = (o: Partial<Ev>): Ev => ({ type: "checks", command: "pytest", ...o });
  ok(failureState([c({ ok: false, new: ["a", "b"] })]).open[0].error === "a\nb", "failed checks name what's new");
  ok(failureState([c({ ok: false, new: [] }), c({ ok: true })]).open.length === 0, "checks recover");
  ok(failureState([...bash("pytest", { is_error: true, output: "x" }), c({ ok: true })]).open.length === 0, "checks make a test run good");
  ok(failureState([c({ ok: false, new: [], tail: "boom", code: 2 })]).open[0].error === "boom", "else its tail");
}
{
  const s = failureState([{ type: "tool", name: "Bash", id: "x", summary: "pytest" }]);
  ok(s.open.length === 0 && s.resolved.size === 0, "one still out is neither");
  ok(failureState([]).open.length === 0, "an empty turn");
}
{
  const long = "z".repeat(3000);
  ok(failureState(bash("rm x", { is_error: true, output: long })).open[0].error.length < 1300, "a long error is capped");
}
