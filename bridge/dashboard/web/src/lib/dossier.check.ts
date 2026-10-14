// Run: node bridge/dashboard/web/src/lib/dossier.check.ts
import { stripOf, workTitle, zonesOf, STRIP_MAX, type Mark } from "./dossier.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const p = (i: number) => ({ kind: "prose" as const, idx: [i] });
const st = (...idx: number[]) => ({ kind: "steps" as const, idx });
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

// The strip caps and says how many it dropped.
{
  const marks: Mark[] = Array.from({ length: STRIP_MAX + 5 }, () => "command");
  const s = stripOf(marks);
  ok(s.shown.length === STRIP_MAX && s.more === 5, "strip caps at STRIP_MAX");
  ok(stripOf(["think", "fail"]).more === 0, "a short strip is whole");
}

ok(workTitle("2 commands · 1 edit", 3) === "2 commands · 1 edit · 3 notes", "title with notes");
ok(workTitle("", 1) === "1 note", "notes only");
ok(workTitle("1 command", 0) === "1 command", "steps only");
