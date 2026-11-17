// Run: node bridge/dashboard/web/src/lib/boxdeck.check.ts
import { deckView, enterTarget, turnClock } from "./boxdeck.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

ok(deckView([], 3).shown.length === 0 && deckView([], 3).more === 0, "an empty queue draws no deck");
const five = deckView(["a", "b", "c", "d", "e"], 3);
ok(five.shown.join("") === "abc" && five.more === 2, "the deck shows the first three in run order and counts the rest");
ok(deckView(["a", "b"], 3).more === 0, "a short queue shows whole");

ok(enterTarget("next", false, true) === "queue", "NEXT: Enter queues");
ok(enterTarget("now", false, true) === "steer", "NOW: Enter steers");
ok(enterTarget("now", true, true) === "queue", "Alt+Enter does the other one");
ok(enterTarget("next", true, true) === "steer", "Alt+Enter steers from NEXT");
ok(enterTarget("now", false, false) === "queue", "a turn that can't be steered always queues");

ok(turnClock(0) === "0s" && turnClock(42) === "42s", "seconds under a minute");
ok(turnClock(192) === "3m 12s", "minutes and seconds");
ok(turnClock(3840) === "1h 04m", "hours drop the seconds");
ok(turnClock(-5) === "0s", "a clock never goes negative");
