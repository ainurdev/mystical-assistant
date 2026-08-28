// Run: node bridge/dashboard/web/src/lib/imgzoom.check.ts
import { FIT, MAX_SCALE, MIN_SCALE, clampPan, clampScale, zoomAt, type View } from "./imgzoom.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

ok(clampScale(0.2) === MIN_SCALE && clampScale(99) === MAX_SCALE, "scale clamps to both stops");

// The point under the finger stays under the finger: world = (p - x) / s.
const start: View = { s: 1.4, x: 30, y: -120 };
for (const [px, py, f] of [[400, 300, 1.09], [0, 0, 1 / 1.09], [-90, 640, 1.5]] as const) {
  const v = zoomAt(start, px, py, f);
  ok(near((px - start.x) / start.s, (px - v.x) / v.s) && near((py - start.y) / start.s, (py - v.y) / v.s),
     `zoom at (${px},${py}) x${f} holds the point under the cursor`);
}

// Clamping first, not after: at a stop nothing may creep.
const atMax = zoomAt({ s: MAX_SCALE, x: 12, y: 34 }, 500, 400, 2);
ok(atMax.x === 12 && atMax.y === 34, "zooming past MAX moves nothing");
const atMin = zoomAt({ s: MIN_SCALE, x: 12, y: 34 }, 500, 400, 0.5);
ok(atMin.x === 12 && atMin.y === 34, "pinching past fit moves nothing");

// Pan: free across the overflow only, so fit scale can't be dragged off-centre.
const pinned = clampPan({ s: 1, x: 999, y: -999 }, 800, 600, 400, 300);
ok(pinned.x === 0 && pinned.y === 0, "at fit the image is pinned to centre");
const wide = clampPan({ s: 4, x: 9999, y: 0 }, 800, 600, 400, 300);
ok(wide.x === (400 * 4 - 800) / 2, "a zoomed image stops with its edge at the edge");
ok(clampPan({ s: 4, x: -50, y: 20 }, 800, 600, 400, 300).x === -50, "a pan inside the overflow is left alone");
ok(FIT.s === 1 && FIT.x === 0 && FIT.y === 0, "FIT is the untransformed image");

console.log("\nimgzoom.check.ts — all good");
