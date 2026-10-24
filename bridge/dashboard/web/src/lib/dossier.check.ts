// Run: node bridge/dashboard/web/src/lib/dossier.check.ts
import { chapterStarts, kindsOf, stretchesOf, workTitle, zonesOf, TOP_TYPES } from "./dossier.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const p = (i: number) => ({ kind: "prose" as const, idx: [i], start: i });
const st = (...idx: number[]) => ({ kind: "steps" as const, idx, start: idx[0] });
const shape = (zs: ReturnType<typeof zonesOf>) =>
  zs.map((z) => `${z.kind}:${z.segs.map((s) => s.idx.join(",")).join("|")}`).join(" ");

// A thought, a fold, a note, then the answer: one work zone, then the answer.
{
  const segs = [p(0), st(1, 2), p(3), p(4)];
  const zs = zonesOf(segs, (s) => s.idx[0] === 4);
  ok(shape(zs) === "work:0|1,2|3 top:4", `work then answer: ${shape(zs)}`);
}

// A question splits the work: what came before it and after it are two zones.
{
  const segs = [st(0, 1), p(2), st(3), p(4)];
  const zs = zonesOf(segs, (s) => s.idx[0] === 2 || s.idx[0] === 4);
  ok(shape(zs) === "work:0,1 top:2 work:3 top:4", `split at a question: ${shape(zs)}`);
}

// Your steer is yours, not the work's: its own tier, and the work around it
// becomes two zones, the way a question splits it.
{
  const types = ["tool", "tool", "steer", "tool", "result"];
  const segs = [st(0, 1), p(2), st(3), p(4)];
  const zs = zonesOf(segs, (s) => TOP_TYPES.has(types[s.idx[0]]));
  ok(shape(zs) === "work:0,1 top:2 work:3 top:4", `a steer splits the work: ${shape(zs)}`);
  ok(!TOP_TYPES.has("tool") && !TOP_TYPES.has("thinking") && !TOP_TYPES.has("log"), "steps, thoughts and hooks stay work");
}

// Nothing but the answer: no empty zone in front of it.
{
  const zs = zonesOf([p(0)], () => true);
  ok(shape(zs) === "top:0", "a bare answer makes no zone");
}

// Still running, no answer yet: the whole turn is one zone.
{
  const zs = zonesOf([p(0), st(1, 2, 3)], () => false);
  ok(zs.length === 1 && zs[0].kind === "work", "a live turn is one zone");
}

// The header's chips: one per kind of step, in the STEPS title's order, then
// the notes — the count sentence turned into glyphs.
{
  const k = kindsOf(["read", "command", "command", "read", "agent"], 2);
  ok(k.map((x) => `${x.m}:${x.n}`).join(" ") === "command:2 agent:1 read:2 note:2", `chips in CAT_ORDER then notes: ${k.map((x) => x.m).join(",")}`);
  ok(kindsOf(["edit"], 0).length === 1, "no notes makes no note chip");
  ok(kindsOf([], 1).map((x) => x.m).join() === "note", "notes alone are one chip");
}

ok(workTitle("2 commands · 1 edit", 3) === "2 commands · 1 edit · 3 notes", "title with notes");
ok(workTitle("", 1) === "1 note", "notes only");
ok(workTitle("1 command", 0) === "1 command", "steps only");

// A long zone's chapters: about every 100 steps, at the next note the agent
// writes, so each opens on its own words; short zones stay one list.
{
  const pairs = (n: number) => Array.from({ length: n }, () => [1, 9]).flat(); // a note, then 9 steps
  const notes = (n: number) => Array.from({ length: n }, () => [true, false]).flat();
  ok(chapterStarts(pairs(20), notes(20)).join() === "", "200 steps stay one list");
  ok(chapterStarts(pairs(25), notes(25)).join() === "0,20,40", `250 steps cut at the note after each 100: ${chapterStarts(pairs(25), notes(25))}`);
  ok(chapterStarts([150, 1, 60], [false, true, false]).join() === "0,1", "a cut waits for the next note");
  ok(chapterStarts([300], [false]).join() === "", "no note to open a chapter on: one list");
  const full = chapterStarts(pairs(40), notes(40)), live = chapterStarts(pairs(30).concat(1), notes(30).concat(true));
  ok(full.slice(0, live.length).join() === live.join(), `steps landing later never move a cut: ${live} / ${full}`);
}

// An open zone as the words, each with the work after it up to the next words;
// work before any words is a stretch of its own (-1).
{
  const s = (w: boolean[]) => stretchesOf(w).map((x) => `${x.words}:${x.work.join(",")}`).join(" ");
  ok(s([]) === "", "no segments, no stretches");
  ok(s([true, false, false, true]) === "0:1,2 3:", `a note, its two steps, a note: ${s([true, false, false, true])}`);
  ok(s([false, false, true, false]) === "-1:0,1 2:3", `work before any words: ${s([false, false, true, false])}`);
  ok(s([true, true]) === "0: 1:", "two notes back to back, no work between");
  // live: steps landing later only grow the last stretch, never move one
  const full = [true, false, true, false, false, true, false, false, false];
  for (let n = 1; n <= full.length; n++) {
    const a = stretchesOf(full.slice(0, n)), b = stretchesOf(full);
    ok(a.slice(0, -1).every((x, k) => JSON.stringify(x) === JSON.stringify(b[k])), `prefix of ${n} keeps every closed stretch`);
  }
}
