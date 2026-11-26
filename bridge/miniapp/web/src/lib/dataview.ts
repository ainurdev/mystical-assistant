// What show_data puts on a turn (bridge/data_views.py is the contract, and it has
// already typed, cleaned and totalled everything), and the arithmetic of drawing it.
// Pure, so dataview.check.ts can run it. The same file is in both apps.

export type Col = { key: string; label: string; type: "text" | "number" | "money" | "percent" | "progress" | "date" | "link"; currency?: string };
export type Row = Record<string, string | number | null>;
export type Card = { title: string; key?: string; assignee?: string; due?: string | null; priority?: string;
  note?: string; tags?: string[]; url?: string | null };
export type BoardCol = { name: string; cards: Card[]; limit?: number | null };
export type Series = { key: string; label: string; dashed?: boolean; dash_from?: number };
export type Pin = { i: number; label: string; note?: string; series?: string; amount?: number };
export type RefLine = { y: number; label: string };
export type Outlook = { series: string; label: string; end: number; low: number; low_x: string };
export type Stat = { label: string; value: number | string; format: string; currency?: string; delta?: number | null; note?: string };
type Head = { type: "data"; title: string; caption?: string; source?: string; as_of?: string; ref?: string };
export type TableEv = Head & { view: "table"; columns: Col[]; rows: Row[]; totals: Record<string, number> };
export type ChartEv = Head & { view: "chart"; kind: "bar" | "bar_horizontal" | "bar_stacked" | "line" | "step" | "area" | "donut" | "burndown";
  x_label?: string; y_label?: string; format: string; currency?: string; series: Series[]; points: Row[]; ideal?: number[];
  /** Whole days, when x is a date and distance along the axis means time. */
  xs?: number[];
  annotations?: Pin[]; lines?: RefLine[]; outlook?: Outlook[] };
export type KanbanEv = Head & { view: "kanban"; columns: BoardCol[]; count: number };
export type StatsEv = Head & { view: "stats"; items: Stat[] };
/** `note` is drawn under the label; `comment` only shows when you hover or tap the step. */
export type FlowNode = { id: string; label: string; note: string; shape: "process" | "decision" | "terminal"; group: string; comment?: string };
/** A box drawn round some steps, named on its top edge; `comment` shows on hover like a step's. */
export type FlowCluster = { id: string; label: string; comment?: string; nodes: string[] };
/** `dashed` and `heads` come from a Mermaid fence (lib/mermaid); show_data sends neither. */
export type FlowEdge = { from: string; to: string; label: string; dashed?: boolean; heads?: "end" | "both" | "none" };
export type FlowEv = Head & { view: "diagram"; kind: "flow"; nodes: FlowNode[]; edges: FlowEdge[]; groups: string[]; direction: "" | "right" | "down";
  /** A bridge older than groups sends none. */
  clusters?: FlowCluster[] };
export type TimelineEv = Head & { view: "diagram"; kind: "timeline"; items: { date: string; label: string; note: string; state: "" | "done" | "now" | "next" }[] };
export type FlowNodeAt = FlowNode & { x: number; y: number; w: number; h: number; lines: string[]; notes: string[] };
export type FlowClusterAt = FlowCluster & { x: number; y: number; w: number; h: number };
export type FlowArrow = { d: string; head: string; tail: string; label: string; lx: number; ly: number; back: boolean; dashed: boolean; from: string; to: string };
export type FlowLayout = { nodes: FlowNodeAt[]; arrows: FlowArrow[]; clusters: FlowClusterAt[]; width: number; height: number };
export type DataEv = TableEv | ChartEv | KanbanEv | StatsEv | FlowEv | TimelineEv;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A value as it reads. `compact` is for an axis: 12.5k, not 12,500.00. */
export function fmt(v: unknown, format = "number", currency = "", compact = false): string {
  if (!isNum(v)) return v === null || v === undefined ? "" : String(v);
  const opts: Intl.NumberFormatOptions = compact ? { notation: "compact", maximumFractionDigits: 1 } : {};
  if (format === "percent") return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, ...opts }).format(v)}%`;
  if (format === "money" && currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, ...opts }).format(v);
    } catch { /* a code this browser doesn't know: as a number */ }
  }
  const money = format === "money" && !compact ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {};
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, ...money, ...opts }).format(v);
}

/** Round axis marks covering [lo, hi]. */
export function ticks(lo: number, hi: number, want = 5): number[] {
  if (lo === hi) { hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1); }
  const raw = (hi - lo) / Math.max(want - 1, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  const first = Math.floor(lo / step + 1e-9) * step;
  for (let t = first, i = 0; i < 40; i++, t = first + i * step) {
    out.push(Number(t.toFixed(10)));
    if (t >= hi - 1e-9) break;
  }
  return out;
}

/** The sheet in this order. Blanks stay last either way. */
export function sorted(rows: Row[], key: string | null, dir: 1 | -1): Row[] {
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    const xb = x === null || x === undefined || x === "", yb = y === null || y === undefined || y === "";
    if (xb || yb) return xb && yb ? 0 : xb ? 1 : -1;
    if (isNum(x) && isNum(y)) return (x - y) * dir;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" }) * dir;
  });
}

export function matches(row: Row, cols: Col[], q: string): boolean {
  const n = q.trim().toLowerCase();
  return !n || cols.some((c) => String(row[c.key] ?? "").toLowerCase().includes(n));
}

export function sumOf(rows: Row[], cols: Col[], known: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cols) {
    if (!(c.key in known)) continue;
    out[c.key] = rows.reduce((t, r) => t + (isNum(r[c.key]) ? (r[c.key] as number) : 0), 0);
  }
  return out;
}

/** Delimited text. A text cell starting like a formula gets a quote mark: this file
 *  opens in a spreadsheet, and the text came from wherever the agent read it. */
export function delimited(cols: Col[], rows: Row[], sep: "," | "\t"): string {
  const cell = (v: unknown, c?: Col) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (typeof v === "string" && c?.type !== "date" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (sep === "\t") return s.replace(/[\t\r\n]+/g, " ");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => cell(c.label)).join(sep), ...rows.map((r) => cols.map((c) => cell(r[c.key], c)).join(sep))].join("\n");
}

export const pinsAt = (ev: ChartEv, i: number): Pin[] => (ev.annotations ?? []).filter((p) => p.i === i);

/** A pin in words: "Salary (+€3,000.00)". */
export function pinText(ev: ChartEv, p: Pin): string {
  if (typeof p.amount !== "number") return p.label;
  return `${p.label} (${p.amount > 0 ? "+" : ""}${fmt(p.amount, ev.format, ev.currency)})`;
}

/** An x as it reads. A date on a time axis says "Nov 15". */
export function xLabel(ev: ChartEv, raw: unknown): string {
  const s = String(raw ?? "");
  if (!ev.xs) return s;
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  const wide = (ev.xs[ev.xs.length - 1] ?? 0) - (ev.xs[0] ?? 0) > 330;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(wide ? { year: "2-digit" } : {}) }).format(d);
}

/** A chart's numbers as a sheet: the table view every chart has. */
export function chartSheet(ev: ChartEv): { columns: Col[]; rows: Row[]; totals: Record<string, number> } {
  const type = ev.format === "money" ? "money" : ev.format === "percent" ? "percent" : "number";
  const series = ev.series.map((s) => ({ key: s.key, label: s.label, type, currency: ev.currency } as Col));
  const columns: Col[] = [{ key: "x", label: ev.x_label || "", type: "text" }, ...series];
  const rows = ev.points.map((p, i) => (ev.ideal ? { ...p, __ideal: ev.ideal[i] } : p));
  if (ev.ideal) columns.push({ key: "__ideal", label: "Ideal", type, currency: ev.currency });
  if (!ev.annotations?.length) return { columns, rows, totals: {} };
  columns.push({ key: "__notes", label: "What happens", type: "text" });
  return { columns, rows: rows.map((r, i) => ({ ...r, __notes: pinsAt(ev, i).map((p) => pinText(ev, p)).join("; ") })), totals: {} };
}

/** Domain of the y axis. Bars and filled areas start from zero, or they lie about size. */
export function domain(ev: ChartEv): [number, number] {
  const vals: number[] = [];
  const keys = ev.series.map((s) => s.key);
  for (const p of ev.points) {
    if (ev.kind === "bar_stacked") {
      let up = 0, down = 0;
      for (const k of keys) { const v = p[k]; if (isNum(v)) { if (v >= 0) up += v; else down += v; } }
      vals.push(up, down);
    } else {
      for (const k of keys) { const v = p[k]; if (isNum(v)) vals.push(v); }
    }
  }
  if (ev.ideal) vals.push(...ev.ideal);
  for (const l of ev.lines ?? []) vals.push(l.y);
  if (!vals.length) return [0, 1];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (ev.kind !== "line") return [Math.min(lo, 0), Math.max(hi, 0)];
  return lo > 0 && lo > hi * 0.5 ? [lo, hi] : [Math.min(lo, 0), Math.max(hi, 0)];
}

const FINISHED = /done|closed|complete|resolved|shipped|merged|cancel/i;

/** Past due, as of when the board was read, in a column that isn't over with. */
export function overdue(due: string | null | undefined, column: string, asOf?: string): boolean {
  if (!due || due.length < 10 || FINISHED.test(column)) return false;
  const today = asOf && /^\d{4}-\d{2}-\d{2}/.test(asOf) ? asOf.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return due < today;
}

// ---- views placed in an answer ------------------------------------------------------

const VIEW_REF = /[ \t]*\[\[view:([\w-]+)\]\][ \t]*/g;

export const stripViews = (md: string) => md.replace(VIEW_REF, "");

/** An answer cut where it names a view. A marker in code is being talked about, so it stays. */
export function splitViews(md: string): (string | { ref: string })[] {
  const out: (string | { ref: string })[] = [];
  const code = [...md.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  let at = 0;
  for (const m of md.matchAll(VIEW_REF)) {
    const i = m.index ?? 0;
    if (code.some(([a, b]) => i >= a && i < b)) continue;
    if (md.slice(at, i).trim()) out.push(md.slice(at, i));
    out.push({ ref: m[1] });
    at = i + m[0].length;
  }
  if (md.slice(at).trim()) out.push(md.slice(at));
  return out.length ? out : [md];
}

export const viewsNamed = (md: string): Set<string> =>
  new Set(splitViews(md).flatMap((p) => (typeof p === "string" ? [] : [p.ref])));

// ---- diagrams -----------------------------------------------------------------------

/** A sheet of any view, for Copy, CSV and Excel. */
export function flatten(ev: DataEv): { columns: Col[]; rows: Row[]; totals: Record<string, number> } {
  const text = (key: string, label: string): Col => ({ key, label, type: "text" });
  if (ev.view === "table") return { columns: ev.columns, rows: ev.rows, totals: ev.totals };
  if (ev.view === "chart") return chartSheet(ev);
  if (ev.view === "kanban") {
    return {
      columns: [text("column", "Column"), text("key", "Key"), text("title", "Title"), text("assignee", "Assignee"),
        { key: "due", label: "Due", type: "date" }, text("priority", "Priority"), text("tags", "Tags"), text("note", "Note"),
        { key: "url", label: "Link", type: "link" }],
      rows: ev.columns.flatMap((c) => c.cards.map((k) => ({ column: c.name, key: k.key ?? "", title: k.title, assignee: k.assignee ?? "",
        due: k.due ?? null, priority: k.priority ?? "", tags: (k.tags ?? []).join(", "), note: k.note ?? "", url: k.url ?? null }))),
      totals: {},
    };
  }
  if (ev.view === "stats") {
    return {
      columns: [text("label", "Figure"), text("value", "Value"), { key: "delta", label: "Change", type: "number" }, text("note", "Note")],
      rows: ev.items.map((s) => ({ label: s.label, value: s.format === "text" ? String(s.value) : fmt(s.value, s.format, s.currency), delta: s.delta ?? null, note: s.note ?? "" })),
      totals: {},
    };
  }
  if (ev.kind === "timeline") {
    return { columns: [text("date", "Date"), text("label", "Event"), text("state", "State"), text("note", "Note")],
      rows: ev.items.map((i) => ({ ...i })), totals: {} };
  }
  const name = new Map(ev.nodes.map((n) => [n.id, n.label]));
  return { columns: [text("from", "From"), text("label", "Label"), text("to", "To")],
    rows: ev.edges.map((e) => ({ from: name.get(e.from) ?? e.from, label: e.label, to: name.get(e.to) ?? e.to })), totals: {} };
}

export function wrap(text: string, chars: number, most: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = word.length > chars ? `${word.slice(0, chars - 1)}…` : word;
    if (line && line.length + 1 + w.length > chars) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  if (out.length > most) { out.length = most; out[most - 1] = `${out[most - 1].slice(0, chars - 1)}…`; }
  return out;
}

const NODE_W = 176, LINE = 15, NOTE_LINE = 13;
/** Space across a rank: between two steps, beside a wire passing through, outside a group's box. */
const GAP = 22, WIRE_GAP = 12, BOX_GAP = 14;
/** A group's box: its padding, and the top edge, where its name sits. */
const BOX_PAD = 12, BOX_HEAD = 26;
/** Between two wires' tracks in a channel, and between two wires on one side of a step. */
const PITCH = 8, PORT = 14;
/** The run before a wire's first bend, the run after its last (room for the head), a self-loop's reach. */
const LEAD = 10, TAIL = 16, LOOP = 18;

type Item = {
  key: string; rank: number; cluster: string; node?: string; wire: boolean;
  size: number; thick: number; pos: number; order: number;
};

/** Lay out a flow like a circuit board: ranks by longest path with back edges turned round,
 *  a waypoint in every rank a long arrow passes (so it runs in a lane of its own, never through
 *  a step), order within a rank by barycentre sweeps with the fewest crossings kept, positions
 *  across by weighted isotonic regression so a wire's waypoints line up. Then every arrow gets
 *  its own port on a step's side and its own track in each channel between ranks, ordered so a
 *  wire's riser doesn't cross another's track where that can be helped, and bends only at right
 *  angles. A group (ev.clusters) stays together in each rank and in the same order across them,
 *  and what isn't in it is pushed outside its box.
 *  Small and readable beats a full graph layout here: the schema caps a flow at 60 steps.
 *  ponytail: groups don't nest, and a step is in one group at most. */
export function layoutFlow(ev: FlowEv, dir: "right" | "down"): FlowLayout {
  const across = dir === "right";
  const ids = ev.nodes.map((n) => n.id);
  const state = new Map<string, number>();
  const back = new Set<FlowEdge>();
  const out = new Map<string, FlowEdge[]>(ids.map((i) => [i, []]));
  for (const e of ev.edges) out.get(e.from)?.push(e);
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of out.get(id) ?? []) {
      const s = state.get(e.to);
      if (s === 1) back.add(e);
      else if (!s) visit(e.to);
    }
    state.set(id, 2);
  };
  ids.forEach((i) => { if (!state.get(i)) visit(i); });
  // Drawn top to bottom (or left to right): a way back is laid out as a way forward, then turned round.
  const links = ev.edges.filter((e) => e.from !== e.to && out.has(e.from) && out.has(e.to))
    .map((e) => (back.has(e) ? { e, u: e.to, v: e.from, flip: true } : { e, u: e.from, v: e.to, flip: false }));

  const rank = new Map<string, number>(ids.map((i) => [i, 0]));
  for (let pass = 0; pass <= ids.length; pass++) {
    let moved = false;
    for (const l of links) {
      const want = rank.get(l.u)! + 1;
      if (rank.get(l.v)! < want) { rank.set(l.v, want); moved = true; }
    }
    if (!moved) break;
  }
  // A step nothing leads to sits just above the first step it feeds, not at the very top:
  // its wire is then one rank long instead of crossing the whole board.
  for (const id of ids) {
    if (links.some((l) => l.v === id)) continue;
    const next = links.filter((l) => l.u === id).map((l) => rank.get(l.v)!);
    if (next.length) rank.set(id, Math.min(...next) - 1);
  }
  const lowest = Math.min(...rank.values());
  for (const id of ids) rank.set(id, rank.get(id)! - lowest);
  const depth = Math.max(...rank.values()) + 1;

  const clusterOf = new Map<string, string>();
  for (const c of ev.clusters ?? []) for (const n of c.nodes) if (rank.has(n) && !clusterOf.has(n)) clusterOf.set(n, c.id);
  const clusters = (ev.clusters ?? []).filter((c) => c.nodes.some((n) => clusterOf.get(n) === c.id));

  const shapes = new Map(ev.nodes.map((n) => {
    const chars = n.shape === "decision" ? 20 : 24;
    const lines = wrap(n.label, chars, 3), notes = n.note ? wrap(n.note, chars + 3, 2) : [];
    return [n.id, { n, lines, notes, h: Math.max(44, 18 + lines.length * LINE + notes.length * NOTE_LINE) }];
  }));
  const rows: Item[][] = Array.from({ length: depth }, () => []);
  const items = new Map<string, Item>();
  const add = (it: Omit<Item, "pos" | "order">) => {
    const full = { ...it, pos: 0, order: rows[it.rank].length };
    rows[it.rank].push(full); items.set(it.key, full);
    return full;
  };
  for (const id of ids) {
    const h = shapes.get(id)!.h;
    add({ key: id, node: id, rank: rank.get(id)!, cluster: clusterOf.get(id) ?? "", wire: false,
      size: across ? h : NODE_W, thick: across ? NODE_W : h });
  }
  const chains = links.map((l, i) => {
    const a = clusterOf.get(l.u) ?? "", cl = a && a === clusterOf.get(l.v) ? a : "";
    const chain = [items.get(l.u)!];
    for (let r = rank.get(l.u)! + 1; r < rank.get(l.v)!; r++) chain.push(add({ key: `~${i}:${r}`, rank: r, cluster: cl, wire: true, size: 0, thick: 0 }));
    chain.push(items.get(l.v)!);
    return chain;
  });
  // A group spanning ranks keeps a place in the ranks between where none of its steps are, so
  // nothing else is laid out where its box will be.
  const span = new Map<string, [number, number]>();
  for (const c of clusters) {
    const rs = c.nodes.filter((n) => clusterOf.get(n) === c.id).map((n) => rank.get(n)!);
    const lo = Math.min(...rs), hi = Math.max(...rs);
    span.set(c.id, [lo, hi]);
    for (let r = lo; r <= hi; r++) {
      if (!rows[r].some((it) => it.cluster === c.id)) add({ key: `#${c.id}:${r}`, rank: r, cluster: c.id, wire: true, size: 0, thick: 0 });
    }
  }
  const ups = new Map<Item, [Item, number][]>(), downs = new Map<Item, [Item, number][]>();
  for (const chain of chains) {
    for (let k = 0; k + 1 < chain.length; k++) {
      const a = chain[k], b = chain[k + 1];
      // A long wire's waypoints pull hardest on each other, so it runs straight.
      const w = [1, 2, 8][(a.wire ? 1 : 0) + (b.wire ? 1 : 0)];
      (downs.get(a) ?? downs.set(a, []).get(a)!).push([b, w]);
      (ups.get(b) ?? ups.set(b, []).get(b)!).push([a, w]);
    }
  }

  // ---- order within each rank
  const where = (r: Item[]) => r.forEach((it, i) => { it.order = i; });
  const placeOf = (c: string) => {
    const its = [...items.values()].filter((it) => it.cluster === c);
    return its.reduce((t, it) => t + it.order / Math.max(rows[it.rank].length - 1, 1), 0) / its.length;
  };
  const sortRow = (r: Item[], near: Map<Item, [Item, number][]>) => {
    const score = new Map(r.map((it): [Item, number] => {
      const ns = near.get(it) ?? [];
      return [it, ns.length ? ns.reduce((t, [n]) => t + n.order, 0) / ns.length : it.order];
    }));
    const mean = new Map<string, number>();
    for (const c of new Set(r.map((it) => it.cluster).filter(Boolean))) {
      const its = r.filter((it) => it.cluster === c);
      mean.set(c, its.reduce((t, it) => t + score.get(it)!, 0) / its.length);
    }
    const key = (it: Item) => (it.cluster ? mean.get(it.cluster)! : score.get(it)!);
    const block = (it: Item) => (it.cluster ? `c${it.cluster}` : `i${it.key}`);
    r.sort((a, b) => key(a) - key(b) || (block(a) < block(b) ? -1 : block(a) > block(b) ? 1 : 0) || score.get(a)! - score.get(b)!);
    inOrder(r, new Map([...mean.keys()].map((c) => [c, placeOf(c)])));
  };
  /** Groups keep one order across ranks, or their boxes would overlap. */
  const inOrder = (r: Item[], g: Map<string, number>) => {
    const blocks: Item[][] = [];
    for (const it of r) {
      const last = blocks[blocks.length - 1];
      if (last && it.cluster && last[0].cluster === it.cluster) last.push(it); else blocks.push([it]);
    }
    const slots = blocks.flatMap((b, i) => (b[0].cluster ? [i] : []));
    const nth = (b: Item[]) => clusters.findIndex((c) => c.id === b[0].cluster);   // a tie still sorts one way everywhere
    const sortedBlocks = slots.map((i) => blocks[i]).sort((a, b) => g.get(a[0].cluster)! - g.get(b[0].cluster)! || nth(a) - nth(b));
    slots.forEach((i, k) => { blocks[i] = sortedBlocks[k]; });
    r.splice(0, r.length, ...blocks.flat());
    where(r);
  };
  const crossings = () => {
    let n = 0;
    for (let r = 0; r + 1 < depth; r++) {
      const segs = rows[r].flatMap((a) => (downs.get(a) ?? []).map(([b]) => [a.order, b.order]));
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) n++;
      }
    }
    return n;
  };
  let best = Infinity, kept = new Map<Item, number>();
  for (let sweep = 0; sweep < 12; sweep++) {
    if (sweep % 2 === 0) for (let r = 1; r < depth; r++) sortRow(rows[r], ups);
    else for (let r = depth - 2; r >= 0; r--) sortRow(rows[r], downs);
    if (sweep === 0) sortRow(rows[0], downs);
    const n = crossings();
    if (n < best) { best = n; kept = new Map([...items.values()].map((it) => [it, it.order])); }
  }
  for (const r of rows) { r.sort((a, b) => kept.get(a)! - kept.get(b)!); where(r); }
  // The sweeps sorted rows at different moments, so settle one order of groups for every rank.
  const settled = new Map(clusters.map((c) => [c.id, placeOf(c.id)]));
  for (const r of rows) inOrder(r, settled);

  // ---- positions across each rank
  const loops = new Set(ev.edges.filter((e) => e.from === e.to).map((e) => e.from));
  const extra = new Map<string, number>();
  const gap = (a: Item, b: Item) => Math.max(
    (a.wire || b.wire ? WIRE_GAP : GAP) + (a.node && loops.has(a.node) ? LOOP + 6 : 0),
    extra.get(`${a.key}|${b.key}`) ?? 0);
  const centre = (it: Item) => it.pos + it.size / 2;
  const clusterMid = (c: string) => {
    const its = [...items.values()].filter((it) => it.cluster === c && (it.node || !it.key.startsWith("#")));
    return its.reduce((t, it) => t + centre(it), 0) / its.length;
  };
  /** Weighted isotonic regression (pool adjacent violators): each item as near its wish as the gaps allow. */
  const place = (r: Item[], wish: (it: Item) => [number, number]) => {
    const offs: number[] = [];
    let acc = 0;
    r.forEach((it, i) => { offs.push(acc); acc += it.size + (i + 1 < r.length ? gap(it, r[i + 1]) : 0); });
    const pools: { v: number; w: number; n: number }[] = [];
    r.forEach((it, i) => {
      const [c, w] = wish(it);
      pools.push({ v: c - it.size / 2 - offs[i], w: Math.max(w, 0.01), n: 1 });
      while (pools.length > 1 && pools[pools.length - 2].v > pools[pools.length - 1].v) {
        const b = pools.pop()!, a = pools[pools.length - 1];
        a.v = (a.v * a.w + b.v * b.w) / (a.w + b.w); a.w += b.w; a.n += b.n;
      }
    });
    let i = 0;
    for (const p of pools) for (let k = 0; k < p.n; k++, i++) r[i].pos = p.v + offs[i];
  };
  // A long wire's waypoints all want one lane, the mean of where they are: it then runs
  // straight down its lane and bends only near its ends, not a step in every rank.
  const chainOf = new Map<Item, Item[]>();
  for (const chain of chains) { const mid = chain.slice(1, -1); for (const it of mid) chainOf.set(it, mid); }
  const wish = (it: Item): [number, number] => {
    if (!it.node && it.key.startsWith("#")) return [clusterMid(it.cluster), 0.5];
    const lane = chainOf.get(it);
    if (lane && lane.length > 1) {
      const ends = [...(ups.get(lane[0]) ?? []), ...(downs.get(lane[lane.length - 1]) ?? [])].map(([n]) => centre(n));
      const all = [...lane.map(centre), ...ends];
      return [all.reduce((t, x) => t + x, 0) / all.length, 20];
    }
    const ns = [...(ups.get(it) ?? []), ...(downs.get(it) ?? [])];
    // A group's steps also pull toward the group's middle, so its box stays narrow.
    if (it.cluster) ns.push([{ pos: clusterMid(it.cluster), size: 0 } as Item, 3]);
    const w = ns.reduce((t, [, x]) => t + x, 0);
    return w ? [ns.reduce((t, [n, x]) => t + centre(n) * x, 0) / w, w] : [centre(it), 0.05];
  };
  for (const r of rows) place(r, (it) => [it.order * (NODE_W + GAP), 1]);
  const relax = (times: number) => {
    for (let i = 0; i < times; i++) {
      const order = i % 2 ? [...rows].reverse() : rows;
      for (const r of order) place(r, wish);
    }
  };
  const pad = { c0: across ? BOX_HEAD : BOX_PAD, c1: BOX_PAD, a0: across ? BOX_PAD : BOX_HEAD, a1: BOX_PAD };
  const boxAcross = new Map<string, [number, number]>();
  const measure = () => {
    for (const c of clusters) {
      const its = [...items.values()].filter((it) => it.cluster === c.id);
      boxAcross.set(c.id, [Math.min(...its.map((it) => it.pos)) - pad.c0, Math.max(...its.map((it) => it.pos + it.size)) + pad.c1]);
    }
  };
  relax(16);
  for (let round = 0; round < (clusters.length ? 12 : 0); round++) {
    measure();
    let grew = false;
    for (const r of rows) {
      for (let i = 0; i + 1 < r.length; i++) {
        const a = r[i], b = r[i + 1];
        if (a.cluster === b.cluster) continue;
        const need = BOX_GAP + (a.cluster ? boxAcross.get(a.cluster)![1] - (a.pos + a.size) : 0)
          + (b.cluster ? b.pos - boxAcross.get(b.cluster)![0] : 0);
        const k = `${a.key}|${b.key}`;
        if (need > (extra.get(k) ?? 0) + 0.5) { extra.set(k, need); grew = true; }
      }
    }
    if (!grew) break;
    relax(10);
  }
  // Whatever the sweeps left, push right until every gap holds against the boxes as they are.
  // A box's edge moves by moving its group in every rank. Positions only grow and groups keep
  // one order across ranks, so this ends; the cap is for safety.
  const shove = (r: Item[], from: number, by: number) => { for (let j = from; j < r.length; j++) r[j].pos += by; };
  for (let round = 0; round < (clusters.length ? 200 : 0); round++) {
    measure();
    let pushed = false;
    for (const r of rows) {
      for (let i = 0; i + 1 < r.length && !pushed; i++) {
        const a = r[i], b = r[i + 1];
        const plain = a.pos + a.size + gap(a, b) - b.pos;
        if (a.cluster === b.cluster || (!a.cluster && !b.cluster)) {
          if (plain > 0.01) { shove(r, i + 1, plain); pushed = true; }
          continue;
        }
        const leftEdge = a.cluster ? boxAcross.get(a.cluster)![1] : a.pos + a.size;
        if (b.cluster) {
          const short = leftEdge + BOX_GAP - boxAcross.get(b.cluster)![0];
          if (short > 0.01) {     // move group b right, in every rank it has a place in
            for (const rr of rows) { const k = rr.findIndex((it) => it.cluster === b.cluster); if (k >= 0) shove(rr, k, short); }
            pushed = true;
          }
        } else {
          const short = Math.max(leftEdge + BOX_GAP - b.pos, plain);
          if (short > 0.01) { shove(r, i + 1, short); pushed = true; }
        }
      }
      if (pushed) break;
    }
    if (!pushed) break;
  }
  measure();

  // ---- ports: each wire its own place on a step's side, in the order of where it goes
  const outPort = new Map<string, number>(), inPort = new Map<string, number>();  // key: chain index:k
  const side = (it: Item) => {
    const n = it.node ? shapes.get(it.node)!.n : null;
    const m = it.wire ? 0 : n?.shape === "decision" && !across ? 18 : n?.shape === "terminal" && across ? 12 : 10;
    return [it.pos + m, it.pos + it.size - m];
  };
  const segsOut = new Map<Item, [string, Item][]>(), segsIn = new Map<Item, [string, Item][]>();
  chains.forEach((chain, i) => {
    for (let k = 0; k + 1 < chain.length; k++) {
      (segsOut.get(chain[k]) ?? segsOut.set(chain[k], []).get(chain[k])!).push([`${i}:${k}`, chain[k + 1]]);
      (segsIn.get(chain[k + 1]) ?? segsIn.set(chain[k + 1], []).get(chain[k + 1])!).push([`${i}:${k}`, chain[k]]);
    }
  });
  const spread = (it: Item, segs: [string, Item][], into: Map<string, number>) => {
    segs.sort((a, b) => centre(a[1]) - centre(b[1]));
    const [lo, hi] = side(it), k = segs.length;
    const pitch = k > 1 ? Math.min(PORT, (hi - lo) / (k - 1)) : 0;
    segs.forEach(([s], i) => into.set(s, centre(it) + (i - (k - 1) / 2) * pitch));
  };
  for (const it of items.values()) {
    if (segsOut.has(it)) spread(it, segsOut.get(it)!, outPort);
    if (segsIn.has(it)) spread(it, segsIn.get(it)!, inPort);
  }
  // A wire alone on both its ends goes straight when the two sides overlap: no jog.
  chains.forEach((chain, i) => {
    for (let k = 0; k + 1 < chain.length; k++) {
      const a = chain[k], b = chain[k + 1], s = `${i}:${k}`;
      if (segsOut.get(a)!.length !== 1 || segsIn.get(b)!.length !== 1) continue;
      const [alo, ahi] = side(a), [blo, bhi] = side(b);
      const lo = Math.max(alo, blo), hi = Math.min(ahi, bhi);
      if (lo > hi) continue;
      const x = Math.min(hi, Math.max(lo, (outPort.get(s)! + inPort.get(s)!) / 2));
      outPort.set(s, x); inPort.set(s, x);
    }
  });

  // ---- channels: a track per wire that has to move across, labels just past where they leave
  const thick = rows.map((r) => Math.max(0, ...r.map((it) => it.thick)));
  const starts = (r: number) => clusters.some((c) => span.get(c.id)![0] === r);
  const ends = (r: number) => clusters.some((c) => span.get(c.id)![1] === r);
  const textW = (s: string) => s.length * 6.4 + 10;
  type Seg = { s: string; x1: number; x2: number; track: number };
  const trackOf = new Map<string, number>();     // segment -> along
  const labelAt = new Map<number, [number, number]>(); // chain -> [across, along]
  const bandStart: number[] = [];
  let along = starts(0) ? pad.a0 : 0;
  for (let r = 0; r < depth; r++) {
    bandStart.push(along);
    along += thick[r];
    if (r + 1 === depth) break;
    const segs: Seg[] = [];
    chains.forEach((chain, i) => {
      for (let k = 0; k + 1 < chain.length; k++) {
        if (chain[k].rank !== r) continue;
        const s = `${i}:${k}`, x1 = outPort.get(s)!, x2 = inPort.get(s)!;
        if (Math.abs(x1 - x2) >= 1.5) segs.push({ s, x1, x2, track: -1 });
      }
    });
    const lo = (g: Seg) => Math.min(g.x1, g.x2) - 2, hi = (g: Seg) => Math.max(g.x1, g.x2) + 2;
    const overlap = (a: Seg, b: Seg) => lo(a) <= hi(b) && lo(b) <= hi(a);
    const within = (x: number, g: Seg) => x >= lo(g) && x <= hi(g);
    // a above b when a's riser would cross b's track if b were higher, and below when its drop would.
    const above = new Map<Seg, Set<Seg>>(segs.map((g) => [g, new Set()]));
    for (const a of segs) for (const b of segs) {
      if (a === b || !overlap(a, b)) continue;
      if (within(a.x1, b)) above.get(b)!.add(a);     // a before b
      if (within(a.x2, b)) above.get(a)!.add(b);     // b before a
    }
    const done = new Set<Seg>();
    while (done.size < segs.length) {
      const left = segs.filter((g) => !done.has(g));
      const free = left.filter((g) => [...above.get(g)!].every((p) => done.has(p)));
      // A cycle can't be helped: take the one with the fewest left to wait for, and the leftmost.
      const g = (free.length ? free : [...left].sort((a, b) =>
        [...above.get(a)!].filter((p) => !done.has(p)).length - [...above.get(b)!].filter((p) => !done.has(p)).length))[0];
      const floor = Math.max(-1, ...[...above.get(g)!].filter((p) => done.has(p)).map((p) => p.track)) + 1;
      const taken = new Set(segs.filter((o) => done.has(o) && overlap(o, g)).map((o) => o.track));
      let t = floor;
      while (taken.has(t)) t++;
      g.track = t;
      done.add(g);
    }
    const tracks = segs.length ? Math.max(...segs.map((g) => g.track)) + 1 : 0;
    // labels, in lanes so none sits on another
    const labelled = chains.flatMap((chain, i) => (chain[0].rank === r && links[i].e.label ? [i] : []))
      .map((i) => ({ i, x: outPort.get(`${i}:0`)!, c: across ? 15 : textW(links[i].e.label), a: across ? textW(links[i].e.label) : 16 }))
      .sort((p, q) => p.x - q.x);
    const lanes: { end: number; size: number; items: typeof labelled }[] = [];
    for (const l of labelled) {
      const lane = lanes.find((ln) => l.x - l.c / 2 >= ln.end + 4);
      if (lane) { lane.end = l.x + l.c / 2; lane.size = Math.max(lane.size, l.a); lane.items.push(l); }
      else lanes.push({ end: l.x + l.c / 2, size: l.a, items: [l] });
    }
    let at = along + (ends(r) ? pad.a1 + 4 : 0) + (lanes.length ? 4 : 0);
    for (const ln of lanes) { for (const l of ln.items) labelAt.set(l.i, [l.x, at + ln.size / 2]); at += ln.size + 2; }
    at += LEAD;
    for (const g of segs) trackOf.set(g.s, at + g.track * PITCH);
    at += Math.max(tracks - 1, 0) * PITCH + TAIL + (starts(r + 1) ? pad.a0 + 4 : 0);
    along = Math.max(at, along + (across ? 40 : 30));
  }
  // A step sits in the middle of its rank; a wire passing through runs the rank's whole depth.
  const top = (it: Item) => bandStart[it.rank] + (it.wire ? 0 : (thick[it.rank] - it.thick) / 2);

  // ---- everything in (across, along); turned the right way round at the end
  type Pt = [number, number];
  const arrowsAt: { e: FlowEdge; pts: Pt[]; label?: Pt; back: boolean }[] = [];
  chains.forEach((chain, i) => {
    const pts: Pt[] = [];
    const first = chain[0];
    let x = outPort.get(`${i}:0`)!;
    pts.push([x, top(first) + first.thick]);
    for (let k = 0; k + 1 < chain.length; k++) {
      const s = `${i}:${k}`, b = chain[k + 1];
      // Less than a pixel and a half apart draws straight on, rather than as a jog nobody can see.
      if (trackOf.has(s)) { x = inPort.get(s)!; pts.push([outPort.get(s)!, trackOf.get(s)!], [x, trackOf.get(s)!]); }
      pts.push([x, top(b)]);
      if (b.wire) pts.push([x, top(b) + thick[b.rank]]);
    }
    const clean = pts.filter((p, j) => j === 0 || j === pts.length - 1 || !((p[0] === pts[j - 1][0] && p[0] === pts[j + 1][0]) || (p[1] === pts[j - 1][1] && p[1] === pts[j + 1][1])));
    arrowsAt.push({ e: links[i].e, pts: links[i].flip ? clean.reverse() : clean, label: labelAt.get(i), back: links[i].flip });
  });
  for (const e of ev.edges.filter((x) => x.from === x.to)) {
    const it = items.get(e.from)!, a0 = top(it), c1 = it.pos + it.size;
    arrowsAt.push({ e, back: true, pts: [[c1, a0 + it.thick * 0.3], [c1 + LOOP, a0 + it.thick * 0.3], [c1 + LOOP, a0 + it.thick * 0.7], [c1, a0 + it.thick * 0.7]],
      label: e.label ? (across ? [c1 + LOOP + 10, a0 + it.thick / 2] : [c1 + LOOP + textW(e.label) / 2 + 2, a0 + it.thick / 2]) : undefined });
  }
  const boxesAt = clusters.map((c) => {
    const [lo, hi] = span.get(c.id)!, [c0, c1] = boxAcross.get(c.id)!;
    return { c, c0, c1, a0: bandStart[lo] - pad.a0, a1: bandStart[hi] + thick[hi] + pad.a1 };
  });

  // shift so the top-left of everything sits at the margin
  const margin = 8;
  const cs: number[] = [], as: number[] = [];
  for (const it of items.values()) if (it.node) { cs.push(it.pos, it.pos + it.size); as.push(top(it), top(it) + it.thick); }
  for (const b of boxesAt) { cs.push(b.c0, b.c1); as.push(b.a0, b.a1); }
  for (const a of arrowsAt) {
    for (const p of a.pts) { cs.push(p[0]); as.push(p[1]); }
    if (a.label) {
      const w = textW(a.e.label) / 2;
      cs.push(a.label[0] - (across ? 8 : w), a.label[0] + (across ? 8 : w)); as.push(a.label[1] - (across ? w : 8), a.label[1] + (across ? w : 8));
    }
  }
  const dc = margin - Math.min(...cs), da = margin - Math.min(...as);
  const xy = (c: number, a: number): Pt => (across ? [a + da, c + dc] : [c + dc, a + da]);
  const r1 = (v: number) => Math.round(v * 10) / 10;

  const nodes: FlowNodeAt[] = ids.map((id) => {
    const it = items.get(id)!, s = shapes.get(id)!;
    const [x, y] = xy(it.pos, top(it));
    return { ...s.n, lines: s.lines, notes: s.notes, w: NODE_W, h: s.h, x: r1(x), y: r1(y) };
  });
  const arrows: FlowArrow[] = arrowsAt.map(({ e, pts, label, back: isBack }) => {
    const p = pts.map(([c, a]) => xy(c, a));
    const heads = e.heads ?? "end";
    const tipAt = (q: Pt[], j: number, k: number) => {   // the head at q[j], pointing from q[k]
      const dx = q[j][0] - q[k][0], dy = q[j][1] - q[k][1], n = Math.hypot(dx, dy) || 1;
      return { head: arrowHead(q[j][0], q[j][1], dx / n, dy / n), back: [q[j][0] - (dx / n) * 7, q[j][1] - (dy / n) * 7] as Pt };
    };
    const line = p.map((q) => [...q] as Pt);
    let head = "", tail = "";
    if (heads !== "none") { const t = tipAt(p, p.length - 1, p.length - 2); head = t.head; line[line.length - 1] = t.back; }
    if (heads === "both") { const t = tipAt(p, 0, 1); tail = t.head; line[0] = t.back; }
    const [lx, ly] = label ? xy(label[0], label[1]) : [0, 0];
    return { d: wirePath(line), head, tail, label: e.label, lx: r1(lx), ly: r1(ly), back: isBack, dashed: !!e.dashed, from: e.from, to: e.to };
  });
  const boxes: FlowClusterAt[] = boxesAt.map(({ c, c0, c1, a0, a1 }) => {
    const [x0, y0] = xy(c0, a0), [x1, y1] = xy(c1, a1);
    return { ...c, x: r1(Math.min(x0, x1)), y: r1(Math.min(y0, y1)), w: r1(Math.abs(x1 - x0)), h: r1(Math.abs(y1 - y0)) };
  });
  const [W, H] = xy(Math.max(...cs), Math.max(...as));
  return { nodes, arrows, clusters: boxes, width: Math.ceil(W + margin), height: Math.ceil(H + margin) };
}

/** A wire through `pts`, its corners cut at 45° like a trace on a board. */
function wirePath(pts: [number, number][], cut = 6): string {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  let d = `M${r1(pts[0][0])},${r1(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y);
    if (!l1 || !l2) continue;
    const k = Math.min(cut, l1 / 2, l2 / 2);
    d += `L${r1(x - ((x - px) / l1) * k)},${r1(y - ((y - py) / l1) * k)}L${r1(x + ((nx - x) / l2) * k)},${r1(y + ((ny - y) / l2) * k)}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${r1(last[0])},${r1(last[1])}`;
}

function arrowHead(x: number, y: number, dx: number, dy: number): string {
  const n = Math.hypot(dx, dy) || 1, ux = dx / n, uy = dy / n;
  const bx = x - ux * 8, by = y - uy * 8;
  return `M${x},${y}L${bx - uy * 4.5},${by + ux * 4.5}L${bx + uy * 4.5},${by - ux * 4.5}Z`;
}

/** The outline of a step: a box, a pill for where it starts or ends, a hexagon for a decision. */
export function nodePath(n: { x: number; y: number; w: number; h: number; shape: string }): string {
  const { x, y, w, h } = n;
  if (n.shape === "decision") {
    const i = 12;
    return `M${x + i},${y}H${x + w - i}L${x + w},${y + h / 2}L${x + w - i},${y + h}H${x + i}L${x},${y + h / 2}Z`;
  }
  const r = n.shape === "terminal" ? h / 2 : 6;
  return `M${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}V${y + r}Q${x},${y} ${x + r},${y}Z`;
}
