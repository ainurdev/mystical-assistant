/* STYLE WITH AI's answer as the page reads it (bridge/logostyle.py): the line
   still being written, for what it already says, and what a run changed, for
   the strip. Pure, for the check. */

export interface PartialAnswer { p?: string; pick?: string; bg?: string; color?: string; why?: string }

/** What a half-written answer line already says: {"p":"P3","pick":"c2","why":"its own app ic */
export function partialAnswer(text: string): PartialAnswer {
  const out: PartialAnswer = {};
  for (const k of ["p", "pick", "bg", "color", "why"] as const) {
    const m = text.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    if (m) out[k] = m[1].replace(/\\(.)/g, "$1");
  }
  return out;
}

export interface StyleCounts { logos: number; icons: number; backgrounds: number; colours: number; kept: number; changed: number }

/** What a run's answers did: new logos, new icons, backgrounds, colours, and how many were already right. */
export function styleCounts(items: { how: string[] }[]): StyleCounts {
  const n = (f: (h: string[]) => boolean) => items.filter((i) => f(i.how)).length;
  return {
    logos: n((h) => h[0] === "logo"), icons: n((h) => h[0] === "icon"), backgrounds: n((h) => h.includes("background")),
    colours: n((h) => h.includes("colour")), kept: n((h) => h.length === 0), changed: n((h) => h.length > 0),
  };
}
