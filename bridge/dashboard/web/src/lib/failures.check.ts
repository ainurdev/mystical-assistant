import assert from "node:assert/strict";
import { analyzeFailures, failureKind } from "./failures.ts";

const tool = (id: string, name: string, summary: string) => ({ type: "tool", id, name, summary });
const ok = (id: string) => ({ type: "tool_done", id });
const bad = (id: string, output?: string, stat?: string) => ({ type: "tool_done", id, is_error: true, output, stat });

// recovered: same file, later success
let r = analyzeFailures([tool("a", "Edit", "x.py"), bad("a", undefined, "String not found"), tool("b", "Read", "x.py"), ok("b"), tool("c", "Edit", "x.py"), ok("c")]);
assert.deepEqual([...r.recovered], ["a"]);
assert.equal(r.unresolved.length, 0);

// another file doesn't make it good
r = analyzeFailures([tool("a", "Edit", "x.py"), bad("a", undefined, "nope"), tool("b", "Edit", "y.py"), ok("b")]);
assert.equal(r.recovered.size, 0);
assert.equal(r.unresolved[0].id, "a");
assert.equal(r.unresolved[0].text, "nope");
assert.equal(r.unresolved[0].i, 0);

// tests: fail, then an ls, stays unresolved; then a passing run recovers it
const t = [tool("a", "Bash", "pytest"), bad("a", "Exit code 1\n3 failed"), tool("b", "Bash", "ls"), ok("b")];
r = analyzeFailures(t);
assert.equal(r.unresolved[0].text, "3 failed");
r = analyzeFailures([...t, tool("c", "Bash", "cd x && python3 -m pytest -q"), ok("c")]);
assert.deepEqual([...r.recovered], ["a"]);

// the success has to come after
r = analyzeFailures([tool("a", "Bash", "pytest"), ok("a"), tool("b", "Bash", "pytest"), bad("b", "Exit code 1\nx")]);
assert.equal(r.unresolved[0].id, "b");
assert.equal(r.recovered.size, 0);

// still running isn't a success, and "other" commands match by first word
r = analyzeFailures([tool("a", "Bash", "frob x"), bad("a", "boom"), tool("b", "Bash", "frob y")]);
assert.equal(r.unresolved.length, 1);
r = analyzeFailures([tool("a", "Bash", "frob x"), bad("a", "boom"), tool("b", "Bash", "zap"), ok("b")]);
assert.equal(r.unresolved.length, 1);
r = analyzeFailures([tool("a", "Bash", "frob x"), bad("a", "boom"), tool("b", "Bash", "frob y"), ok("b")]);
assert.equal(r.recovered.size, 1);

// an MCP tool by its name
assert.equal(failureKind("mcp__x__y", "anything"), "tool:mcp__x__y");
// a failed call with no id can't be paired, and reads as nothing
assert.equal(analyzeFailures([{ type: "tool", name: "Bash", summary: "x" }]).unresolved.length, 0);
console.log("failures.check: ok");
