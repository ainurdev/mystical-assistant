// HOME, the right rail's first tab: the sky its top wears for the hour, and
// today's wins laid out as a spine (one time column, even rows, the gaps you
// were away between them). Pure, so lib/home.check.ts can hold it still.
import type { TodayWins, Win } from "../api";

export interface Sky { bg: string; ink: string; rune: string }

/** How tall HOME's sky runs under the cap (RightCap draws the cap's share). */
export const HOME_TOP = 195;

// shortcut: the sky's own colours by the hour, not the theme's (it is a window
// onto the time of day, the same in every theme); a light-theme sky when a
// light theme user asks.
const NIGHT: Sky = { bg: "linear-gradient(160deg,#1e2254,#2a1f50 55%,#12132b)", ink: "#a9b1ff", rune: "#c9ceff" };
const SKIES: [number, Sky][] = [
  [5, NIGHT],
  [8, { bg: "linear-gradient(160deg,#31508c,#a8807e 60%,#e0a07c)", ink: "#ffe3c2", rune: "#fff1dc" }],   // dawn
  [17, { bg: "linear-gradient(160deg,#2a4f8f,#35548f 55%,#1b2a4a)", ink: "#cfe0ff", rune: "#e6efff" }],  // day
  [20, { bg: "linear-gradient(160deg,#272a63,#4a2c5e 55%,#6b3d5a)", ink: "#ffc9d8", rune: "#ffe2ea" }],  // dusk
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
