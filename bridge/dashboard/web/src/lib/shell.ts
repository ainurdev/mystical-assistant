// The shell's three chrome rows — strip, hudgrid, status bar — share one set
// of column tracks so every zone lines up with the panel head under it. The
// tracks are defined once here; never re-type the numbers.
import type { CSSProperties } from "react";

export function shellCols(rightOpen: boolean): string {
  return `clamp(260px,22vw,340px) minmax(0,1fr) ${rightOpen ? "calc(clamp(230px,20vw,296px) + 48px)" : "48px"}`;
}

/** Meta separator: a hairline separates meta, a border marks an action.
 *  22% accent, not the dark theme's old 14 — a 14% veil vanishes on the light
 *  grounds (the same reasoning index.css re-derives --border stronger there). */
export const hairline = (h: number): CSSProperties => ({
  width: 1, height: h, flex: "none",
  background: "color-mix(in srgb, var(--acc) 22%, transparent)",
});

/** Zone rule on a shell-grid track boundary — inset top and bottom so it reads
 *  as a rule between zones, not a full border. Put it in a position:relative
 *  zone whose left edge IS the boundary. */
export const zoneRule: CSSProperties = {
  position: "absolute", top: 7, bottom: 7, left: 0, width: 1,
  background: "color-mix(in srgb, var(--acc) 22%, transparent)",
};
