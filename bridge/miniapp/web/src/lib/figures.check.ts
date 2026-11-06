// Run: node --experimental-strip-types --no-warnings src/lib/figures.check.ts
import { figuresOf, isShowTool, nextNote, type Ev } from "./figures.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

ok(isShowTool("mcp__verify__Attach") && isShowTool("mcp__verify__Record"), "Attach and Record show");
ok(!isShowTool("mcp__verify__Screenshot") && !isShowTool("Read") && !isShowTool(undefined), "Screenshot and Read look");

const done: Record<string, { images?: string[]; clip?: { notes?: string } }> = {
  a: { images: ["/up/a.webm"], clip: { notes: "the fix, working" } },
  b: { images: ["/up/b.png"] },
  c: {},
  r: { images: ["/up/r.png"] },
};
const doneOf = (e: Ev) => (e.id ? done[e.id] : undefined);
const f = figuresOf([
  { type: "text", text: "hi" },
  { type: "figure", kind: "shown", images: ["/up/1.png"], caption: "one" },
  { type: "figure", kind: "compare", images: ["/up/b.png", "/up/a.png"], caption: "two" },
  { type: "figure", kind: "compare", images: ["/up/only.png"], caption: "half a pair" },
  { type: "figure", kind: "shown", images: [], caption: "nothing" },
  { type: "tool", name: "mcp__verify__Attach", id: "a", summary: "/x/a.webm" },
  { type: "tool", name: "mcp__verify__Attach", id: "b", summary: "/x/shots/b.png?x=1" },
  { type: "tool", name: "mcp__verify__Record", id: "c", summary: "/x/c" },
  { type: "tool", name: "mcp__verify__Attach", id: "gone", summary: "/x/d" },
  { type: "tool", name: "Read", id: "r", summary: "/x/r.png" },
], doneOf);
ok(f.map((x) => x.at).join() === "1,2,3,5,6", `the shown ones: ${f.map((x) => x.at)}`);
ok(f[1].kind === "compare" && f[2].kind === "shown", "compare needs two");
ok(f[3].caption === "the fix, working" && !!f[3].clip, "a clip's note is its caption");
ok(f[4].caption === "b.png", "else its file name");

const evs: Ev[] = [
  { type: "tool", name: "Read", id: "r" },
  { type: "tool_done", id: "r" },
  { type: "thinking" },
  { type: "text", text: " the header overlaps " },
  { type: "tool", name: "Read", id: "s" },
  { type: "tool_done", id: "s" },
  { type: "tool", name: "Bash", id: "t" },
  { type: "text", text: "after another call" },
  { type: "tool", name: "Read", id: "u" },
  { type: "text", text: "the end" },
  { type: "result", result: "the end" },
];
ok(nextNote(evs, 0) === "the header overlaps", "the next words, skipping bookkeeping");
ok(nextNote(evs, 4) === "", "another call first: not about this picture");
ok(nextNote(evs, 8) === "", "the answer isn't a note");
ok(nextNote(evs, 10) === "", "nothing after");
ok(nextNote([{ type: "tool" }, { type: "thinking", text: "hm" }], 0) === "hm", "a thought counts");
