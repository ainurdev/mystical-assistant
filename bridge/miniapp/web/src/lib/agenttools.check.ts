// Run: node bridge/miniapp/web/src/lib/agenttools.check.ts
import {
  canKeep, clampTimes, control, deleteWords, dirAddress, errorWords, filesIn, fmtBytes, groupOpensFolder, levelWord, levelsOpen,
  matches, needsImageConfirm, parsePaths, ruleFieldsLine, ruleGroups, ruleHasFields, scopeBody, scopeQuery, staleRows,
  stateMeaning, summarize, withPick, type DirEntry, type Rule,
} from "./agenttools.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const same = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), what);

// The nearest level wins, so a switch below it would write what nothing reads.
same(control({ state: "off", level: "chat" }, "machine"), { kind: "decided", by: "chat" }, "a chat pick decides over machine");
same(control({ state: "on", level: "project" }, "machine"), { kind: "decided", by: "project" }, "a project pick decides over machine");
same(control({ state: "on", level: "project" }, "chat"), { kind: "switch", on: true, clear: false }, "a chat pick overrides a project one");
same(control({ state: "off", level: "chat" }, "chat"), { kind: "switch", on: false, clear: true }, "the level's own pick can be cleared");
same(control({ state: "shared", level: "default" }, "machine"), { kind: "switch", on: true, clear: false }, "a known server's default is nobody's pick");
same(control({ state: "off", level: null }, "machine"), { kind: "switch", on: false, clear: false }, "no level is nobody's pick");
same(control({ state: "login", level: "machine" }, "machine"), { kind: "switch", on: true, clear: true }, "login means shared, and waiting");
same(control({ state: "installed", level: null }, "chat"), { kind: "none" }, "installed has no switch");
same(control({ state: "cant", why: "x" }, "chat"), { kind: "none" }, "can't has no switch");

ok(levelWord("default") === "Default" && levelWord(null) === "Default" && levelWord("chat") === "This chat", "level words");
same(levelsOpen({ session: null, project: null }), { machine: true, project: false, chat: false }, "nothing open: machine only");
same(levelsOpen({ session: null, project: "a" }), { machine: true, project: true, chat: false }, "a new chat has no chat level");
same(levelsOpen({ session: "s", project: "a" }), { machine: true, project: true, chat: true }, "an open chat has all three");

ok(stateMeaning({ state: "cant", why: "Claude has its own." }) === "Claude has its own.", "can't says why");
ok(stateMeaning({ state: "on" }) === "", "on needs no sentence");
ok(/dashboard/.test(stateMeaning({ state: "login" })), "a login sends you where it can finish");

same(withPick({ state: "off", level: null }, "mcp", true, "chat"), { state: "shared", level: "chat" }, "an MCP pick reads shared");
same(withPick({ state: "off", level: null }, "tool", true, "chat"), { state: "on", level: "chat" }, "a tool pick reads on");

ok(summarize({ a: { state: "off" }, b: { state: "installed" }, c: { state: "off" } }) === "1 installed · 2 off", "a closed row counts");
ok(summarize({ a: { state: "cant" } }) === "1 can't", "can't has its apostrophe");
ok(matches("  GIT ", "bridge-git") && !matches("x", "bridge", undefined) && matches("", "anything"), "the filter");

ok(scopeQuery({ session: "s 1", project: "p" }) === "session=s%201", "a chat is asked about by session");
ok(scopeQuery({ session: null, project: "a/b" }) === "project=a%2Fb", "no chat: by project");
same(scopeBody({ session: "s", project: "p" }), { session_id: "s" }, "POST names the chat");
same(scopeBody({ session: null, project: "p" }), { project: "p" }, "POST names the project");

const rule = (id: string, group: string, fields = {}): Rule =>
  ({ id, group, name: id, about: "", agents: [], on: false, level: null, fields });
same(ruleGroups([rule("a", "Safety"), rule("b", "Quality"), rule("c", "Safety")]).map((g) => [g.group, g.rules.length]),
  [["Safety", 2], ["Quality", 1]], "groups keep the catalog's order");
ok(ruleHasFields(rule("a", "x", { times: 5 })) && !ruleHasFields(rule("b", "x")), "only rules with fields have a sheet");
ok(ruleFieldsLine({ mode: "ask" }) === "asks first", "mode line");
ok(ruleFieldsLine({ paths: [".env", "*.pem"] }) === ".env, *.pem", "paths line");
ok(ruleFieldsLine({ times: 5 }) === "after 5 in a row", "times line");
same(parsePaths(" .env \n\n migrations/ \n"), [".env", "migrations/"], "paths are one per line, trimmed");
ok(clampTimes("0", 5) === 1 && clampTimes("500", 5) === 100 && clampTimes("7", 5) === 7 && clampTimes("x", 5) === 5, "times clamp");

const entry = (path: string, kind: string, over: Partial<DirEntry> = {}): DirEntry => ({
  name: path.split("/").pop() as string, path, dir: false, bytes: 10, at: 0, files: 1, kind, keep: false,
  preview: "none", deletable: true, ...over,
});
ok(canKeep(entry("old.zip", "other")), "keep: a top-level other");
ok(canKeep(entry("scratch/probe.py", "scratch")), "keep: a child of scratch");
ok(!canKeep(entry("scratch", "scratch", { dir: true })), "keep: scratch itself would do nothing");
ok(!canKeep(entry("scratch/a/b.py", "scratch")), "keep: deeper than clearing looks");
ok(!canKeep(entry("old/inner.txt", "other")), "keep: inside an other folder");
ok(!canKeep(entry("docs/a.md", "docs")), "keep: docs are never cleared");
ok(needsImageConfirm(entry("images/a.png", "images")) && !needsImageConfirm(entry("docs/a.md", "docs")), "images ask");
ok(/Old chats show this image/.test(deleteWords(entry("images/a.png", "images"))), "an image warns");
ok(/Old chats show these images.*3 files/.test(deleteWords(entry("images", "images", { dir: true, files: 3 }))), "the folder warns with a count");
ok(/1 file\b/.test(deleteWords(entry("old", "other", { dir: true }))), "one file is one file");
ok(dirAddress("images/a.png") === ".mystical/images/a.png", "the address is project-relative");
ok(groupOpensFolder([entry("images", "images", { dir: true })])?.path === "images", "a one-folder group opens it");
ok(groupOpensFolder([entry("a", "other", { dir: true }), entry("b", "other")]) === null, "a mixed group lists");
ok(groupOpensFolder([entry("a", "other")]) === null, "a lone file lists");

ok(filesIn([entry("images", "images", { dir: true, files: 35 })], "images") === "35 files", "a folder counts its files");
ok(filesIn([entry("x", "other")], "other") === "1 file" && filesIn([], "other") === "0 files", "file counts");

const st = staleRows(["scratch/a", "gone"], [entry("scratch/a", "scratch", { bytes: 2048 })]);
ok(st.total === 2048 && !st.complete && st.rows[1].bytes === null, "unknown sizes stay unknown");
ok(staleRows(["x"], [entry("x", "other")]).complete, "all sizes known");
ok(staleRows([], []).complete && staleRows([], []).total === 0, "nothing stale");

ok(fmtBytes(0) === "0 B" && fmtBytes(1023) === "1023 B" && fmtBytes(1024) === "1.0 KB", "bytes");
ok(fmtBytes(240 * 1024 * 1024) === "240 MB" && fmtBytes(1536) === "1.5 KB", "bytes, larger");

ok(/⟳/.test(errorWords(404, "not found")), "a bare 404 means restart");
ok(errorWords(404, "no project") === "no project", "a 404 with a reason keeps it");
ok(errorWords(0, "Network error") === "Can't reach the bridge.", "no connection");
ok(errorWords(409, "The experimental features are off.") === "The experimental features are off.", "the bridge's words pass through");
