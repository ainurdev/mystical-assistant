// The shell grid's column tracks. The status bar used to be a second grid on
// the same tracks; its cells now sit in the hudgrid's own bottom track under
// the side columns (StatusBar.tsx), and the strip caps the side columns from
// inside them (Strip.tsx). The tracks are defined once here; never re-type
// the numbers.
import type { CSSProperties } from "react";

/** The right panel's body width. RightPanel sizes the body from this too — it
 *  used to re-type the clamp, and drifted a track-width behind, leaving a dead
 *  column between the transcript and the panel's left border. */
export const rightBodyW = "clamp(230px,20vw,340px)";

export function shellCols(rightOpen: boolean): string {
  return `clamp(260px,22vw,400px) minmax(0,1fr) ${rightOpen ? `calc(${rightBodyW} + 48px)` : "48px"}`;
}

/** Wide screens: the chat stops growing and the surplus becomes even gutters.
 *  1120 at --fs:12 is the widest figure (--md-wide, 76em at t13 ≈ 988) plus the
 *  scroller's padding; it rides --fsu so a larger BASE FONT SIZE moves the cap
 *  with the text. Inline padding on the centre column, so the transcript, the
 *  composer and its rule all sit on one measure — and the header island, which
 *  is absolute against the same box, insets by the same amount. */
export const chatPad = "max(0px, calc((100% - var(--fsu) * 1120) / 2))";

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
