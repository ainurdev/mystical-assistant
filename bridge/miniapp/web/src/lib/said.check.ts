// Run: node bridge/miniapp/web/src/lib/said.check.ts
import { endedWithout, saidLayout } from "./said.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const t = (type: string, text?: string) => ({ type, text });
const shape = (l: ReturnType<typeof saidLayout>) => l.segs.map((s) => `${s.kind}:${s.idx.join(",")}`).join(" ");

// Notes between tools: one fold, the notes out of it, the tier at the end.
{
  const evs = [t("text", "looking"), t("tool"), t("tool_done"), t("text", "found it"), t("tool"), t("tool_done")];
  const l = saidLayout(evs);
  ok(shape(l) === "steps:1,2,4,5", `one fold: ${shape(l)}`);
  ok(l.notes.join() === "0,3", "both notes in the tier");
  ok(l.at === 1, "tier after the work");
}

// Thinking stays in the work.
{
  const l = saidLayout([t("thinking", "hm"), t("tool"), t("tool_done"), t("text", "note")]);
  ok(shape(l) === "steps:0,1,2", `thought folded: ${shape(l)}`);
}

// The result: its repeated text isn't a note, and the tier sits above the card.
{
  const evs = [t("tool"), t("tool_done"), t("text", "halfway"), t("text", "the answer"), { type: "result", result: "the answer" }];
  const l = saidLayout(evs);
  ok(l.notes.join() === "2", "the answer isn't a note");
  ok(shape(l) === "steps:0,1 prose:4", shape(l));
  ok(l.at === 1, "tier above the result");
}

// Stopped and error rows stay under what it said.
{
  const l = saidLayout([t("tool"), t("tool_done"), t("text", "n"), t("stopped")]);
  ok(l.at === 1 && l.segs.length === 2, "tier above stopped");
}

// A card waiting on you stays at the foot, under the tier.
{
  const evs = [t("text", "need a call"), t("question"), t("tool"), t("tool_done")];
  const l = saidLayout(evs, 0, () => false, (i) => i === 1);
  ok(shape(l) === "steps:2,3 prose:1", shape(l));
  ok(l.at === 1, "tier above the waiting card");
}

// Another agent's steer keeps its place in the flow.
{
  const evs = [t("tool"), t("steer", "⇄ x"), t("text", "ok"), t("tool")];
  const l = saidLayout(evs);
  ok(shape(l) === "steps:0 prose:1 steps:3", shape(l));
}

// A tail cut leaves older notes in the count.
{
  const evs = [t("text", "old"), t("tool"), t("tool_done"), t("tool"), t("tool_done"), t("text", "new")];
  const l = saidLayout(evs, 3);
  ok(l.notes.join() === "0,5", "old note still counted");
  ok(!l.segs.some((s) => s.idx.includes(1)), "the cut still cuts the work");
}

// A flow row (a delegation, say) breaks the fold.
{
  const evs = [t("tool"), t("delegation"), t("tool")];
  const l = saidLayout(evs, 0, (i) => i === 1);
  ok(shape(l) === "steps:0 prose:1 steps:2", shape(l));
}

ok(endedWithout([t("text", "n"), t("stopped")], true) === "stopped", "stopped");
ok(endedWithout([t("text", "n")], true) === "cut", "cut off");
ok(endedWithout([t("text", "n")], false) === null, "still running");
ok(endedWithout([{ type: "result", result: "a" }], true) === null, "it answered");
