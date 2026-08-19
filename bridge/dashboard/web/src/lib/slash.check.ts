// Run: node bridge/dashboard/web/src/lib/slash.check.ts
import { applyMention } from "./mention.ts";
import { isExact, rankCommands, slashAt } from "./slash.ts";
import type { SlashCommand } from "../api.ts";

// --- slashAt ---------------------------------------------------------------
console.assert(slashAt("/", 1)?.q === "", "bare / opens with an empty query");
console.assert(slashAt("/Comp", 5)?.q === "comp", "query is lowercased");
console.assert(slashAt("/compact keep auth", 18) === null, "caret in the args: closed");
console.assert(slashAt("/compact keep auth", 4)?.q === "com", "caret back in the word: open");
console.assert(slashAt("fix /foo", 8) === null, "a / that isn't first is a path");
console.assert(slashAt(" /x", 3) === null, "leading space: not a command");
console.assert(slashAt("/x", 0) === null, "caret before the /");

// --- rankCommands ----------------------------------------------------------
const cmds: SlashCommand[] = [
  { name: "superpowers:brainstorming", description: "", scope: "plugin" },
  { name: "brainstorming", description: "", scope: "project" },
  { name: "compact", description: "", scope: "builtin" },
  { name: "ponytail:ponytail-review", description: "", scope: "plugin" },
  { name: "code-review", description: "", scope: "builtin" },
];
const br = rankCommands(cmds, "brain").map((c) => c.name);
console.assert(br[0] === "brainstorming" && br[1] === "superpowers:brainstorming", `name-prefix, then plugin-tail prefix: ${br}`);
const rv = rankCommands(cmds, "review").map((c) => c.name);
console.assert(rv.join() === "code-review,ponytail:ponytail-review", `contains-matches, alphabetical: ${rv}`);
console.assert(rankCommands(cmds, "").length === cmds.length, "empty query offers everything");
console.assert(rankCommands(cmds, "").map((c) => c.name)[0] === "brainstorming", "empty query is alphabetical");
console.assert(rankCommands(cmds, "zzz").length === 0, "no match, no rows");

// --- picking splices /name<space> over the word -----------------------------
const s = slashAt("/comp", 5)!;
const next = applyMention("/comp", s, 5, "/compact");
console.assert(next.text === "/compact " && next.caret === 9, `pick: ${JSON.stringify(next)}`);
const mid = applyMention("/comp keep auth", slashAt("/comp keep auth", 3)!, 3, "/compact");
console.assert(mid.text === "/compact mp keep auth", `pick mid-word keeps the tail: ${mid.text}`);

// --- isExact: Enter sends what's typed out, inserts what isn't ------------
console.assert(isExact(cmds[2], "compact"), "full name is exact");
console.assert(!isExact(cmds[2], "comp"), "a prefix is not");
console.assert(isExact(cmds[0], "brainstorming"), "a plugin command's bare name is exact");
console.assert(!isExact(cmds[0], "superpowers"), "the plugin alone is not");

console.log("slash.check: ok");
