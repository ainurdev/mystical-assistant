// Run: node --experimental-strip-types src/lib/board.check.ts  (from web/)
//
// Zoom-about-a-point either holds the anchor still or it doesn't; the failure
// mode is a board that slides out from under the cursor, which reads as "the
// canvas is broken" rather than "the formula is off by k".
import { fitWidth, MAX_SCALE, MIN_SCALE, zoomAt, type Viewport } from "./board.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const near = (got: number, want: number, what: string) =>
  ok(Math.abs(got - want) < 1e-9, `${what} — got ${got}, want ${want}`);

/** Where a world point lands on screen under a viewport. */
const project = (v: Viewport, world: number, axis: "tx" | "ty") => world * v.scale + v[axis];

const start: Viewport = { tx: 120, ty: -40, scale: 0.8 };

// The point under the cursor before the zoom must be under it after.
for (const factor of [1.09, 1 / 1.09, 1.2, 1 / 1.2]) {
  const [px, py] = [317, 204];
  const worldX = (px - start.tx) / start.scale;
  const worldY = (py - start.ty) / start.scale;
  const after = zoomAt(start, px, py, factor);
  near(project(after, worldX, "tx"), px, `zoom x${factor.toFixed(2)} holds the anchor's x`);
  near(project(after, worldY, "ty"), py, `zoom x${factor.toFixed(2)} holds the anchor's y`);
}

near(zoomAt({ tx: 0, ty: 0, scale: MAX_SCALE }, 10, 10, 4).scale, MAX_SCALE, "zoom in stops at the ceiling");
near(zoomAt({ tx: 0, ty: 0, scale: MIN_SCALE }, 10, 10, 0.1).scale, MIN_SCALE, "zoom out stops at the floor");

// A clamped zoom must not translate either — hitting the stop should be inert,
// not a shove.
const pinned = zoomAt({ tx: 55, ty: 12, scale: MAX_SCALE }, 300, 200, 1.2);
near(pinned.tx, 55, "a clamped zoom leaves tx alone");
near(pinned.ty, 12, "a clamped zoom leaves ty alone");

// Fit: shrink to the available width, never magnify past 1:1.
near(fitWidth(500, 760, 48).scale, (500 - 64) / 760, "a wide board shrinks to fit");
near(fitWidth(2000, 760, 48).scale, 1, "a board that already fits stays at 1:1");
ok(fitWidth(200, 1152, 48).scale >= MIN_SCALE, "fit never goes below the zoom floor");

// Centred: the board's midpoint lands on the canvas's midpoint, once the world
// layer's own inset is added back.
{
  const [avail, width, inset] = [1400, 760, 48];
  const v = fitWidth(avail, width, inset);
  near(inset + v.tx + (width * v.scale) / 2, avail / 2, "fit centres the board");
}

// A canvas narrower than the margin can't produce a negative or zero scale —
// that would collapse the world layer to a point and strand the user.
ok(fitWidth(40, 1152, 48).scale > 0, "an impossibly narrow canvas still has a positive scale");

console.log("\nboard.check.ts — all good");
