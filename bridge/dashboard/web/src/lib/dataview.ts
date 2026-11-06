// What show_data puts on a turn (bridge/data_views.py is the contract, and it has
// already typed, cleaned and totalled everything), and the arithmetic of drawing it.
// Pure, so dataview.check.ts can run it. The same file is in both apps.

export type Col = { key: string; label: string; type: "text" | "number" | "money" | "percent" | "progress" | "date" | "link"; currency?: string };
export type Row = Record<string, string | number | null>;
export type Card = { title: string; key?: string; assignee?: string; due?: string | null; priority?: string;
  note?: string; tags?: string[]; url?: string | null };
export type BoardCol = { name: string; cards: Card[]; limit?: number | null };
export type Series = { key: string; label: string };
export type Stat = { label: string; value: number | string; format: string; currency?: string; delta?: number | null; note?: string };
type Head = { type: "data"; title: string; caption?: string; source?: string; as_of?: string };
export type TableEv = Head & { view: "table"; columns: Col[]; rows: Row[]; totals: Record<string, number> };
export type ChartEv = Head & { view: "chart"; kind: "bar" | "bar_stacked" | "line" | "area" | "donut" | "burndown";
  x_label?: string; y_label?: string; format: string; currency?: string; series: Series[]; points: Row[]; ideal?: number[] };
export type KanbanEv = Head & { view: "kanban"; columns: BoardCol[]; count: number };
export type StatsEv = Head & { view: "stats"; items: Stat[] };
export type FlowNode = { id: string; label: string; note: string; shape: "process" | "decision" | "terminal"; group: string };
export type FlowEdge = { from: string; to: string; label: string };
export type FlowEv = Head & { view: "diagram"; kind: "flow"; nodes: FlowNode[]; edges: FlowEdge[]; groups: string[]; direction: "" | "right" | "down" };
export type TimelineEv = Head & { view: "diagram"; kind: "timeline"; items: { date: string; label: string; note: string; state: "" | "done" | "now" | "next" }[] };
export type FlowNodeAt = FlowNode & { x: number; y: number; w: number; h: number; lines: string[]; notes: string[] };
export type FlowArrow = { d: string; head: string; label: string; lx: number; ly: number; back: boolean };
export type FlowLayout = { nodes: FlowNodeAt[]; arrows: FlowArrow[]; width: number; height: number };
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

/** A chart's numbers as a sheet: the table view every chart has. */
export function chartSheet(ev: ChartEv): { columns: Col[]; rows: Row[]; totals: Record<string, number> } {
  const type = ev.format === "money" ? "money" : ev.format === "percent" ? "percent" : "number";
  const series = ev.series.map((s) => ({ key: s.key, label: s.label, type, currency: ev.currency } as Col));
  const columns: Col[] = [{ key: "x", label: ev.x_label || "", type: "text" }, ...series];
  const rows = ev.points.map((p, i) => (ev.ideal ? { ...p, __ideal: ev.ideal[i] } : p));
  if (ev.ideal) columns.push({ key: "__ideal", label: "Ideal", type, currency: ev.currency });
  return { columns, rows, totals: {} };
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

const NODE_W = 176, LINE = 15, NOTE_LINE = 13, CROSS_GAP = 18;

/** Lay out a flow: ranks by longest path with back edges set aside, order within a rank by the
 *  mean position of its neighbours, a curve per arrow. Small and readable beats a full graph
 *  layout here: the schema caps a flow at 60 steps, and a bigger one should be split anyway. */
export function layoutFlow(ev: FlowEv, dir: "right" | "down"): FlowLayout {
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
  const forward = ev.edges.filter((e) => !back.has(e) && e.from !== e.to);

  const rank = new Map<string, number>(ids.map((i) => [i, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of forward) {
      const want = (rank.get(e.from) ?? 0) + 1;
      if ((rank.get(e.to) ?? 0) < want) { rank.set(e.to, want); moved = true; }
    }
    if (!moved) break;
  }
  const ranks: string[][] = [];
  for (const id of ids) (ranks[rank.get(id) ?? 0] ??= []).push(id);
  const rows = ranks.map((r) => r ?? []);
  for (let sweep = 0; sweep < 4; sweep++) {
    const list = sweep % 2 ? [...rows].reverse() : rows;
    for (const r of list) {
      const where = new Map(rows.flatMap((x) => x.map((id, i): [string, number] => [id, i])));
      const score = (id: string) => {
        const near = forward.flatMap((e) => (sweep % 2 ? (e.from === id ? [e.to] : []) : (e.to === id ? [e.from] : [])));
        return near.length ? near.reduce((t, n) => t + (where.get(n) ?? 0), 0) / near.length : where.get(id) ?? 0;
      };
      const scored = new Map(r.map((id) => [id, score(id)]));
      r.sort((a, b) => (scored.get(a) ?? 0) - (scored.get(b) ?? 0));
    }
  }

  const shapes = new Map(ev.nodes.map((n) => {
    const chars = n.shape === "decision" ? 20 : 24;
    const lines = wrap(n.label, chars, 3), notes = n.note ? wrap(n.note, chars + 3, 2) : [];
    return [n.id, { n, lines, notes, h: Math.max(44, 18 + lines.length * LINE + notes.length * NOTE_LINE) }];
  }));
  const across = dir === "right";
  const labelled = ev.edges.some((e) => e.label);
  const mainGap = (across ? 56 : 42) + (labelled ? 28 : 0);
  const size = (id: string) => { const s = shapes.get(id)!; return across ? s.h : NODE_W; };
  const main = (id: string) => (across ? NODE_W : shapes.get(id)!.h);
  const spans = rows.map((r) => r.reduce((t, id) => t + size(id), 0) + CROSS_GAP * Math.max(r.length - 1, 0));
  const widest = Math.max(...spans, 0);
  const pad = 8;
  const nodes = new Map<string, FlowNodeAt>();
  let along = pad;
  rows.forEach((r, i) => {
    let at = pad + (widest - spans[i]) / 2;
    const thick = Math.max(...r.map(main), 0);
    for (const id of r) {
      const s = shapes.get(id)!;
      const offset = (thick - main(id)) / 2;
      nodes.set(id, { ...s.n, lines: s.lines, notes: s.notes, w: NODE_W, h: s.h,
        x: across ? along + offset : at, y: across ? at : along + offset });
      at += size(id) + CROSS_GAP;
    }
    along += thick + mainGap;
  });
  const arrows: FlowArrow[] = ev.edges.flatMap((e): FlowArrow[] => {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a || !b) return [];
    if (a === b) {
      const x = a.x + a.w, y = a.y + a.h / 2;
      return [{ d: `M${x},${y - 6}C${x + 26},${y - 22} ${x + 26},${y + 22} ${x + 5},${y + 7}`, head: arrowHead(x + 1, y + 5, -1, -0.4), label: e.label, lx: x + 24, ly: y, back: true }];
    }
    if (back.has(e)) {
      // A way back leaves by the side and bows out past both steps, so it can't lie on top of
      // the arrow going forward between the same two.
      const reach = 44;
      if (across) {
        const out = Math.max(a.y + a.h, b.y + b.h) + reach;
        const p0 = [a.x + a.w / 2, a.y + a.h], p3 = [b.x + b.w / 2, b.y + b.h];
        return [{ d: `M${p0[0]},${p0[1]}C${p0[0]},${out} ${p3[0]},${out} ${p3[0]},${p3[1] + 7}`, head: arrowHead(p3[0], p3[1], 0, -1),
          label: e.label, lx: (p0[0] + p3[0]) / 2, ly: (p0[1] + p3[1] + 6 * out) / 8, back: true }];
      }
      const out = Math.max(a.x + a.w, b.x + b.w) + reach;
      const p0 = [a.x + a.w, a.y + a.h / 2], p3 = [b.x + b.w, b.y + b.h / 2];
      return [{ d: `M${p0[0]},${p0[1]}C${out},${p0[1]} ${out},${p3[1]} ${p3[0] + 7},${p3[1]}`, head: arrowHead(p3[0], p3[1], -1, 0),
        label: e.label, lx: (p0[0] + p3[0] + 6 * out) / 8, ly: (p0[1] + p3[1]) / 2, back: true }];
    }
    const p0 = across ? [a.x + a.w, a.y + a.h / 2] : [a.x + a.w / 2, a.y + a.h];
    const p3 = across ? [b.x, b.y + b.h / 2] : [b.x + b.w / 2, b.y];
    const reach = Math.max(28, Math.abs(across ? p3[0] - p0[0] : p3[1] - p0[1]) / 2);
    const c1 = across ? [p0[0] + reach, p0[1]] : [p0[0], p0[1] + reach];
    const c2 = across ? [p3[0] - reach, p3[1]] : [p3[0], p3[1] - reach];
    const tip = across ? [p3[0] - 7, p3[1]] : [p3[0], p3[1] - 7];
    return [{ d: `M${p0[0]},${p0[1]}C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${tip[0]},${tip[1]}`,
      head: across ? arrowHead(p3[0], p3[1], 1, 0) : arrowHead(p3[0], p3[1], 0, 1), label: e.label,
      lx: (p0[0] + 3 * c1[0] + 3 * c2[0] + p3[0]) / 8, ly: (p0[1] + 3 * c1[1] + 3 * c2[1] + p3[1]) / 8, back: false }];
  });
  const list = [...nodes.values()];
  const bottoms = arrows.map((a) => a.ly + 12);
  return { nodes: list, arrows,
    width: Math.max(...list.map((n) => n.x + n.w), ...arrows.map((a) => a.lx + 30)) + pad,
    height: Math.max(...list.map((n) => n.y + n.h), ...bottoms) + pad };
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
