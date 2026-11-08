import type { Meter, MeterWho } from "../api";

/* What the SESSION tab draws, as plain data (meter.check.ts pins it). The numbers
   are bridge/meter.py's; this only places them: the window on a clock whose long
   waits fold, the strip of who was working, the bands under it, the kinds. */

export const ZONE = 150_000;   // bridge/paths.py ZONE_TOKENS: where the smart zone ends
export const FOLD = 1800;      // a wait on you, or time away, longer than this folds
export const BREAK = 20;       // px a fold takes

export interface Mark { a: number; b: number; x0: number; x1: number; who: MeterWho; fold: boolean }

/** Time to x on the hero's clock: linear, except a wait on you (or away) over
 *  FOLD, which takes BREAK px, so one night's wait doesn't flatten the day. */
export function clock(segs: Meter["segs"], width: number): { at: (t: number) => number; marks: Mark[]; end: number } {
  const folds = (s: Meter["segs"][number]) => s[1] - s[0] > FOLD && (s[2] === "you" || s[2] === "away");
  const fixed = segs.filter(folds).length * BREAK;
  const lin = segs.reduce((n, s) => n + (folds(s) ? 0 : s[1] - s[0]), 0);
  const k = lin > 0 ? Math.max(0, width - fixed) / lin : 0;
  let x = 0;
  const marks = segs.map(([a, b, who]) => {
    const fold = folds([a, b, who]);
    const m = { a, b, x0: x, x1: x + (fold ? BREAK : (b - a) * k), who, fold };
    x = m.x1;
    return m;
  });
  const at = (t: number) => {
    if (!marks.length || t <= marks[0].a) return 0;
    for (const m of marks) if (t <= m.b) return m.x0 + (m.b > m.a ? ((t - m.a) / (m.b - m.a)) * (m.x1 - m.x0) : 0);
    return x;
  };
  return { at, marks, end: x };
}

/** The strip as drawn: a slice under a pixel joins the one before it. Drawing
 *  only; TIME sums the seconds, so the totals stay exact. */
export function calm(marks: Mark[]): Mark[] {
  const out: Mark[] = [];
  for (const m of marks) {
    const last = out[out.length - 1];
    if (last && !m.fold && !last.fold && m.x1 - m.x0 < 1) last.x1 = m.x1;
    else out.push({ ...m });
  }
  return out;
}

/** The window as a step line: it only changes when a request goes out. */
export function stepLine(series: Meter["series"], at: (t: number) => number, y: (v: number) => number, endX: number): string {
  if (!series.length) return "";
  let d = `M${at(series[0][0]).toFixed(1)},${y(series[0][1]).toFixed(1)}`;
  for (const [t, v] of series.slice(1)) d += `H${at(t).toFixed(1)}V${y(v).toFixed(1)}`;
  return `${d}H${endX.toFixed(1)}`;
}

export interface Band { from: number; to: number | null; label: string; tone: "done" | "now" | "turn" | "compact" }
type Station = { key: string; label: string; skill: string | null; state: string };

/** The bands under the strip. On a path, the step each turn worked on, from the
 *  turn the path was set in: a turn sent as /mattpocock-skills:x opens x's
 *  station, a /compact gets a sliver, any other turn carries on the step before.
 *  With no path, one band per row (resumes folded, as the rows fold them). */
export function bands(
  turns: { prompt: string; started?: number }[],
  rows: { n: number; started: number | null }[],
  path: { stations: Station[]; at: number } | null,
): Band[] {
  const out: Band[] = [];
  if (!path?.stations.length) {
    rows.forEach((r, i) => { if (r.started != null) out.push({ from: r.started, to: rows[i + 1]?.started ?? null, label: `#${r.n}`, tone: "turn" }); });
    return out;
  }
  const first = turns.reduce((k, t, i) => (t.started != null && t.started <= path.at ? i : k), 0);
  let station: Station | null = null;
  for (const t of turns.slice(first)) {
    if (t.started == null) continue;
    const cmd = /^\/(?:mattpocock-skills:)?([\w-]+)/.exec(t.prompt.trim())?.[1];
    const compact = cmd === "compact";
    const st: Station | null = compact ? null : (cmd && path.stations.find((s) => s.skill === cmd || s.key === cmd)) || station || path.stations[0];
    const label = st ? st.label.toUpperCase() : "";
    const prev = out[out.length - 1];
    if (prev && !compact && prev.tone !== "compact" && prev.label === label) continue;   // the same step carries on
    if (prev) prev.to = t.started;
    out.push({ from: t.started, to: null, label, tone: compact ? "compact" : st!.state === "done" ? "done" : "now" });
    if (st) station = st;
  }
  return out;
}

export const KIND: Record<string, string> = {
  claude: "Claude wrote", startup: "Start-up", commands: "Commands", files: "Files read", skills: "Skills",
  helpers: "Helpers", you: "You", summary: "Summary", web: "Web", search: "Search", mcp: "MCP tools", other: "Other",
};

/** ON WHAT's rows, biggest first: the top `n` kinds, then one "other" holding the
 *  rest and the meter's own "other", so it is always the last row and only one. */
export function kindRows(kinds: Record<string, number>, n = 5): { kind: string; tokens: number; folded: string[] }[] {
  const all = Object.entries(kinds).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const named = all.filter(([k]) => k !== "other");
  const keep = named.length <= n + 1 && !all.some(([k]) => k === "other") ? named : named.slice(0, n);
  const rest = all.filter(([k]) => !keep.some(([q]) => q === k));
  const rows = keep.map(([kind, tokens]) => ({ kind, tokens, folded: [] as string[] }));
  if (rest.length) rows.push({ kind: "other", tokens: rest.reduce((s, [, v]) => s + v, 0), folded: rest.map(([k]) => k) });
  return rows;
}

/** Seconds per who, from the strip (the meter sends them summed; a live turn's
 *  last stretch grows here until the next read). */
export function timeOf(segs: Meter["segs"]): Record<MeterWho, number> {
  const t: Record<MeterWho, number> = { claude: 0, tools: 0, helpers: 0, you: 0, away: 0 };
  for (const [a, b, who] of segs) t[who] += b - a;
  return t;
}

/** The strip run on to now while a turn works: the last stretch grows. */
export function toNow(segs: Meter["segs"], now: number, live: boolean): Meter["segs"] {
  if (!live || !segs.length || now <= segs[segs.length - 1][1]) return segs;
  const last = segs[segs.length - 1];
  return [...segs.slice(0, -1), [last[0], now, last[2]]];
}
