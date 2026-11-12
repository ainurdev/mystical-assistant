import type { Meter, MeterWho } from "../api";
import { flowOf } from "./flowview.ts";

/* What the SESSION tab draws, as plain data (meter.check.ts pins it). The numbers
   are bridge/meter.py's; this only places them: the window on a clock whose long
   waits fold, the strip of who was working, the bands under it, the kinds; the
   flows the session ran, each over its own turns, as FLOWS' track and the curve's
   bands; ON WHAT's sentence and blocks; the helpers under the flow that started them. */

export const ZONE = 150_000;   // bridge/paths.py ZONE_TOKENS: where the smart zone ends
export const FOLD = 1800;      // a wait on you, or time away, longer than this folds
export const BREAK = 20;       // px a fold takes

export interface Mark { a: number; b: number; x0: number; x1: number; who: MeterWho; fold: boolean }

/** Time to x on the hero's clock: linear, except a wait on you (or away) over
 *  FOLD, which takes `brk` px, so one night's wait doesn't flatten the day. */
export function clock(segs: Meter["segs"], width: number, brk = BREAK): { at: (t: number) => number; marks: Mark[]; end: number } {
  const folds = (s: Meter["segs"][number]) => s[1] - s[0] > FOLD && (s[2] === "you" || s[2] === "away");
  const fixed = segs.filter(folds).length * brk;
  const lin = segs.reduce((n, s) => n + (folds(s) ? 0 : s[1] - s[0]), 0);
  const k = lin > 0 ? Math.max(0, width - fixed) / lin : 0;
  let x = 0;
  const marks = segs.map(([a, b, who]) => {
    const fold = folds([a, b, who]);
    const m = { a, b, x0: x, x1: x + (fold ? brk : (b - a) * k), who, fold };
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
    const cmd = /^\/(?:mattpocock-skills:|ponytail:)?([\w-]+)/.exec(t.prompt.trim())?.[1];
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

/** FLOW's numbers, by band label (a step's label, upper case): the seconds
 *  something worked inside its bands (waits on you and away left out), what the
 *  turns that started in them spent, and the first of those turns to jump to. */
export function stepStats(
  bs: Band[], segs: Meter["segs"], turns: { id: string; started?: number }[], spent: Record<string, { spent: number }>,
): Map<string, { secs: number; tokens: number; turn: string | null }> {
  const out = new Map<string, { secs: number; tokens: number; turn: string | null }>();
  for (const b of bs) {
    if (b.tone === "compact" || !b.label) continue;
    const to = b.to ?? Infinity;
    const s = out.get(b.label) ?? { secs: 0, tokens: 0, turn: null };
    s.secs += worked(segs, b.from, to);
    for (const t of turns) {
      if (t.started == null || t.started < b.from || t.started >= to) continue;
      s.tokens += spent[t.id]?.spent ?? 0;
      s.turn ??= t.id;
    }
    out.set(b.label, s);
  }
  return out;
}

/** Seconds something worked (Claude, tools, helpers) between a and b: waits on you and away left out. */
export function worked(segs: Meter["segs"], a: number, b: number): number {
  let s = 0;
  for (const [x, y, who] of segs) if (who !== "you" && who !== "away") s += Math.max(0, Math.min(y, b) - Math.max(x, a));
  return s;
}

type Span = { started: number | null; ended: number | null };

/** Which flow each turn row ran under, as an index into `flows` (oldest first), or -1: the
 *  latest flow begun by the row's end (a flow Claude picks mid-turn owns that turn), unless
 *  it had ended before the row began. Turns before the first flow, or after one ended with
 *  none after it, are outside every flow: only TIME counts them. The bridge keeps `at` and a
 *  turn's length in whole seconds, so a flow begun in a turn's last second (one queued behind
 *  it) isn't that turn's; and only the last row runs on to now, a finished one with no end
 *  known (a teammate's turn) ends where it began. */
export function flowOfRows(flows: { at: number; end?: number | null }[], rows: Span[], now: number): number[] {
  return rows.map((r, j) => {
    if (r.started == null) return -1;
    const end = Math.max(r.started, (r.ended ?? (j === rows.length - 1 ? now : r.started)) - 1);
    const i = flows.reduce((k, f, n) => (f.at <= end ? n : k), -1);
    const over = i >= 0 ? flows[i].end : null;
    return over != null && over < r.started ? -1 : i;
  });
}

export interface FlowSpan { rows: number[]; from: number; to: number; secs: number; tokens: number }

/** Each flow's turn rows, from the first one's start to the next turn's start (the last
 *  one's end, or now while it runs, when none follows), the seconds worked in that span
 *  and what its turns spent. */
export function flowSpans(
  flows: { at: number; end?: number | null }[], rows: (Span & { ids: string[] })[], segs: Meter["segs"],
  spent: Record<string, { spent: number }>, now: number,
): FlowSpan[] {
  const of = flowOfRows(flows, rows, now);
  return flows.map((_, i) => {
    const mine = of.flatMap((k, j) => (k === i ? [j] : []));
    if (!mine.length) return { rows: [], from: 0, to: 0, secs: 0, tokens: 0 };
    const end = mine[mine.length - 1];
    const from = rows[mine[0]].started!, to = rows[end + 1]?.started ?? rows[end].ended ?? now;
    const tokens = mine.reduce((n, j) => n + rows[j].ids.reduce((m, id) => m + (spent[id]?.spent ?? 0), 0), 0);
    return { rows: mine, from, to, secs: worked(segs, from, to), tokens };
  });
}

export interface TrackSeg { key: string; runs: number[]; secs: number }

/** FLOWS' track: a segment per flow, oldest first. ASK, SHIP and each one-skill run fold
 *  into one segment, where their latest run is, its time and spend summed. */
export function trackSegs(flows: { path: string; skill?: string | null; at: number }[], spans: FlowSpan[]): TrackSeg[] {
  const groups = new Map<string, number[]>();
  flows.forEach((f, i) => {
    const id = flowOf(f.path);   // `at` names a flow for good: the key holds when older flows drop off the bridge's list
    const key = id === "ask" || id === "ship" ? id : f.path === "one" ? `one:${f.skill ?? ""}` : `#${f.at}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  return [...groups].map(([key, runs]) => ({ key, runs, secs: runs.reduce((n, i) => n + spans[i].secs, 0) }))
    .sort((a, b) => a.runs[a.runs.length - 1] - b.runs[b.runs.length - 1]);
}

/** Segment widths on a track `w` px wide, 3px between (index.css .sq-track): each at least
 *  18px, the rest shared by worked time (evenly while nothing is timed). shortcut: past about
 *  12 flows that don't fold, a 265px track can't give each its 18px and they share it evenly,
 *  thin; fold older flows into one segment if sessions run that many. */
export function trackWidths(secs: number[], w: number): number[] {
  const MIN = 18, GAP = 3;
  const room = w - GAP * Math.max(0, secs.length - 1);
  const tot = secs.reduce((a, b) => a + b, 0), free = room - secs.length * MIN;
  return secs.map((s) => (free > 0 && tot > 0 ? MIN + free * (s / tot) : room / secs.length));
}

/** Where a flow's steps begin, for the hairlines under the curve: a band whose step differs
 *  from the one before. A /compact's sliver, and the same step carrying on after it, start none. */
export function stepStarts(bs: Band[]): number[] {
  const out: number[] = [];
  let label: string | null = null;
  for (const b of bs) {
    if (b.tone === "compact") continue;
    if (b.label !== label) out.push(b.from);
    label = b.label;
  }
  return out;
}

/** HELPERS opened: each helper under the track segment (an index into `track`) of the flow
 *  whose turn started it, -1 for a turn outside every flow; the newest segment first, -1
 *  last; running helpers first, then by spend. */
export function helperGroups<H extends { turn: string | null; running: boolean; tokens: number }>(
  hs: H[], rows: { ids: string[] }[], spans: FlowSpan[], track: TrackSeg[],
): [number, H[]][] {
  const rowOf = new Map(rows.flatMap((r, j) => r.ids.map((id) => [id, j] as const)));
  const segOf = new Map(track.flatMap((g, k) => g.runs.flatMap((i) => spans[i].rows.map((j) => [j, k] as const))));
  const groups = new Map<number, H[]>();
  for (const h of hs) {
    const j = h.turn ? rowOf.get(h.turn) : undefined;
    const k = j === undefined ? -1 : segOf.get(j) ?? -1;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  return [...groups].sort((a, b) => (a[0] < 0 ? 1 : b[0] < 0 ? -1 : b[0] - a[0]))
    .map(([k, list]) => [k, list.sort((a, b) => Number(b.running) - Number(a.running) || b.tokens - a.tokens)]);
}

/** ON WHAT at a glance: the three biggest kinds named, each with its share of the whole. */
export function mixLine(kinds: Record<string, number>): { kind: string; pct: number }[] {
  const tot = Object.values(kinds).reduce((a, b) => a + Math.max(0, b), 0);
  return Object.entries(kinds).filter(([k, v]) => k !== "other" && v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([kind, v]) => ({ kind, pct: Math.round((v / tot) * 100) }));
}

/** ON WHAT's blocks, biggest first: each slices its share off what's left of the box, the
 *  cut turning each time, and the last takes the rest. */
export function treemap(values: number[], w: number, h: number): { x: number; y: number; w: number; h: number }[] {
  let x = 0, y = 0, left = values.reduce((a, b) => a + b, 0);
  return values.map((v, i) => {
    const last = i === values.length - 1, k = left > 0 ? v / left : 0;
    const box = i % 2 === 0 ? { x, y, w: last ? w : w * k, h } : { x, y, w, h: last ? h : h * k };
    if (i % 2 === 0) { x += box.w; w -= box.w; } else { y += box.h; h -= box.h; }
    left -= v;
    return box;
  });
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
