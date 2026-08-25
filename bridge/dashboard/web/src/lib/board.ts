/** Pan/zoom arithmetic for the CANVAS view's world layer.
 *
 *  Split out of the component for one reason: zoom-about-a-point is the kind of
 *  two-line formula that is wrong by a factor of `scale` in a way nobody notices
 *  until the board crawls away from the cursor. It gets a check file; the
 *  component that uses it does not need one.
 *
 *  Coordinates are canvas-local and already past the world layer's inset — the
 *  caller subtracts OX/OY before asking. */

export interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}

export const MIN_SCALE = 0.35;
export const MAX_SCALE = 2;

const clamp = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Scale by `factor`, keeping whatever sits under (px,py) under it. Clamped, so
 *  a wheel spun past the stops moves nothing rather than drifting. */
export function zoomAt(v: Viewport, px: number, py: number, factor: number): Viewport {
  const scale = clamp(v.scale * factor);
  const k = scale / v.scale;
  return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
}

/** Centre a board `width` wide inside `avail` pixels of canvas, leaving 64px of
 *  margin. Never magnifies: a board that already fits is shown at 1:1 rather
 *  than blown up to fill, because these are text cards and 1.4x text is worse
 *  text. `inset` is the world layer's left offset, which the centring has to
 *  cancel out. */
export function fitWidth(avail: number, width: number, inset: number): Viewport {
  const scale = clamp(Math.min(1, (avail - 64) / width));
  return { scale, tx: Math.max(16, (avail - width * scale) / 2 - inset), ty: 0 };
}
