/* The Rivendell hero's board bar: one segment per board column (`column`, the
   linked task's lane in Rivendell; the backend files a missing one as
   "Backlog"), in the order the tab's tasks first show them. Past MAX segments the
   rest fold into "+N more". Colours follow segment order, never column names.
   Widths are proportional with a floor so a lane of 1 stays legible. */
export type Lane = { key: string; name: string; n: number; flex: number; color: string };

const COLORS = ["var(--txl)", "var(--ok)", "var(--acc)", "var(--purple)", "var(--info, var(--acc))"];
const MAX = 5;

export function boardLanes(tasks: { column: string | null }[]): Lane[] {
  const by = new Map<string, number>();
  for (const t of tasks) { const c = t.column?.trim() || "Backlog"; by.set(c, (by.get(c) ?? 0) + 1); }
  const cols = [...by];
  const shown = cols.length > MAX ? cols.slice(0, MAX - 1) : cols;
  const rest = cols.slice(shown.length);
  const out = shown.map(([name, n]) => ({ key: name, name: name.toUpperCase(), n }));
  if (rest.length) out.push({ key: "+more", name: `+${rest.length} more`, n: rest.reduce((a, [, n]) => a + n, 0) });
  return out.map((l, i) => ({ ...l, flex: Math.max(l.n, 5), color: COLORS[i] }));
}
