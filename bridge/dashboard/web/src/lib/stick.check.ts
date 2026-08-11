// Run: node bridge/dashboard/web/src/lib/stick.check.ts
import { nearBottom, stickOnResize, stickToBottom } from "./stick.ts";

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

// Resize ticks are not gestures. The check above only held because its growth
// was big enough to leave the 80px band; a streamed chunk is not. Nudge up 50px
// (unstuck), then let the turn add 10px: the gesture test says re-stick, which
// is what yanked a reader back to the bottom mid-run.
ok(stickToBottom(el(550, 1010), 550), "…but the gesture test alone re-sticks on a small growth");
ok(!stickOnResize(el(550, 1010), false), "a resize inside the band leaves you where you are");
ok(!stickOnResize(el(550, 1200), false), "…and a big one does too");
ok(stickOnResize(el(600), false), "a shrink that lands exactly on the end resumes follow");
ok(stickOnResize(el(100), true), "already following, a resize keeps following");

// Sending a prompt: follow it from within a screen of the end, stay put beyond.
ok(nearBottom(el(600)), "at the bottom, a sent prompt pulls the view down");
ok(nearBottom(el(240)), "a screen up (360px) still counts as close");
ok(!nearBottom(el(100)), "far up the transcript, a sent prompt doesn't move you");

console.log("stick.check passed");
