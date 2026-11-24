// Run: node src/lib/still.check.ts  (from web/)
//
// The page's still state: still after 20 s without input, at once on blur or hide; awake on input or focus.
import { mock } from "node:test";
import { STILL_AFTER_MS, watchStill } from "./still.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

mock.timers.enable({ apis: ["setTimeout", "Date"] });
const win = new EventTarget(), docT = new EventTarget();
const attrs = new Set<string>();
const doc = Object.assign(docT, {
  hidden: false,
  documentElement: { setAttribute: (n: string) => void attrs.add(n), removeAttribute: (n: string) => void attrs.delete(n) },
});
const stop = watchStill(win as never, doc as never);
const still = () => attrs.has("data-still");
const fire = (t: EventTarget, type: string) => t.dispatchEvent(new Event(type));

ok(!still(), "awake at start");
mock.timers.tick(STILL_AFTER_MS - 1);
ok(!still(), "awake just under 20 s");
mock.timers.tick(1);
ok(still(), "still at 20 s without input");

fire(win, "pointermove");
ok(!still(), "a move wakes it");
mock.timers.tick(15_000);
fire(win, "keydown");
mock.timers.tick(15_000);
ok(!still(), "input in between pushes the 20 s out");
mock.timers.tick(5_000);
ok(still(), "still 20 s after the last input");

fire(win, "focus");
ok(!still(), "focus wakes it");
fire(win, "blur");
ok(still(), "blur stills it at once");
fire(win, "wheel");
ok(!still(), "the wheel wakes it");

doc.hidden = true; fire(docT, "visibilitychange");
ok(still(), "hidden stills it at once");
doc.hidden = false; fire(docT, "visibilitychange");
ok(!still(), "shown again wakes it");

stop();
mock.timers.tick(STILL_AFTER_MS * 2);
ok(!still(), "stopped: never stills again");
mock.timers.reset();
