// Run: node bridge/dashboard/web/src/lib/usagering.check.ts
import { ringDash, ringText, barHeights, todayIndex, RING_C } from "./usagering.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.assert(Math.abs(ringDash(62) - 0.62 * RING_C) < 1e-9, "62% is 62% of the circumference");
console.assert(ringDash(null) === 0 && ringDash(-5) === 0 && Math.abs(ringDash(140) - RING_C) < 1e-9, "unknown and out-of-range clamp");
console.assert(ringText(62) === "62%" && ringText(null) === "—", "unknown figure reads a dash");
console.assert(same(barHeights([0, 10, 5], 40), [2, 40, 20]), "heights scale to the max, zero is a 2px stub");
console.assert(same(barHeights([0, 0], 40), [2, 2]), "an empty week is all stubs");
console.assert(todayIndex("2026-11-04", "2026-11-02") === 2, "Wed is the third day of the week from Mon Nov 2");
console.assert(todayIndex("2026-11-12", "2026-11-02") === -1 && todayIndex("2026-11-01", "2026-11-02") === -1, "outside the week: none lit");
