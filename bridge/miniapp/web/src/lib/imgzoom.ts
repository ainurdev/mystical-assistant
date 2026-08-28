/* Pan/zoom arithmetic for the image lightbox — a copy of the dashboard's
 * src/lib/imgzoom.ts, the same two-app duplication as the RunStream/Composer
 * pair. Checked there: dashboard/web/src/lib/imgzoom.check.ts.
 *
 * A view is `translate(x,y) scale(s)` on the image, in screen pixels measured
 * from the centre of the overlay — which is where flex centring already puts
 * the image, so "fit to screen" is {s:1,x:0,y:0} and costs no measurement.
 *
 * Zoom is anchored, not centred: `zoomAt` holds the point under the pinch
 * midpoint still, preserving `world = (p - x) / s` for that point.
 * Panning is clamped to the image's own overflow, because an unclamped drag on
 * a phone flings the picture off-screen with no way back to it.
 */

export interface View { s: number; x: number; y: number }

/** Fit to screen: the size CSS already laid out, untransformed. */
export const FIT: View = { s: 1, x: 0, y: 0 };

/** Below 1 the image would shrink inside an overlay whose whole job is to
 *  enlarge it; past 8 a screenshot is mush rather than pixels. */
export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Scale by `factor`, holding the point (px,py) — measured from the overlay's
 *  centre — still. Clamped first, so a wheel that runs into a stop leaves the
 *  image exactly where it was instead of drifting a pixel per tick. */
export function zoomAt(v: View, px: number, py: number, factor: number): View {
  const s = clampScale(v.s * factor);
  const k = s / v.s;
  return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/** Keep the image covering the box: pan is free only across the overflow, so at
 *  fit scale it is pinned to centre and can't be dragged away. `w`/`h` are the
 *  image's laid-out (scale 1) size — transforms don't change those. */
export function clampPan(v: View, boxW: number, boxH: number, w: number, h: number): View {
  const lim = (span: number, box: number) => Math.max(0, (span * v.s - box) / 2);
  const to = (n: number, m: number) => Math.min(m, Math.max(-m, n));
  return { s: v.s, x: to(v.x, lim(w, boxW)), y: to(v.y, lim(h, boxH)) };
}
