// Run: node bridge/dashboard/web/src/lib/mention.check.ts
import { applyMention, mentionAt, rankPaths } from "./mention.ts";

// --- mentionAt -------------------------------------------------------------
const open = mentionAt("look at @run", 12);
console.assert(open?.q === "run" && open.start === 8, `open: ${JSON.stringify(open)}`);

// A bare @ opens the list with an empty query.
console.assert(mentionAt("@", 1)?.q === "", "bare @ should open");
// At the very start of the box, too.
console.assert(mentionAt("@app", 4)?.start === 0, "@ at index 0");
// Mid-word @ is an email/handle, not a mention.
console.assert(mentionAt("mail me@x", 9) === null, "mid-word @");
// A space closes it.
console.assert(mentionAt("@src/a.ts done", 14) === null, "space closes the mention");
// The caret before the @ sees nothing.
console.assert(mentionAt("hi @a", 2) === null, "caret before @");

// --- rankPaths -------------------------------------------------------------
const paths = [
  "bridge/runner.py",
  "tests/test_runner.py",
  "bridge/dashboard/web/src/App.tsx",
  "src/app.ts",
  "docs/running.md",
];
const r = rankPaths(paths, "runner");
console.assert(r[0] === "bridge/runner.py", `basename-prefix wins, got ${r[0]}`);
console.assert(r[1] === "tests/test_runner.py", `basename-contains second, got ${r[1]}`);
console.assert(!r.includes("docs/running.md"), "running.md doesn't contain 'runner'");

// Shorter path breaks a tie between two basename-prefix matches.
const tie = rankPaths(["bridge/dashboard/web/src/App.tsx", "src/app.ts"], "app");
console.assert(tie[0] === "src/app.ts", `shorter path first, got ${tie[0]}`);

// No query = the head of the list, capped.
console.assert(rankPaths(paths, "", 2).length === 2, "limit respected");

// --- applyMention ----------------------------------------------------------
const text = "look at @run";
const m = mentionAt(text, 12)!;
const out = applyMention(text, m, 12, "bridge/runner.py");
console.assert(out.text === "look at bridge/runner.py ", `spliced: ${JSON.stringify(out.text)}`);
console.assert(out.caret === out.text.length, "caret lands after the path");

// Text after the caret survives the splice.
const t2 = "see @run then ship";
const m2 = mentionAt(t2, 8)!;
const o2 = applyMention(t2, m2, 8, "a/b.ts");
console.assert(o2.text === "see a/b.ts  then ship", `tail kept: ${JSON.stringify(o2.text)}`);

console.log("mention ok");
