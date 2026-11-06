// HOME, the right rail's first tab: what the hour does to its sky, and
// today's wins laid out as a spine (one time column, even rows, the gaps you
// were away between them). Pure, so lib/home.check.ts can hold it still.
import type { TodayWins, Win } from "../api";

/** The hour's part of HOME's sky; the colours are the theme's (index.css
 *  .home-sky). Where the light sits (x/y in % of the sky), its size in px and
 *  strength in %, and on a dark ground how deep the accent runs at the top
 *  (l1/c1) and the middle (l2/c2): lightness and chroma, as factors. */
export interface Sky { x: number; y: number; w: number; h: number; a: number; l1: number; c1: number; l2: number; c2: number }

/** How tall HOME's sky runs under the cap (the cap draws the sky's top CAP_H). */
export const HOME_TOP = 195;

const NIGHT: Sky = { x: 90, y: 0, w: 230, h: 180, a: 20, l1: .42, c1: .85, l2: .2, c2: .5 }; // a dim glow, top right
const SKIES: [number, Sky][] = [
  [5, NIGHT],
  [9, { x: 4, y: 100, w: 330, h: 250, a: 62, l1: .56, c1: .8, l2: .3, c2: .55 }],   // sunrise, low on the left
  [17, { x: 52, y: 0, w: 320, h: 220, a: 45, l1: .6, c1: .8, l2: .32, c2: .55 }],   // day, overhead
  [20, { x: 96, y: 100, w: 330, h: 250, a: 50, l1: .48, c1: .85, l2: .24, c2: .55 }], // sunset, low on the right
  [24, NIGHT],
];

export function skyFor(hour: number): Sky {
  return (SKIES.find(([until]) => hour < until) ?? SKIES[0])[1];
}

export type SpineRow =
  | { kind: "win"; win: Win; verb: string; rest: string; aside: string }
  | { kind: "away"; text: string };

export function dur(secs: number): string {
  const m = Math.round(secs / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** What a win says: a bold verb, then what it was about, then a dim aside. */
export function phrase(w: Win): { verb: string; rest: string; aside: string } {
  switch (w.kind) {
    case "merge": return { verb: "merged", rest: w.text, aside: "" };
    case "commit": return { verb: "committed", rest: w.text, aside: "" };
    case "commits": return { verb: `${w.text} commits`, rest: "", aside: w.detail ?? "" };
    case "push": return { verb: "pushed", rest: w.text, aside: "" };
    case "pr": return { verb: `opened PR ${w.text}`, rest: "", aside: "" };
    case "tests": return { verb: "tests pass", rest: "", aside: w.text };
  }
}

/** Newest first, with an "away" row wherever a gap you were away falls
 *  between two wins (the gap's own length, not the distance between them). */
export function spine(day: TodayWins): SpineRow[] {
  const rows: SpineRow[] = [];
  day.wins.forEach((w, i) => {
    rows.push({ kind: "win", win: w, ...phrase(w) });
    const older = day.wins[i + 1];
    if (!older) return;
    for (const a of day.away) {
      if (a.start >= older.ts && a.end <= w.ts) rows.push({ kind: "away", text: `away ${dur(a.end - a.start)}` });
    }
  });
  return rows;
}
