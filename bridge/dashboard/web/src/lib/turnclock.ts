/* The Turns hero's geometry: each turn a block where it ran on one time strip.
   Times are seconds. x and w are 0-1 fractions of the strip; the 4px floor that keeps
   a short turn visible is CSS (.tc-blk-w min-width), so it holds at any rail width. */
export interface ClockTurn { started: number; secs: number; asks: number; running: boolean }

const pad = (n: number) => String(n).padStart(2, "0");

export function turnClock(turns: ClockTurn[], now: number) {
  if (!turns.length) return { from: now, to: now, ticks: [] as { at: number; label: string }[], blocks: [] as { x: number; w: number; n: number; asks: number; running: boolean }[] };
  const from = Math.min(...turns.map((t) => t.started));
  const to = Math.max(now, ...turns.map((t) => t.started + t.secs));
  const span = Math.max(to - from, 60);
  const blocks = turns.map((t, i) => {
    const w = t.secs / span;
    return { x: Math.min((t.started - from) / span, 1 - w), w, n: i + 1, asks: t.asks, running: t.running };
  });
  // Whole local hours, or whole local days past 36h; thinned so the labels never crowd.
  const days = span > 36 * 3600;
  const ticks: { at: number; label: string }[] = [];
  const d = new Date(from * 1000);
  if (days) d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0);
  for (let t = new Date(d); t.getTime() / 1000 <= to; days ? t.setDate(t.getDate() + 1) : t.setHours(t.getHours() + 1)) {
    const s = t.getTime() / 1000;
    if (s >= from) ticks.push({ at: s, label: days ? t.toLocaleDateString([], { weekday: "short", day: "numeric" }) : `${pad(t.getHours())}:00` });
  }
  const step = Math.ceil(ticks.length / 5);
  return { from, to, ticks: step > 1 ? ticks.filter((_, i) => i % step === 0) : ticks, blocks };
}
