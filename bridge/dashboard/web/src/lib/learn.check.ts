// Run: node --experimental-strip-types src/lib/learn.check.ts  (from web/)
//
// Two things break quietly here: a lesson key that collides across repos (every
// repo numbers from 0001, so the wrong lesson reads as already-read), and a
// question regex that swallows the rest of the lesson and spoils it. Pin both.
import { checkYourself, lessonKey, nextUnread, shelves, UNSORTED } from "./learn.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const L = (file: string, concept: string, at: number, project?: string) =>
  ({ file, title: file, concept, at, project }) as never;

ok(lessonKey({ project: "/a", file: "0001-x.md" }) !== lessonKey({ project: "/b", file: "0001-x.md" }),
  "the same file number in two repos is two different lessons");

const list = [
  L("0001-a.md", "testing", 100),
  L("0002-b.md", "ui & rendering", 300),
  L("0003-c.md", "testing", 200),
  L("0004-d.md", "", 400),
];

const sh = shelves(list, new Set());
eq(sh.map((s) => s.concept), ["ui & rendering", "testing", UNSORTED],
  "shelves sort by their newest lesson, unsorted always last");
eq(sh[1].lessons.map((l) => l.file), ["0003-c.md", "0001-a.md"],
  "a shelf is newest-first inside");
eq(sh.map((s) => s.unread), [1, 2, 1], "every lesson is unread when nothing is read");
eq(shelves(list, new Set([lessonKey(list[0])])).find((s) => s.concept === "testing")!.unread, 1,
  "reading one lesson drops its shelf's unread count");
eq(shelves([], new Set()), [], "no lessons, no shelves");

eq(nextUnread(list, new Set())!.file, "0004-d.md", "the newest lesson is the one to open");
eq(nextUnread(list, new Set([lessonKey(list[3])]))!.file, "0002-b.md",
  "reading the newest moves on to the next");
eq(nextUnread(list, new Set(list.map(lessonKey))), undefined, "all read, nothing to nag with");

const lesson = `# A title
> concept: testing

**What changed** — stuff happened.

**Check yourself** — Why does the reducer own the timer
and not the component?

---
*Written 2026-08-07 from one turn.*`;

eq(checkYourself(lesson), "Why does the reducer own the timer and not the component?",
  "the question spans lines but stops at the blank one");
ok(!checkYourself(lesson).includes("Written"), "the footer is never part of the question");
ok(!checkYourself(lesson).includes("What changed"), "the body is never part of the question");
eq(checkYourself("**Check yourself** — Last line, no trailing blank."),
  "Last line, no trailing blank.", "a question at end-of-file still parses");
eq(checkYourself("# no question here\n\njust prose."), "", "a lesson without the section asks nothing");

console.log("\nall learn checks passed");
