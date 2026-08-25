// Run: node bridge/dashboard/web/src/lib/viewport.check.ts
import { MAX_SCALE, MIN_SCALE, clampScale, fitBoard, zoomAt, type Viewport } from "./viewport.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

ok(clampScale(0.01) === MIN_SCALE && clampScale(99) === MAX_SCALE, "scale clamps to both stops");
ok(clampScale(1) === 1, "an in-range scale is left alone");

// The whole point of an anchored zoom: the world point under the cursor does
// not move. world = (screen - t) / scale, before and after.
const start: Viewport = { tx: 30, ty: -120, scale: 1 };
for (const [px, py, f] of [[400, 300, 1.09], [0, 0, 1 / 1.09], [-90, 640, 1.5]] as const) {
  const before = { x: (px - start.tx) / start.scale, y: (py - start.ty) / start.scale };
  const v = zoomAt(start, px, py, f);
  const after = { x: (px - v.tx) / v.scale, y: (py - v.ty) / v.scale };
  ok(near(before.x, after.x) && near(before.y, after.y),
     `zoom at (${px},${py}) x${f} holds the point under the cursor`);
}

// Clamping first, not after: at a stop the board must not creep.
const atMax = zoomAt({ tx: 12, ty: 34, scale: MAX_SCALE }, 500, 400, 1.09);
ok(atMax.scale === MAX_SCALE && atMax.tx === 12 && atMax.ty === 34, "zooming past MAX moves nothing");
const atMin = zoomAt({ tx: 12, ty: 34, scale: MIN_SCALE }, 500, 400, 0.5);
ok(atMin.scale === MIN_SCALE && atMin.tx === 12 && atMin.ty === 34, "zooming past MIN moves nothing");

ok(near(zoomAt(start, 100, 100, 2).scale, 2), "the factor is applied to the scale");

// Fit: shrink to fit, never enlarge, and stay left of the edge when it can't fit.
ok(fitBoard(2000, 760).scale === 1, "a board that already fits is not blown up");
ok(near(fitBoard(500, 1152).scale, (500 - 64) / 1152), "a board wider than the canvas shrinks to fit");
ok(fitBoard(500, 1152).tx === 16, "a board that fills the canvas is pinned to the left inset");
const wide = fitBoard(2000, 760);
ok(near(wide.tx, (2000 - 760) / 2 - 48), "a board narrower than the canvas is centred");
ok(fitBoard(2000, 760).ty === 0 && fitBoard(500, 1152).ty === 0, "fit always returns to the top");
ok(fitBoard(40, 1152).scale > 0, "a canvas narrower than the padding still yields a usable scale");

console.log("\nviewport.check.ts — all good");
