import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  chartSheet, delimited, domain, flatten, fmt, layoutFlow, matches, nodePath, overdue, sorted, sumOf, ticks,
  type BoardCol, type Card, type ChartEv, type Col, type DataEv, type FlowEv, type KanbanEv, type Row, type StatsEv, type TableEv, type TimelineEv,
} from "../lib/dataview";
import { saveView, sendFile, useRefSession } from "../lib/readapi";
import { xlsx } from "../lib/viewexport";
import { viewPng } from "../lib/viewpng";

// A sheet, chart, board, diagram or row of figures an agent showed on the turn (show_data,
// bridge/data_views.py). Hand-built SVG, as neither app has a chart library and these four
// don't justify one. The same file is in both apps, styled by dataview.css: it needs no API,
// only what's on the event, so a chat scrolled back to in a year still draws.
//
// Colour: series take --dv-1..8 in fixed order, validated in both modes against the
// surface (the dataviz method's validator). It follows the theme's light or dark, never its
// accent, so a burn line doesn't change colour when you change palette. Text stays in text
// tokens. Status colour is only for a past-due card and a column over its limit, and both say
// so in words. A chart has one axis, always: two units are two charts, and show_data's schema
// tells the agent that.

const series = (i: number) => `var(--dv-${(i % 8) + 1})`;
const ROW = 30;
const WINDOW_FROM = 200;

function useSize(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ob = new ResizeObserver(() => setW(el.clientWidth));
    ob.observe(el);
    setW(el.clientWidth);
    return () => ob.disconnect();
  }, []);
  return [ref, w];
}

// ---- sheet ------------------------------------------------------------------

type Sheet = { columns: Col[]; rows: Row[]; totals: Record<string, number> };

function useSheet(sheet: Sheet) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const kept = q ? sheet.rows.filter((r) => matches(r, sheet.columns, q)) : sheet.rows;
    return sorted(kept, sort?.key ?? null, sort?.dir ?? 1);
  }, [sheet, q, sort]);
  const totals = useMemo(() => (q ? sumOf(rows, sheet.columns, sheet.totals) : sheet.totals), [q, rows, sheet]);
  // Ascending, descending, then back to how the agent had it.
  const toggle = (key: string) => setSort((s) => (s?.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));
  return { rows, totals, sort, q, setQ, toggle };
}
type SheetState = ReturnType<typeof useSheet>;

function cellText(v: Row[string], c: Col) {
  if (c.type === "progress") return fmt(v, "percent");
  if (c.type === "money" || c.type === "number" || c.type === "percent") return fmt(v, c.type, c.currency);
  return v === null || v === undefined ? "" : String(v);
}

function Cell({ v, c }: { v: Row[string]; c: Col }) {
  if (c.type === "link" && typeof v === "string") {
    let host = v;
    try { host = new URL(v).host; } catch { /* as written */ }
    return <a href={v} target="_blank" rel="noopener noreferrer">{host}</a>;
  }
  if (c.type === "progress" && typeof v === "number") {
    return <span className="dv-progress"><span className="dv-track" aria-hidden><i style={{ width: `${Math.max(0, Math.min(100, v))}%` }} /></span><span className="dv-progress-n">{cellText(v, c)}</span></span>;
  }
  return <>{cellText(v, c)}</>;
}

const numeric = (c: Col) => c.type === "money" || c.type === "number" || c.type === "percent" || c.type === "progress";

function SheetTable({ cols, st, full }: { cols: Col[]; st: SheetState; full: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(0);
  const big = st.rows.length > WINDOW_FROM;
  const seen = ref.current?.clientHeight || 420;
  const from = big ? Math.max(0, Math.floor(top / ROW) - 20) : 0;
  const to = big ? Math.min(st.rows.length, from + Math.ceil(seen / ROW) + 40) : st.rows.length;
  const hasTotals = cols.some((c) => c.key in st.totals);
  return (
    <div className="dv-sheet" data-full={full || undefined} ref={ref} onScroll={big ? (e) => setTop(e.currentTarget.scrollTop) : undefined}
      tabIndex={0} role="region" aria-label="Sheet">
      <table>
        <thead>
          <tr>
            {cols.map((c) => {
              const on = st.sort?.key === c.key;
              return (
                <th key={c.key} data-n={numeric(c) || undefined} aria-sort={on ? (st.sort!.dir === 1 ? "ascending" : "descending") : undefined}>
                  <button type="button" onClick={() => st.toggle(c.key)}>
                    {c.label}<span className="dv-sort" aria-hidden>{on ? (st.sort!.dir === 1 ? "▲" : "▼") : ""}</span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {from > 0 ? <tr style={{ height: from * ROW }} aria-hidden /> : null}
          {st.rows.slice(from, to).map((r, i) => (
            <tr key={from + i}>
              {cols.map((c) => {
                const text = cellText(r[c.key], c);
                return <td key={c.key} data-n={numeric(c) || undefined} title={text.length > 30 ? text : undefined}><Cell v={r[c.key]} c={c} /></td>;
              })}
            </tr>
          ))}
          {to < st.rows.length ? <tr style={{ height: (st.rows.length - to) * ROW }} aria-hidden /> : null}
          {!st.rows.length ? <tr><td colSpan={cols.length} className="dv-none">No rows match.</td></tr> : null}
        </tbody>
        {hasTotals ? (
          <tfoot>
            <tr>
              {cols.map((c, i) => (
                <td key={c.key} data-n={numeric(c) || undefined}>
                  {c.key in st.totals ? fmt(st.totals[c.key], c.type, c.currency) : i === 0 ? (st.q ? "SHOWN" : "TOTAL") : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

// The Mini App is a webview that drops a blob download without a word.
const canDownload = () => !(window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData;

// ---- chart ------------------------------------------------------------------

function barPath(x: number, y0: number, y1: number, w: number, round: boolean): string {
  const up = y1 < y0;
  const h = Math.max(Math.abs(y1 - y0), 1);
  const yEnd = up ? y0 - h : y0 + h;
  const r = round ? Math.min(4, w / 2, h) : 0;
  const s = up ? 1 : -1;
  return `M${x},${y0}V${yEnd + s * r}` + (r ? `Q${x},${yEnd} ${x + r},${yEnd}` : "") + `H${x + w - r}`
    + (r ? `Q${x + w},${yEnd} ${x + w},${yEnd + s * r}` : "") + `V${y0}Z`;
}

function lines(pts: ([number, number] | null)[]): string {
  let d = "", open = false;
  for (const p of pts) {
    if (!p) { open = false; continue; }
    d += `${open ? "L" : "M"}${p[0]},${p[1]}`;
    open = true;
  }
  return d;
}

function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="dv-legend">
      {items.map((it) => (
        <li key={it.label}><span className="dv-swatch" data-dashed={it.dashed || undefined} style={{ background: it.dashed ? undefined : it.color }} />{it.label}</li>
      ))}
    </ul>
  );
}

function Plot({ ev, full }: { ev: ChartEv; full: boolean }) {
  const [ref, w] = useSize();
  const [at, setAt] = useState<number | null>(null);
  const n = ev.points.length;
  const H = full ? Math.max(360, window.innerHeight - 190) : w && w < 480 ? 220 : 280;
  const [lo, hi] = domain(ev);
  const marks = ticks(lo, hi, H < 240 ? 4 : 5);
  const yLo = marks[0], yHi = marks[marks.length - 1];
  const axis = (v: number) => fmt(v, ev.format, ev.currency, true);
  const flowing = ev.kind === "line" || ev.kind === "area" || ev.kind === "burndown";
  const labelled = flowing && w >= 480 && ev.series.length <= 4;
  const m = { l: Math.max(...marks.map((t) => axis(t).length)) * 6.6 + 10, r: labelled ? 96 : 12, t: 10, b: ev.x_label ? 42 : 24 };
  const pw = Math.max(w - m.l - m.r, 10), ph = H - m.t - m.b;
  const y = (v: number) => m.t + ph - ((v - yLo) / (yHi - yLo || 1)) * ph;
  const band = pw / Math.max(n, 1);
  const x = (i: number) => (flowing ? (n === 1 ? m.l + pw / 2 : m.l + (pw * i) / (n - 1)) : m.l + band * (i + 0.5));
  const nearest = (px: number) => {
    const i = flowing ? Math.round(n === 1 ? 0 : ((px - m.l) / pw) * (n - 1)) : Math.floor((px - m.l) / band);
    return Math.min(n - 1, Math.max(0, i));
  };
  const pos = (e: React.PointerEvent<SVGSVGElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const longest = ev.points.reduce((t, p) => Math.max(t, String(p.x).length), 1);
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / (Math.min(longest, 14) * 6.6 + 10)))));
  const clip = (s: string, c: number) => (s.length > c ? `${s.slice(0, c - 1)}…` : s);
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

  const bars: ReactNode[] = [];
  if (w && ev.kind === "bar") {
    const k = ev.series.length;
    const bw = Math.max(2, Math.min(28, (band * 0.72 - 2 * (k - 1)) / k));
    const span = bw * k + 2 * (k - 1);
    ev.points.forEach((p, i) => ev.series.forEach((s, j) => {
      const v = num(p[s.key]);
      if (v === null) return;
      bars.push(<path key={`${i}-${j}`} d={barPath(x(i) - span / 2 + j * (bw + 2), y(0), y(v), bw, true)} fill={series(j)} />);
    }));
  }
  if (w && ev.kind === "bar_stacked") {
    const bw = Math.max(3, Math.min(36, band * 0.62));
    ev.points.forEach((p, i) => {
      let up = 0, down = 0;
      const vals = ev.series.map((s) => num(p[s.key]));
      const lastUp = vals.map((v) => (v ?? 0) > 0).lastIndexOf(true), lastDown = vals.map((v) => (v ?? 0) < 0).lastIndexOf(true);
      vals.forEach((v, j) => {
        if (!v) return;
        const from = v > 0 ? up : down, to = from + v;
        if (v > 0) up = to; else down = to;
        // the 2px of surface between segments comes off the segment's far end
        const top = j === (v > 0 ? lastUp : lastDown);
        const y1 = y(to) + (top ? 0 : v > 0 ? 2 : -2);
        bars.push(<path key={`${i}-${j}`} d={barPath(x(i) - bw / 2, y(from), y1, bw, top)} fill={series(j)} />);
      });
    });
  }

  const flows: ReactNode[] = [];
  const ends: { x: number; y: number; label: string }[] = [];
  if (w && flowing) {
    ev.series.forEach((s, j) => {
      const pts = ev.points.map((p, i) => { const v = num(p[s.key]); return v === null ? null : ([x(i), y(v)] as [number, number]); });
      if (ev.kind === "area") {
        let run: [number, number][] = [];
        const fills: string[] = [];
        for (const p of [...pts, null]) {
          if (p) { run.push(p); continue; }
          if (run.length > 1) fills.push(`M${run[0][0]},${y(Math.max(yLo, 0))}L${run.map((q) => q.join(",")).join("L")}L${run[run.length - 1][0]},${y(Math.max(yLo, 0))}Z`);
          run = [];
        }
        flows.push(<path key={`f${j}`} d={fills.join("")} fill={series(j)} opacity={0.16} />);
      }
      flows.push(<path key={`l${j}`} d={lines(pts)} fill="none" stroke={series(j)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />);
      if (n <= 16) pts.forEach((p, i) => { if (p) flows.push(<circle key={`d${j}-${i}`} cx={p[0]} cy={p[1]} r={4} fill={series(j)} stroke="var(--dv-surface)" strokeWidth={2} />); });
      const last = pts.filter(Boolean).pop();
      // at the line's own end: a burndown stops at today, well short of the axis
      if (last) ends.push({ x: last[0], y: last[1], label: s.label });
    });
    if (ev.ideal) {
      flows.unshift(<path key="ideal" d={lines(ev.ideal.map((v, i) => [x(i), y(v)]))} fill="none" stroke="var(--txd)" strokeWidth={1.5} strokeDasharray="4 4" />);
      ends.push({ x: x(n - 1), y: y(ev.ideal[ev.ideal.length - 1]), label: "Ideal" });
    }
  }
  ends.sort((a, b) => a.y - b.y).forEach((e, i) => { if (i && e.y - ends[i - 1].y < 14) e.y = ends[i - 1].y + 14; });

  const point = at === null ? null : ev.points[at];
  const sum = point && ev.kind === "bar_stacked" ? ev.series.reduce((t, s) => t + (num(point[s.key]) ?? 0), 0) : null;
  const keys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const d = e.key === "ArrowRight" ? 1 : -1;
    setAt((i) => (i === null ? (d > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, i + d))));
  };
  const legend = ev.series.map((s, i) => ({ label: s.label, color: series(i) }));
  if (ev.ideal) legend.push({ label: "Ideal", color: "var(--txd)", dashed: true } as (typeof legend)[number]);

  return (
    <div className="dv-chart">
      {legend.length > 1 ? <Legend items={legend} /> : null}
      {ev.y_label ? <div className="dv-axis-name">{ev.y_label}</div> : null}
      <div className="dv-plot" ref={ref} style={{ height: H }} tabIndex={0} onKeyDown={keys} onBlur={() => setAt(null)}
        role="img" aria-label={`${ev.title}: ${n} points. The arrow keys step through them, and the table view lists them.`}>
        {w ? (
          <svg width={w} height={H} style={{ touchAction: "pan-y" }}
            onPointerMove={(e) => { if (e.pointerType === "mouse") setAt(nearest(pos(e))); }}
            onPointerLeave={(e) => { if (e.pointerType === "mouse") setAt(null); }}
            onPointerDown={(e) => { if (e.pointerType === "mouse") return; const i = nearest(pos(e)); setAt((c) => (c === i ? null : i)); }}>
            {marks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--dv-zero)" : "var(--dv-grid)"} strokeWidth={1} />
                <text x={m.l - 8} y={y(t) + 3.5} textAnchor="end" className="dv-tick">{axis(t)}</text>
              </g>
            ))}
            {ev.points.map((p, i) => (i % every === 0 ? <text key={i} x={x(i)} y={m.t + ph + 16} textAnchor="middle" className="dv-tick">{clip(String(p.x), 14)}</text> : null))}
            {ev.x_label ? <text x={m.l + pw / 2} y={H - 4} textAnchor="middle" className="dv-tick">{ev.x_label}</text> : null}
            {at !== null && !flowing ? <rect x={m.l + band * at} y={m.t} width={band} height={ph} fill="var(--dv-hover)" /> : null}
            {bars}
            {flows}
            {labelled ? ends.map((e) => <text key={e.label} x={e.x + 8} y={e.y + 3.5} className="dv-end">{clip(e.label, 12)}</text>) : null}
            {at !== null && flowing ? (
              <g>
                <line x1={x(at)} x2={x(at)} y1={m.t} y2={m.t + ph} stroke="var(--dv-zero)" strokeWidth={1} />
                {ev.series.map((s, j) => { const v = num(point?.[s.key]); return v === null ? null : <circle key={j} cx={x(at)} cy={y(v)} r={5} fill={series(j)} stroke="var(--dv-surface)" strokeWidth={2} />; })}
              </g>
            ) : null}
          </svg>
        ) : null}
        {point && at !== null ? (
          <div className="dv-tip" style={x(at) > w / 2 ? { right: w - x(at) + 12 } : { left: x(at) + 12 }}>
            <div className="dv-tip-x">{String(point.x)}</div>
            {ev.series.map((s, j) => (
              <div key={s.key} className="dv-tip-row"><span className="dv-swatch" style={{ background: series(j) }} /><span>{s.label}</span><b>{num(point[s.key]) === null ? "–" : fmt(point[s.key], ev.format, ev.currency)}</b></div>
            ))}
            {sum !== null && ev.series.length > 1 ? <div className="dv-tip-row dv-tip-sum"><span className="dv-swatch" data-none /><span>Total</span><b>{fmt(sum, ev.format, ev.currency)}</b></div> : null}
            {ev.ideal ? <div className="dv-tip-row"><span className="dv-swatch" data-dashed /><span>Ideal</span><b>{fmt(ev.ideal[at], ev.format, ev.currency)}</b></div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Donut({ ev }: { ev: ChartEv }) {
  const [at, setAt] = useState<number | null>(null);
  const key = ev.series[0].key;
  const vals = ev.points.map((p) => (typeof p[key] === "number" ? (p[key] as number) : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  const S = 200, R = 84, W = 22, c = S / 2;
  let from = -Math.PI / 2;
  const gap = vals.filter((v) => v > 0).length > 1 ? 2 / R : 0;      // 2px of surface between slices
  const arcs = vals.map((v, i) => {
    const sweep = total ? (v / total) * Math.PI * 2 : 0;
    const a = from + gap / 2, b = from + Math.max(sweep - gap / 2, gap / 2);
    from += sweep;
    if (!sweep) return null;
    // A full circle isn't an arc to SVG: stop just short of it.
    const end = sweep >= Math.PI * 2 ? b - 0.0001 : b;
    const d = `M${c + R * Math.cos(a)},${c + R * Math.sin(a)}A${R},${R} 0 ${end - a > Math.PI ? 1 : 0} 1 ${c + R * Math.cos(end)},${c + R * Math.sin(end)}`;
    return <path key={i} d={d} fill="none" stroke={series(i)} strokeWidth={at === i ? W + 4 : W} opacity={at === null || at === i ? 1 : 0.35}
      onPointerEnter={() => setAt(i)} onPointerLeave={() => setAt(null)} />;
  });
  const pct = (v: number) => (total ? `${fmt((v / total) * 100, "percent")}` : "");
  const shown = at === null ? total : vals[at];
  return (
    <div className="dv-donut">
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`${ev.title}: ${ev.points.map((p, i) => `${p.x} ${pct(vals[i])}`).join(", ")}`}>
        {arcs}
        <text x={c} y={c - 2} textAnchor="middle" className="dv-center">{fmt(shown, ev.format, ev.currency, String(Math.round(shown)).length > 6)}</text>
        <text x={c} y={c + 15} textAnchor="middle" className="dv-tick">{at === null ? "TOTAL" : pct(vals[at])}</text>
      </svg>
      <ul className="dv-slices">
        {ev.points.map((p, i) => (
          <li key={i} data-on={at === i || undefined} onPointerEnter={() => setAt(i)} onPointerLeave={() => setAt(null)}>
            <span className="dv-swatch" style={{ background: series(i) }} /><span className="dv-slice-name">{String(p.x)}</span>
            <b>{fmt(vals[i], ev.format, ev.currency)}</b><span className="dv-slice-pct">{pct(vals[i])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- board ------------------------------------------------------------------

function CardView({ card, column, asOf }: { card: Card; column: string; asOf?: string }) {
  const late = overdue(card.due, column, asOf);
  const title = card.url ? <a href={card.url} target="_blank" rel="noopener noreferrer">{card.title}</a> : card.title;
  return (
    <li className="dv-card">
      {card.key || card.priority ? <div className="dv-card-top"><span>{card.key}</span>{card.priority ? <span className="dv-prio">{card.priority.toUpperCase()}</span> : null}</div> : null}
      <div className="dv-card-title">{title}</div>
      {card.note ? <div className="dv-card-note">{card.note}</div> : null}
      {card.tags?.length ? <div className="dv-tags">{card.tags.map((t) => <span key={t}>{t}</span>)}</div> : null}
      {card.assignee || card.due ? (
        <div className="dv-card-foot"><span>{card.assignee}</span>{card.due ? <span data-late={late || undefined}>{late ? "⚠ overdue " : ""}{card.due}</span> : null}</div>
      ) : null}
    </li>
  );
}

function Board({ ev, full }: { ev: KanbanEv; full: boolean }) {
  return (
    <div className="dv-board" data-full={full || undefined} tabIndex={0} role="region" aria-label="Board">
      {ev.columns.map((c: BoardCol) => {
        const over = !!c.limit && c.cards.length > c.limit;
        return (
          <section key={c.name} className="dv-col">
            <header>
              <span className="dv-col-name">{c.name}</span>
              <span className="dv-col-n" data-over={over || undefined}>{over ? "⚠ " : ""}{c.cards.length}{c.limit ? ` / ${c.limit}` : ""}</span>
            </header>
            {c.cards.length ? <ul>{c.cards.map((k, i) => <CardView key={`${k.key}-${i}`} card={k} column={c.name} asOf={ev.as_of} />)}</ul> : <div className="dv-empty">Nothing here</div>}
          </section>
        );
      })}
    </div>
  );
}

// ---- figures ----------------------------------------------------------------

function Tiles({ ev }: { ev: StatsEv }) {
  return (
    <dl className="dv-tiles">
      {ev.items.map((s) => {
        const value = s.format === "text" ? String(s.value) : fmt(s.value, s.format, s.currency);
        return (
          <div key={s.label} className="dv-tile">
            <dt>{s.label}</dt>
            <dd>{value}</dd>
            {typeof s.delta === "number" ? <div className="dv-delta">{s.delta > 0 ? "▲ +" : s.delta < 0 ? "▼ " : ""}{fmt(s.delta, s.format === "text" ? "number" : s.format, s.currency)}</div> : null}
            {s.note ? <div className="dv-note">{s.note}</div> : null}
          </div>
        );
      })}
    </dl>
  );
}

// ---- diagrams ---------------------------------------------------------------

function Flow({ ev, full, print }: { ev: FlowEv; full: boolean; print?: boolean }) {
  const [ref, w] = useSize();
  const layout = useMemo(() => {
    const right = layoutFlow(ev, "right");
    if (ev.direction) return layoutFlow(ev, ev.direction);
    if (print || (w && right.width <= w)) return right;
    return w < 560 || !full ? layoutFlow(ev, "down") : right;
  }, [ev, w, full, print]);
  // Shrink a little to fit rather than scroll, and past that scroll rather than go unreadable.
  const scale = print || !w || layout.width <= w ? 1 : Math.max(0.8, w / layout.width);
  const shown = (g: string) => (g ? series(ev.groups.indexOf(g)) : "var(--dv-zero)");
  return (
    <div className="dv-chart">
      {ev.groups.length > 1 ? <Legend items={ev.groups.map((g, i) => ({ label: g, color: series(i) }))} /> : null}
      <div className="dv-flow" ref={ref} tabIndex={0} role="img"
        aria-label={`${ev.title}: ${ev.nodes.map((n) => n.label).join(", ")}`}>
        {w || print ? (
          <svg width={layout.width * scale} height={layout.height * scale} viewBox={`0 0 ${layout.width} ${layout.height}`}>
            {layout.arrows.map((a, i) => (
              <g key={i}>
                <path d={a.d} fill="none" stroke="var(--txd)" strokeWidth={1.5} strokeDasharray={a.back ? "4 4" : undefined} />
                <path d={a.head} fill="var(--txd)" />
              </g>
            ))}
            {layout.nodes.map((n) => (
              <g key={n.id}>
                <path d={nodePath(n)} fill="var(--dv-surface)" stroke={shown(n.group)} strokeWidth={n.group ? 2 : 1} />
                {n.lines.map((l, i) => {
                  const total = n.lines.length * 15 + n.notes.length * 13;
                  return <text key={i} x={n.x + n.w / 2} y={n.y + (n.h - total) / 2 + 12 + i * 15} textAnchor="middle" className="dv-node">{l}</text>;
                })}
                {n.notes.map((l, i) => {
                  const total = n.lines.length * 15 + n.notes.length * 13;
                  return <text key={`n${i}`} x={n.x + n.w / 2} y={n.y + (n.h - total) / 2 + n.lines.length * 15 + 10 + i * 13} textAnchor="middle" className="dv-tick">{l}</text>;
                })}
                {n.note ? <title>{n.note}</title> : null}
              </g>
            ))}
            {layout.arrows.map((a, i) => (a.label ? (
              <g key={`l${i}`}>
                <rect x={a.lx - a.label.length * 3.2 - 4} y={a.ly - 8} width={a.label.length * 6.4 + 8} height={15} fill="var(--dv-surface)" />
                <text x={a.lx} y={a.ly + 3.5} textAnchor="middle" className="dv-tick">{a.label}</text>
              </g>
            ) : null))}
          </svg>
        ) : null}
      </div>
    </div>
  );
}

const STATE = { done: "Done", now: "Now", next: "Next" };

function Timeline({ ev }: { ev: TimelineEv }) {
  return (
    <ol className="dv-time">
      {ev.items.map((it, i) => (
        <li key={i} data-state={it.state || undefined}>
          <span className="dv-time-dot" aria-hidden />
          <div className="dv-time-when">{it.date}{it.state ? <span className="dv-time-state">{STATE[it.state]}</span> : null}</div>
          <div className="dv-time-what">{it.label}</div>
          {it.note ? <div className="dv-time-note">{it.note}</div> : null}
        </li>
      ))}
    </ol>
  );
}

// ---- the frame ---------------------------------------------------------------

const noSheet: Sheet = { columns: [], rows: [], totals: {} };
const PRINT_ROWS = 200;
const nameOf = (title: string, ext: string) => `${title.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "view"}.${ext}`;

function Body({ ev, sheet, st, full, asTable, print }: { ev: DataEv; sheet: Sheet; st: SheetState; full: boolean; asTable: boolean; print?: boolean }) {
  if (ev.view === "table" || (ev.view === "chart" && asTable)) return <SheetTable cols={sheet.columns} st={st} full={full} />;
  if (ev.view === "chart") return ev.kind === "donut" ? <Donut ev={ev} /> : <Plot ev={ev} full={full} />;
  if (ev.view === "kanban") return <Board ev={ev} full={full} />;
  if (ev.view === "stats") return <Tiles ev={ev} />;
  if (ev.view === "diagram") return ev.kind === "flow" ? <Flow ev={ev} full={full} print={print} /> : <Timeline ev={ev} />;
  return null;
}

function Foot({ ev, st, total, cut }: { ev: DataEv; st: SheetState; total: number; cut?: number }) {
  return (
    <footer className="dv-foot">
      {ev.view === "table" ? <span>{cut ? `first ${cut} of ${total}` : st.q ? `${st.rows.length} of ${total}` : total} rows</span> : null}
      {ev.view === "kanban" ? <span>{ev.count} cards</span> : null}
      {ev.source ? <span>{ev.source}</span> : null}
      {ev.as_of ? <span>as of {ev.as_of}</span> : null}
    </footer>
  );
}

/** The whole view, off screen, with nothing scrolled away: what a PNG is painted from. */
function PrintCopy({ ev, sheet, st, asTable, onDone }: { ev: DataEv; sheet: Sheet; st: SheetState; asTable: boolean; onDone: (b: Blob | Error) => void }) {
  const ref = useRef<HTMLElement>(null);
  const cut = st.rows.length > PRINT_ROWS ? PRINT_ROWS : 0;
  const shown = useMemo(() => (cut ? { ...st, rows: st.rows.slice(0, cut) } : st), [st, cut]);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      if (!ref.current || !live) return;
      viewPng(ref.current).then(onDone, (e) => onDone(e instanceof Error ? e : new Error("Couldn't make the picture.")));
    }, 160);      // a chart measures itself, then draws
    return () => { live = false; window.clearTimeout(t); };
  }, [onDone]);
  return createPortal(
    <section ref={ref} className="dv" data-print="" data-view={ev.view} aria-hidden>
      <header className="dv-head"><h4>{ev.title}</h4></header>
      {ev.caption ? <p className="dv-caption">{ev.caption}</p> : null}
      <div className="dv-body"><Body ev={ev} sheet={sheet} st={shown} full={false} asTable={asTable} print /></div>
      <Foot ev={ev} st={shown} total={sheet.rows.length} cut={cut} />
    </section>,
    document.body,
  );
}

type Item = { label: string; run: () => void | Promise<void> };

function ToolMenu({ label, items }: { label: string; items: Item[] }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setAt(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setAt(null); };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", key); };
  }, [at]);
  const width = 200;
  return (
    <>
      <button type="button" className="dv-btn" aria-haspopup="menu" aria-expanded={!!at} onClick={(e) => setAt(at ? null : e.currentTarget.getBoundingClientRect())}>{label}</button>
      {at ? createPortal(
        <div ref={box} className="rd-menu dv-menu" role="menu" style={{ width, left: Math.max(8, Math.min(at.right - width, window.innerWidth - width - 8)),
          ...(at.bottom + 200 < window.innerHeight ? { top: at.bottom + 4 } : { bottom: window.innerHeight - at.top + 4 }) }}>
          {items.map((it) => <button key={it.label} type="button" role="menuitem" onClick={() => { setAt(null); void it.run(); }}>{it.label}</button>)}
        </div>, document.body) : null}
    </>
  );
}

function Frame({ ev, savedId, onRemove }: { ev: DataEv; savedId?: string; onRemove?: (id: string) => void }) {
  const session = useRefSession();
  const [full, setFull] = useState(false);
  const [asTable, setAsTable] = useState(false);
  const [said, setSaid] = useState("");
  const [savedHere, setSavedHere] = useState(false);
  const [printing, setPrinting] = useState<((b: Blob | Error) => void) | null>(null);
  const sheet = useMemo<Sheet>(() => (ev.view === "table" ? (ev as TableEv) : ev.view === "chart" ? chartSheet(ev) : noSheet), [ev]);
  const st = useSheet(sheet);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  const tell = useCallback((text: string, stay = false) => {
    setSaid(text);
    if (!stay) window.setTimeout(() => setSaid((s) => (s === text ? "" : s)), 3500);
  }, []);
  const png = useCallback(() => new Promise<Blob>((resolve, reject) => {
    setPrinting(() => (b: Blob | Error) => {
      setPrinting(null);
      if (b instanceof Error) reject(b); else resolve(b);
    });
  }), []);
  const flat = () => (ev.view === "table" ? { columns: sheet.columns, rows: st.rows, totals: st.q ? st.totals : sheet.totals } : flatten(ev));
  const attempt = async (doing: string, f: () => Promise<string>) => {
    tell(doing, true);
    try { tell(await f()); } catch (e) { tell(e instanceof Error ? e.message : "That didn't work."); }
  };
  // A Telegram webview drops a download without a word, so there it arrives as a message.
  const deliver = async (blob: Blob, name: string): Promise<string> => {
    if (!canDownload()) {
      await sendFile(name, blob, ev.title);
      return "Sent to your Telegram";
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    return `Saved ${name}`;
  };
  const exportItems: Item[] = [
    { label: "PNG image", run: () => attempt("Drawing…", async () => deliver(await png(), nameOf(ev.title, "png"))) },
    { label: "Excel (.xlsx)", run: () => attempt("Exporting…", async () => {
      const f = flat();
      return deliver(new Blob([xlsx(ev.title, f.columns, f.rows, f.totals) as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), nameOf(ev.title, "xlsx"));
    }) },
    { label: "CSV", run: () => attempt("Exporting…", async () => {
      const f = flat();
      return deliver(new Blob([delimited(f.columns, f.rows, ",")], { type: "text/csv;charset=utf-8" }), nameOf(ev.title, "csv"));
    }) },
  ];
  const copyImage = () => attempt("Drawing…", async () => {
    // WebKit wants the write started inside the press, with the picture still on its way.
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("This window can't copy pictures. Use Export.");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png() })]);
    return "Picture copied";
  });
  const canNativeShare = !!navigator.canShare?.({ files: [new File([""], "x.png", { type: "image/png" })] });
  const shareItems: Item[] = [
    { label: "Copy picture", run: copyImage },
    { label: "Copy as text", run: () => attempt("Copying…", async () => {
      const f = flat();
      await navigator.clipboard.writeText(delimited(f.columns, f.rows, "\t"));
      return "Copied: it pastes into a spreadsheet";
    }) },
    { label: "Send to Telegram", run: () => attempt("Sending…", async () => {
      await sendFile(nameOf(ev.title, "png"), await png(), ev.title);
      return "Sent to your Telegram";
    }) },
    ...(canNativeShare ? [{ label: "Share…", run: () => attempt("Drawing…", async () => {
      await navigator.share({ title: ev.title, files: [new File([await png()], nameOf(ev.title, "png"), { type: "image/png" })] });
      return "Shared";
    }) }] : []),
  ];
  const save = () => attempt("Saving…", async () => {
    if (!session) throw new Error("Open a chat in a project to keep this.");
    await saveView(session, ev);
    setSavedHere(true);
    window.dispatchEvent(new Event("mystical:saved-views"));
    return "Saved to this project's views";
  });
  const panel = (
    <section className="dv" data-view={ev.view} data-full={full || undefined}>
      <header className="dv-head">
        <h4>{ev.title}</h4>
        <div className="dv-tools">
          {said ? <span className="dv-said" role="status">{said}</span> : null}
          {ev.view === "table" && sheet.rows.length > 8 ? <input className="dv-filter" type="search" placeholder="Filter" aria-label="Filter rows" value={st.q} onChange={(e) => st.setQ(e.target.value)} /> : null}
          {ev.view === "chart" ? <button type="button" className="dv-btn" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{asTable ? "CHART" : "TABLE"}</button> : null}
          {savedId ? <button type="button" className="dv-btn" onClick={() => onRemove?.(savedId)}>REMOVE</button>
            : <button type="button" className="dv-btn" disabled={savedHere} onClick={() => void save()}>{savedHere ? "SAVED" : "SAVE"}</button>}
          <ToolMenu label="SHARE" items={shareItems} />
          <ToolMenu label={canDownload() ? "EXPORT" : "EXPORT TO TELEGRAM"} items={exportItems} />
          {ev.view !== "stats" ? <button type="button" className="dv-btn" onClick={() => setFull((v) => !v)}>{full ? "CLOSE" : "EXPAND"}</button> : null}
        </div>
      </header>
      {ev.caption ? <p className="dv-caption">{ev.caption}</p> : null}
      <div className="dv-body"><Body ev={ev} sheet={sheet} st={st} full={full} asTable={asTable} /></div>
      <Foot ev={ev} st={st} total={sheet.rows.length} />
      {printing ? <PrintCopy ev={ev} sheet={sheet} st={st} asTable={asTable} onDone={printing} /> : null}
    </section>
  );
  return full ? createPortal(panel, document.body) : panel;
}

class Quiet extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="dv-failed">Couldn't draw {this.props.title || "this view"}.</div> : this.props.children;
  }
}

export function DataView({ ev, savedId, onRemove }: { ev: DataEv; savedId?: string; onRemove?: (id: string) => void }) {
  return <Quiet title={ev.title}><Frame ev={ev} savedId={savedId} onRemove={onRemove} /></Quiet>;
}
