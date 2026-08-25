/* The pan/zoom arithmetic behind the CANVAS view, kept out of the component so
 * it can be checked without a DOM (viewport.check.ts).
 *
 * A viewport is the board's transform: `translate(tx,ty) scale(scale)` applied
 * to a world whose origin sits at (ORIGIN_X, ORIGIN_Y) inside the canvas. Every
 * function here takes and returns that triple and nothing else — no refs, no
 * measurement. The component measures; this decides.
 *
 * Zoom is anchored, not centred: `zoomAt` keeps the point under the cursor
 * still, which is the difference between a board you can read and one that
 * swims away from whatever you were looking at. The identity it preserves is
 * `world = (screen - t) / scale` for the anchor point.
 */

export interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}

/** Where the world's (0,0) sits inside the canvas element. The top inset clears
 *  the floating header, the left one keeps the first card off the edge. */
export const ORIGIN_X = 48;
export const ORIGIN_Y = 76;

/** Below .35 the transcript is unreadable texture; above 2 it is a magnifier
 *  nobody asked for. Both ends are where the mock parked them. */
export const MIN_SCALE = 0.35;
export const MAX_SCALE = 2;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Zoom by `factor`, holding the world point under (px,py) fixed. px/py are
 *  canvas-relative and already origin-adjusted — i.e. `clientX - rect.left -
 *  ORIGIN_X`. Clamping happens first, so a scroll that runs into either stop
 *  leaves the board exactly where it was instead of drifting a pixel per tick. */
export function zoomAt(v: Viewport, px: number, py: number, factor: number): Viewport {
  const scale = clampScale(v.scale * factor);
  const k = scale / v.scale;
  return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
}

/** Frame a `boardW`-wide world in a `width`-wide canvas: shrink to fit (never
 *  enlarge past 1 — a 760px column blown up to fill a wide screen reads as a
 *  zoom bug, not a fit) and centre what's left. The `Math.max(16, …)` floor is
 *  what keeps a board wider than the canvas pinned to the left edge rather than
 *  hanging off it.
 *
 *  Clamped, because `width` is measured: a canvas narrower than `pad` — which
 *  includes the 0 every element reports before its first layout — otherwise
 *  yields a negative scale, and a mirrored board is a stranger bug to find than
 *  a board that opens too small. */
export function fitBoard(width: number, boardW: number, pad = 64): Viewport {
  const scale = clampScale(Math.min(1, (width - pad) / boardW));
  return { scale, tx: Math.max(16, (width - boardW * scale) / 2 - ORIGIN_X), ty: 0 };
}
