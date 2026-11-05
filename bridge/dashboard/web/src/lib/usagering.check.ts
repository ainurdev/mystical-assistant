// Run: node bridge/dashboard/web/src/lib/usagering.check.ts
import { ringDash, ringText, barHeights, todayIndex, capText, ringWindow, ofWeek, RING_C } from "./usagering.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.assert(Math.abs(ringDash(62) - 0.62 * RING_C) < 1e-9, "62% is 62% of the circumference");
console.assert(ringDash(null) === 0 && ringDash(-5) === 0 && Math.abs(ringDash(140) - RING_C) < 1e-9, "unknown and out-of-range clamp");
console.assert(ringText(62) === "62%" && ringText(null) === "—", "unknown figure reads a dash");
console.assert(same(barHeights([0, 10, 5], 40), [2, 40, 20]), "heights scale to the max, zero is a 2px stub");
console.assert(same(barHeights([0, 0], 40), [2, 2]), "an empty week is all stubs");
console.assert(todayIndex("2026-11-04", "2026-11-02") === 2, "Wed is the third day of the week from Mon Nov 2");
console.assert(todayIndex("2026-11-12", "2026-11-02") === -1 && todayIndex("2026-11-01", "2026-11-02") === -1, "outside the week: none lit");
console.assert(capText(90, 53) === "90 turns · 53 sessions" && capText(1, 1) === "1 turn · 1 session", "week caption");
console.assert(capText(63) === "63 turns" && capText(0) === "0 turns", "day caption: turns only");
{
  const h5 = { tag: "5H", resets_at: "2026-11-05T12:00:00Z" }, wk = { tag: "WK", resets_at: "2026-11-09T12:00:00Z" };
  const now = Date.parse("2026-11-05T10:00:00Z");
  console.assert(ringWindow([wk, h5], now) === h5, "ring takes the 5-hour window");
  console.assert(ringWindow([wk], now) === null, "only a week window: no ring reading");
  console.assert(ringWindow([h5], Date.parse("2026-11-05T12:00:01Z")) === null, "a reset in the past is no reading");
  console.assert(ringWindow([{ tag: "5H", resets_at: null }], now) !== null, "no reset time: still a reading");
}
console.assert(ofWeek(46, 100) === 46 && ofWeek(1, 3) === 33 && ofWeek(5, 0) === 0, "a day's share of the week");
