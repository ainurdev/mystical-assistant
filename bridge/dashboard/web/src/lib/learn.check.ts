// Run: node --experimental-strip-types src/lib/learn.check.ts  (from web/)
//
// Two things break quietly here: a lesson key that collides across repos (every
// repo numbers from 0001, so the wrong lesson reads as already-read), and a
// question regex that swallows the rest of the lesson and spoils it. Pin both.
import { checkYourself, deal, dueCount, grade, lessonKey, nextUnread, shelves, UNSORTED, type Sched } from "./learn.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const L = (file: string, concept: string, at: number, project?: string, topic?: string) =>
  ({ file, title: file, concept, topic, at, project }) as never;

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

// ── topic groups inside a shelf ──────────────────────────────────────────────
const tl = [
  L("0001-a.md", "testing", 100, undefined, "drift guards"),
  L("0002-b.md", "testing", 300, undefined, "drift guards"),
  L("0003-c.md", "testing", 200),
  L("0004-d.md", "testing", 400, undefined, "fixtures"),
];
const tsh = shelves(tl, new Set())[0]!;
eq(tsh.groups.map((g) => g.topic), ["fixtures", "drift guards", ""],
  "topic groups sort by newest, topicless tail last");
eq(tsh.groups[1]!.lessons.map((l) => l.file), ["0002-b.md", "0001-a.md"],
  "a group is newest-first inside");
eq(tsh.groups.map((g) => g.unread), [1, 2, 1], "group unread counts");
eq(shelves(list, new Set())[0]!.groups.map((g) => g.topic), [""],
  "topicless lessons form one plain group");

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

// ── study scheduler — gentle mode: only REVIEW returns ──────────────────────
const DAY = 86400e3;
const t0 = 1000 * DAY;
let s: Sched = {};
s = grade(s, "k", "got", t0);
eq(s, {}, "GOT IT on a fresh lesson retires it — no entry");
s = grade(s, "k", "review", t0);
eq(s, { k: { box: 1, due: t0 + DAY } }, "REVIEW enters the ladder at box 1, due tomorrow");
s = grade(s, "k", "got", t0 + DAY);
eq(s, { k: { box: 2, due: t0 + 4 * DAY } }, "GOT IT climbs to box 2, due in 3 days");
s = grade(s, "k", "review", t0 + 4 * DAY);
eq(s.k!.box, 1, "REVIEW resets the ladder");
s = grade(s, "k", "got", t0 + 5 * DAY);
s = grade(s, "k", "got", t0 + 8 * DAY);
eq(s.k, { box: 3, due: t0 + 15 * DAY }, "box 3 waits a week");
s = grade(s, "k", "got", t0 + 15 * DAY);
eq(s, {}, "GOT IT off the top retires");
eq(grade({ k: { box: 2, due: 0 } }, "k", "skip", t0), {}, "SKIP retires whatever it was");

const dl = [
  L("0001-a.md", "testing", 100),
  L("0002-b.md", "testing", 200),
  L("0003-c.md", "ui & rendering", 300),
  L("0004-d.md", "", 400),
];
const K = (i: number) => lessonKey(dl[i]);
eq(deal(dl, new Set(), {}, t0)!.file, "0001-a.md", "no reviews: fresh deal is oldest-first");
eq(deal(dl, new Set(), {}, t0, "testing")!.file, "0003-c.md",
  "round-robin: the concept just dealt yields to another shelf");
eq(deal([dl[0], dl[1]], new Set(), {}, t0, "testing")!.file, "0001-a.md",
  "one shelf left: round-robin falls back to oldest");
const sched: Sched = { [K(3)]: { box: 1, due: t0 - 1 }, [K(2)]: { box: 2, due: t0 - 2 } };
eq(deal(dl, new Set([K(2), K(3)]), sched, t0)!.file, "0003-c.md",
  "due reviews first, most overdue first");
eq(deal(dl, new Set(dl.map(lessonKey)), { [K(0)]: { box: 1, due: t0 + DAY } }, t0),
  undefined, "all read, nothing due: the deck is clear");
eq(dueCount(dl, sched, t0), 2, "dueCount counts entries past due");

console.log("\nall learn checks passed");
