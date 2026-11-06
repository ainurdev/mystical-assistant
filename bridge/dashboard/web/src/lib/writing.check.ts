// Run: node --experimental-strip-types src/lib/writing.check.ts  (from web/)
//
// FILES' writing card: the newest edit a turn landed, its last four changed
// lines, and whether that turn is still going.
import { writing } from "./writing.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const ROOT = "/w/repo";
const P = "/w/repo/bridge/skills.py";
const edit = (id: string, path: string, patch?: string[], at = 100) =>
  [{ type: "tool", name: "Edit", summary: path, id, at }, { type: "tool_done", id, patch, at: at + 1 }];
const turn = (status: string, events: any[], extra: any = {}) => ({ status, events, started: 100, ...extra });
const P1 = ["@@ -210,3 +210,4 @@", " a", " b", "-old", "+new1", "+new2", " c"];
const P2 = ["@@ -210,3 +210,4 @@", " a", " b", "-old", "+new1", "+new2", " c", "@@ -300,1 +301,2 @@", " x", "+y"];

const live = writing([turn("running", [...edit("1", P, P1), ...edit("2", P, P2)])], ROOT, 120)!;
ok(live.live && live.name === "skills.py" && live.dir === "bridge/" && live.path === "bridge/skills.py", "running turn: newest edit, path relative to root");
ok(live.lines.length === 4 && live.lines.map((l) => l.sign).join("") === "-+++", "last 4 changed lines");
ok(live.line === 212, "line = the n of the first + among the shown lines");
const low = writing([turn("running", edit("1", P, ["@@ -300,3 +300,4 @@", " a", " b", " c", "+z"]))], ROOT, 120)!;
ok(low.line === 303, "a shown + line below the hunk start: its own n, not the hunk start");
const del = writing([turn("running", edit("1", P, ["@@ -50,2 +60,1 @@", " a", "-b"]))], ROOT, 120)!;
ok(del.line === 60, "no + line shown: the hunk start");
ok(live.lines[3].n === 302 && live.lines[2].n === 213 && live.lines[1].n === 212 && live.lines[0].n === null, "n walks the hunk; - lines have none");
ok(live.turn === 1, "turn number is 1-based");

const done = (el: number) => writing([turn("done", edit("1", P, P1), { elapsed: el })], ROOT, 100 + 30 + 30)!; // ended at 130
ok(done(30).live === false, "ended 30s ago: WROTE, not live");
ok(writing([turn("done", edit("1", P, P1), { elapsed: 30 })], ROOT, 220) === null, "ended 90s ago: nothing");
ok(writing([turn("running", edit("1", P))], ROOT, 120) === null, "no patch: skipped");
ok(writing([turn("running", [{ type: "text", text: "hi" }])], ROOT, 120) === null, "nothing written: null");
const bare = writing([turn("running", edit("1", P, ["+a", "-b"]))], ROOT, 120)!;
ok(bare.line === null && bare.lines.every((l) => l.n === null), "no header: line and n are null");
ok(writing([turn("running", edit("1", "/other/x.ts", P1))], ROOT, 120)!.path === "/other/x.ts", "outside root: as is");
ok(writing([turn("running", [...edit("1", P, P1), ...edit("2", "/w/repo/a.py", P1)])], ROOT, 120)!.name === "a.py", "the newest of two files");
console.log("done");
