// Run: node --experimental-strip-types --no-warnings src/lib/agenttools.check.ts
import {
  agentsNoRuleReaches, canReset, cellWhy, columnNotes, copyTargets, cwdOf, gridClick, groupRules, heldByChatSwitch, hookAgents, hookBody, hookProblem, hookQuery,
  levelTag, matches, mcpNeedsLogin, nextOn, ownPatterns, parseFocus, atFocus, patchCell, patternProblem, pickedState, ruleReach, ruleWrite,
  scopeBody, scopeQuery, secTab, type HookListing, type HookRow, type RuleRow, type Scope,
} from "./agenttools.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${what} (${JSON.stringify(a)})`);

const m: Scope = { level: "machine", project: "/a", session: "s1" };
const p: Scope = { level: "project", project: "/a b", session: "s1" };
const c: Scope = { level: "chat", project: "/a", session: "s1" };
eq(scopeQuery(m), "", "machine reads nothing narrower, whatever else is picked");
eq(scopeQuery(p), "?project=%2Fa+b", "a project goes as a project");
eq(scopeQuery(c), "?session=s1", "a chat goes as a session");
eq(scopeBody(m), { level: "machine" }, "a machine pick names no project");
eq(scopeBody(p), { level: "project", project: "/a b" }, "a project pick names it");
eq(scopeBody(c), { level: "chat", session_id: "s1" }, "a chat pick names it");
eq(hookQuery(m), "?project=%2Fa", "hooks read the picked project even at machine level");
eq(hookQuery(c), "?session=s1", "or the chat's");
eq(hookBody({ ...m, project: null }), {}, "no project, nothing sent: the route says what it needs");

eq(levelTag({ state: "shared", level: "machine" }), "MACHINE", "a tag names the level");
eq(levelTag({ state: "on", level: null }), "DEFAULT", "no level is the default");
eq(levelTag({ state: "installed", level: null }), "", "installed has no one to name");
eq(levelTag({ state: "cant", why: "x" }), "", "nor can't");

eq(gridClick({ state: "off" }), "toggle", "off flips");
eq(gridClick({ state: "shared" }), "toggle", "shared flips");
eq(gridClick({ state: "login" }), "login", "login logs in");
eq(gridClick({ state: "cant", why: "x" }), "open", "can't only explains");
eq(gridClick({ state: "installed" }), "open", "installed only explains");
ok(nextOn({ state: "off" }) && !nextOn({ state: "on" }) && !nextOn({ state: "shared" }), "a click asks for the opposite");

ok(canReset("mcp", { state: "off", level: "project" }, "project"), "reset where this level said it");
ok(!canReset("mcp", { state: "off", level: "machine" }, "project"), "not where a wider level said it");
ok(!canReset("mcp", { state: "shared", level: "default" }, "machine"), "not a default");
ok(!canReset("skills", { state: "shared", level: "machine" }, "machine"), "a skill has no levels");
ok(!canReset("tool", { state: "cant", level: "machine" }, "machine"), "nor a can't");

ok(cellWhy("mcp", { state: "cant", why: "No." }, "Kimi") === "No.", "can't says its own why");
ok(/project/.test(cellWhy("mcp", { state: "off", level: "project" }, "Kimi")), "off names who set it");
ok(/default/.test(cellWhy("mcp", { state: "shared", level: "default" }, "Kimi")), "a known server says default");
ok(/machine/.test(cellWhy("skills", { state: "shared", level: "machine" }, "Kimi")), "a skill says machine");

ok(mcpNeedsLogin({ transport: "http", holds_key: false, known: false, logged_in: false }), "a bare remote server needs a login");
ok(!mcpNeedsLogin({ transport: "http", holds_key: true, known: false, logged_in: false }), "not one holding a key");
ok(!mcpNeedsLogin({ transport: "stdio", holds_key: false, known: false, logged_in: false }), "nor a local one");
ok(!mcpNeedsLogin({ transport: "http", holds_key: false, known: false, logged_in: true }), "nor one logged in");

ok(matches("git  PUSH", "Bash(git push*)"), "search ignores case and spacing");
ok(!matches("kimi", "claude", null), "search misses");
ok(matches("", "x"), "an empty search matches");

const rowsA = [{ cells: { kimi: { state: "cant" as const, why: "same" }, claude: { state: "on" as const } } }, { cells: { kimi: { state: "cant" as const, why: "same" }, claude: { state: "cant" as const, why: "one" } } }];
eq(columnNotes(rowsA, [{ id: "claude", label: "Claude" }, { id: "kimi", label: "Kimi" }]), [{ agent: "Kimi", why: "same" }], "a why the whole column shares is said once");
eq(columnNotes([], [{ id: "kimi", label: "Kimi" }]), [], "no rows, no notes");

const patched = patchCell([{ name: "a", cells: { k: { state: "off" as const } } }, { name: "b", cells: { k: { state: "off" as const } } }], (r) => r.name === "a", "k", { state: "shared", level: "chat" });
eq(patched[0].cells.k, { state: "shared", level: "chat" }, "the pick lands on its row");
eq(patched[1].cells.k, { state: "off" }, "and nowhere else");
eq(pickedState("mcp", true), "shared", "a server is shared");
eq(pickedState("tool", true), "on", "a tool is on");
eq(pickedState("skills", false), "off", "off is off");

ok(heldByChatSwitch("tool", "Bash", { state: "off", level: "chat" }, c, ["Bash"]), "the ⚒ switch holds its own");
ok(!heldByChatSwitch("tool", "Edit", { state: "off", level: "chat" }, c, ["Bash"]), "a pick isn't the switch");
ok(!heldByChatSwitch("tool", "Bash", { state: "off", level: "chat" }, p, ["Bash"]), "only at chat level");

eq(ownPatterns(["Bash(a)", "Bash(b)"], ["Bash(b)"]), ["Bash(a)"], "a level holds what the wider one doesn't");
ok(patternProblem(" ", []) !== null, "blank refused");
ok(patternProblem("(x", []) !== null, "must start with a name");
ok(patternProblem("Bash(x)", ["Bash(x)"]) !== null, "no doubles");
ok(patternProblem("x".repeat(200), []) !== null, "too long, as the bridge counts it");
ok(patternProblem("Bash(git push*)", []) === null, "a real one passes");

eq(agentsNoRuleReaches([{ agents: ["claude", "kimi"] }, { agents: ["kimi"] }], [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }]).map((a) => a.id), ["codex"], "an agent no rule reaches is named once");
const rule = (id: string, group: string, agents: string[], fields = {}): RuleRow => ({ id, group, name: id, about: "", agents, on: false, level: null, fields });
eq(groupRules([rule("v", "Visibility", []), rule("s", "Safety", []), rule("x", "New", [])]).map((g) => g.group), ["Safety", "Visibility", "New"], "groups in order, empties gone, a new one last");
const both = [{ id: "claude", label: "Claude" }, { id: "kimi", label: "Kimi" }];
let reach = ruleReach(rule("mask_secrets", "Safety", ["claude"]), both, "machine");
eq(reach.acts, "Claude", "who it acts on");
ok(reach.notes.some((n) => /replace a tool's output/.test(n)), "and why not the other");
reach = ruleReach(rule("destructive", "Safety", ["claude", "kimi"], { mode: "block" }), both, "machine");
ok(reach.notes.some((n) => /only block/.test(n)), "ask mode is Claude's");
reach = ruleReach(rule("test_before_done", "Quality", ["claude", "kimi"]), both, "chat");
ok(reach.notes.some((n) => /per login/.test(n)), "a chat-only rule doesn't write Kimi's block");
ok(!ruleReach(rule("test_before_done", "Quality", ["claude", "kimi"]), both, "project").notes.length, "no note at project level");
reach = ruleReach(rule("pack_after_compact", "Context", ["kimi"]), [{ id: "claude", label: "Claude" }], "machine");
eq(reach.acts, "Kimi (not installed)", "says so when it isn't here");
eq(ruleWrite(rule("p", "Safety", [], { paths: ["a"] }), { on: true }), { id: "p", on: true, fields: { paths: ["a"] } }, "a switch keeps the fields it inherited");
eq(ruleWrite(rule("p", "Safety", [], { paths: ["a"], mode: "block" }), { fields: { paths: ["b"] } }).fields, { paths: ["b"], mode: "block" }, "a field keeps the others");

const hook = (more: Partial<HookRow>): HookRow => ({ id: "1", agent: "claude", scope: "user", event: "PreToolUse", matcher: "", type: "command", command: "ls", timeout: null, can_block: true, editable: true, ...more });
const list: HookListing = { hooks: [hook({})], own: [], events: { claude: ["PreToolUse", "PostToolBatch"], kimi: ["PreToolUse", "TurnStarted"] }, can_block: {} };
eq(copyTargets(hook({}), list, both).map((a) => a.id), ["kimi"], "copy offers the other agent");
eq(copyTargets(hook({ event: "PostToolBatch" }), list, both), [], "not where it has no such event");
eq(copyTargets(hook({ editable: false, type: "prompt" }), list, both), [], "never a hook that isn't a command");
eq(copyTargets(hook({}), { ...list, hooks: [hook({}), hook({ agent: "kimi", id: "2" })] }, both), [], "not one it already has");
eq(copyTargets(hook({}), list, [{ id: "claude", label: "Claude" }]), [], "not to an agent that isn't here");
eq(hookAgents(list, [{ id: "claude", label: "Claude" }]).map((a) => a.id), ["claude"], "only the agents here");
eq(hookAgents({ ...list, hooks: [hook({ agent: "kimi" })] }, [{ id: "claude", label: "Claude" }]).map((a) => a.id), ["claude", "kimi"], "or one with hooks to show");
ok(hookProblem({ event: "", command: "x", timeout: "" }) !== null, "needs an event");
ok(hookProblem({ event: "Stop", command: "  ", timeout: "" }) !== null, "needs a command");
ok(hookProblem({ event: "Stop", command: "x", timeout: "1.5" }) !== null, "a timeout is whole");
ok(hookProblem({ event: "Stop", command: "x", timeout: "30" }) === null, "a real one passes");

eq(parseFocus(atFocus({ tab: "tools", level: "chat", session: "s" })), { tab: "tools", level: "chat", session: "s" }, "focus round-trips");
eq(parseFocus("nonsense"), {}, "a stray focus is nothing");
eq(parseFocus(null), {}, "and so is none");
eq(secTab("SHARED MCP SERVERS"), "mcp", "an old section lands on its new tab");
eq(secTab("HOOKS"), "hooks", "and a new one");
eq(secTab("BRIDGE"), undefined, "others aren't ours");
eq(cwdOf(c, "/x", () => "/y"), "/x", "a chat's folder");
eq(cwdOf(p, "/x", () => "/y"), "/y", "a project's");
eq(cwdOf({ ...m, project: null }, "/x", () => "/y"), null, "the machine has none");
console.log("all ok");
