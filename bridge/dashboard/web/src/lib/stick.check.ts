// Run: node bridge/dashboard/web/src/lib/stick.check.ts
import { stickToBottom } from "./stick.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

// A 400px viewport over 1000px of transcript: the bottom is scrollTop 600.
const el = (scrollTop: number, scrollHeight = 1000) => ({ scrollTop, scrollHeight, clientHeight: 400 });

ok(stickToBottom(el(600), 600), "parked at the bottom follows new content");
ok(stickToBottom(el(560), 540), "scrolling back down into the band re-arms follow");
ok(!stickToBottom(el(100), 100), "sitting far up doesn't follow");

// The reported bug: a small flick up with a tall result at the end used to stay
// stuck, so the result's next resize snapped the view back down.
ok(!stickToBottom(el(570), 600), "a 30px move up inside the band unsticks");
ok(!stickToBottom(el(570, 1200), 570), "content growing while unstuck doesn't re-stick");

// A shrink clamps scrollTop to the new bottom without the user touching anything.
ok(stickToBottom(el(600), 900), "a shrink that lands us on the bottom stays stuck");

console.log("stick.check passed");
