import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { ArrowUp, Bot, Check, ChevronRight, Copy, CornerDownLeft, GitCommitHorizontal, GitMerge, GitPullRequest, Hand, ListEnd, Search, Shrink, SkipForward, X, Zap } from "lucide-react";
import { api, type Meter, type MeterItem, type MeterWho } from "../../api";
import { activeOf, type Turn } from "../../chat";
import { useAiFeatures } from "../../lib/ai";
import { ckId, fmtElapsed, turnRows, type TurnRow } from "../../lib/checkpoints";
import { flowView, movesElsewhere, type Flow, type FlowSet } from "../../lib/flowview";
import { FLOW_EVENT, flowChanged } from "../../lib/useFlow";
import { KIND, ZONE, bands, calm, clock, kindRows, stepLine, stepStats, timeOf, toNow } from "../../lib/meter";
import { moments, type Moment } from "../../lib/moments";
import { openAgent } from "../../lib/subagents";
import { hhmm, useClock12 } from "../../lib/surfaces";
import { fmtTokens } from "../../lib/week";
import type { TranscriptNav } from "../Transcript";
import { SteerIcon } from "../Composer";
import { TabKick } from "./TabKick";

// Which sections are open, kept across sessions. FLOW starts open, the numbers start folded.
const FOLDS = "hud-session-folds";
const OPEN0 = { flow: true, time: false, onwhat: false, helpers: false };
type Fold = keyof typeof OPEN0;
function readOpen(): Record<Fold, boolean> {
  try { return { ...OPEN0, ...JSON.parse(localStorage.getItem(FOLDS) || "{}") }; } catch { return OPEN0; }
}

// Where a jump parks a turn: under the header island (Transcript's scroll-mt-[86px]).
const AIM = 86;

/** The row of the turn on screen: the last one whose prompt has reached the
 *  line a jump parks a turn on, or the last row once the chat is scrolled to
 *  its end. A mounted turn is read off its own rect — what is on screen — and
 *  only one the virtualizer hasn't drawn off its offset, which is built from
 *  estimated heights. A turn behind the tail cut has neither and never counts. */
export function readingRow(rows: TurnRow[], root: HTMLElement | null, nav?: TranscriptNav | null): number {
  if (!root || !rows.length) return -1;
  if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) return rows.length - 1;
  const line = root.getBoundingClientRect().top + AIM + 8;
  const scrollTop = root.scrollTop + 8;
  let idx = -1, first = -1;
  rows.forEach((r, i) => {
    const el = document.getElementById(ckId(r.id));
    const y = el ? null : nav?.turnTop(r.id);
    if (!el && y == null) return;          // behind the tail cut: not on screen at all
    if (first < 0) first = i;
    if (el ? el.getBoundingClientRect().top <= line : y! <= scrollTop) idx = i;
  });
  // Nothing has reached the line yet (the top of what's loaded sits under the
  // LOAD OLDER bar): the first turn drawn is the one you're reading.
  return idx >= 0 ? idx : first;
}

/** Where ⌥↑ / ⌥↓ go from the turn on screen: the next one down, or the one
 *  before — unless you're partway down this one, which takes you to its start. */
export function stepRow(rows: TurnRow[], root: HTMLElement | null, nav: TranscriptNav | null, dir: -1 | 1): string | null {
  const at = readingRow(rows, root, nav);
  if (at < 0 || !root) return null;
  const el = document.getElementById(ckId(rows[at].id));
  const into = !!el && el.getBoundingClientRect().top < root.getBoundingClientRect().top + AIM - 40;
  return (dir < 0 ? (into ? rows[at] : rows[at - 1]) : rows[at + 1])?.id ?? null;
}

// The right rail's panel frame, as GitPanel and UsagePanel draw it.
export const FRAME = { border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)",
  display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } as const;
// The rule under the header, as the other tabs draw it: the hero's top edge starts right under it.
export const RULE = { height: 1, background: "linear-gradient(90deg,var(--acc),transparent)", flex: "none" } as const;

const WHO: [MeterWho, string][] = [["claude", "Claude"], ["tools", "tools"], ["helpers", "helpers"], ["you", "waiting on you"], ["away", "away"]];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const at = (t: number, day: boolean) => `${day ? DAY[new Date(t * 1000).getDay()] + " " : ""}${hhmm(t)}`;
const long = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const tok = (n: number) => fmtTokens(Math.round(n));

function glyph(m: Moment): ReactNode {
  if (m.kind === "ask") return "?";
  if (m.kind === "steer") return <SteerIcon size={9} />;
  const I = m.kind === "commit" ? GitCommitHorizontal : m.kind === "merge" ? GitMerge : m.kind === "push" ? ArrowUp
    : m.kind === "pr" ? GitPullRequest : m.tone === "ok" ? Check : X;
  return <I size={9} strokeWidth={2.8} aria-hidden />;
}

function marked(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{marked(text.slice(i + q.length), q)}</>;
}

function hit(r: TurnRow, q: string): boolean {
  if (!q) return true;
  const words = [r.prompt, r.answer, ...r.subs.map((s) => s.kind === "question" ? `${s.label} ${s.pick ?? ""} ${s.note ?? ""}` : s.kind === "steer" ? s.label : "")];
  return words.some((w) => w.toLowerCase().includes(q));
}

type Path = ReturnType<typeof flowView> & { at: number };

// A band's name as it fits: whole, else its first word ("BUILD HERE" → "BUILD"), else none.
const fit = (label: string, w: number) => [label, label.split(" ")[0]].find((l) => l && 12 + l.length * 5.6 <= w) ?? "";

/** A prompt in its row: a skill command reads as its name, then its words. */
function promptLine(prompt: string, q: string): ReactNode {
  const cmd = /^\/(?:mattpocock-skills:)?([\w-]+)\s*([\s\S]*)$/.exec(prompt.trim());
  if (!cmd) return marked(prompt || "(no words)", q);
  return <><span className="ss-cmd">{cmd[1]}</span>{cmd[2] && <> · {marked(cmd[2], q)}</>}</>;
}

/** The hero: the window on the clock, one step per request, the 150k zone, a
 *  strip of who was working under it and the path's steps (or the turns) as
 *  bands; a wait over half an hour folds into a break (lib/meter clock). */
function Curve({ meter, turns, rows, path, live, now, width, max }: {
  meter: Meter; turns: Turn[]; rows: TurnRow[]; path: Path | null; live: boolean; now: number; width: number; max: number;
}) {
  const W = Math.max(160, width), CH = 62, SY = CH + 4, SH = 6, BY = SY + SH + 3, BH = 14, AY = BY + BH + 10;
  const next = path?.stations.find((s) => s.state !== "done" && s.state !== "now");
  const ghost = live && next ? 0.14 : 0;
  const span = W * (1 - ghost) - (live && !ghost ? 7 : 0);   // room for the live dot at the end
  const segs = toNow(meter.segs, now, live);
  if (!segs.length) return null;
  const c = clock(segs, span);
  const series = meter.series;
  const peak = series.reduce((m, [, v]) => Math.max(m, v), 0);
  const ymax = Math.min(max, Math.max(ZONE * 1.25, peak * 1.1));
  const y = (v: number) => 3 + (CH - 3) * (1 - Math.min(v, ymax) / ymax);
  const endX = live ? c.end : c.at(series[series.length - 1][0]);
  const d = stepLine(series, c.at, y, endX);
  const x0 = c.at(series[0][0]);
  const z = y(ZONE);
  const zoneLeft = y(series[0][1]) > z + 10;   // the line starts under the zone: room above it at the left
  const multiDay = new Date(segs[0][0] * 1000).toDateString() !== new Date((segs.at(-1)?.[1] ?? now) * 1000).toDateString();
  const bs = bands(turns, rows, path ? { stations: path.stations, at: path.at } : null);
  const label = `Window ${tok(meter.window.total)} of ${tok(max)}, ${tok(peak)} at its peak.`;
  return (
    <svg className="ss-curve" width={W} height={AY + 3} viewBox={`0 0 ${W} ${AY + 3}`} role="img" aria-label={label}>
      <defs>
        <linearGradient id="ss-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="ss-a0" /><stop offset="1" className="ss-a1" /></linearGradient>
        <pattern id="ss-fold" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" className="ss-f0" /><rect width="1.4" height="4" className="ss-f1" /></pattern>
      </defs>
      <line x1="0" x2={W} y1={CH} y2={CH} className="ss-base" />
      <path d={`${d}V${CH}H${x0.toFixed(1)}Z`} fill="url(#ss-area)" />
      <path d={d} className="ss-line" />
      {ZONE < ymax && <>
        <line x1="0" x2={span} y1={z} y2={z} className="ss-zone" />
        <text x={zoneLeft ? 2 : span - 2} y={z - 3} textAnchor={zoneLeft ? "start" : "end"} className="ss-zt">150k zone</text>
      </>}
      {c.marks.filter((m) => m.fold).map((m) => (
        <g key={m.a}>
          <rect x={m.x0 + 3} y="0" width={m.x1 - m.x0 - 6} height={CH} className="ss-gap" />
          <path d={`M${m.x0 + 4},1 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4`} className="ss-cut" />
          <path d={`M${m.x1 - 7},1 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4 l-3,4 l3,4`} className="ss-cut" />
          <text x={m.x0 - 2} y={AY} textAnchor="end" className="ss-ft">{long(m.b - m.a)} {m.who === "you" ? "on you" : "away"} ⏸</text>
        </g>
      ))}
      {calm(c.marks).map((m) => m.fold
        ? <rect key={m.a} x={m.x0 + 2} y={SY - 1} width={Math.max(1, m.x1 - m.x0 - 4)} height={SH + 2} rx="1" fill="url(#ss-fold)" />
        : <rect key={m.a} x={m.x0} y={SY} width={Math.max(0.6, m.x1 - m.x0)} height={SH} className={`ss-w-${m.who}`} />)}
      {bs.map((b) => {
        const a = c.at(b.from) + 0.5, e = b.to == null ? endX : c.at(b.to);
        return (
          <g key={b.from}>
            <rect x={a} y={BY} width={Math.max(2, e - a - 1.5)} height={BH} rx="3" className={`ss-b-${b.tone}`} />
            {fit(b.label, e - a) && <text x={a + 5} y={BY + 10} className={`ss-bt-${b.tone}`}>{fit(b.label, e - a)}</text>}
          </g>
        );
      })}
      {ghost > 0 && next && <>
        <rect x={span + 2} y={BY} width={W - span - 2.5} height={BH} rx="3" className="ss-b-next" />
        <text x={span + 6} y={BY + 10} className="ss-bt-next">{next.label.toUpperCase()}</text>
      </>}
      {meter.compactions.map(([t]) => (
        <g key={t} transform={`translate(${c.at(t) - 6.5},${Math.min(CH - 14, z + 5)})`} className="ss-cmp">
          <rect width="13" height="13" rx="3" /><Shrink x="2" y="2" width="9" height="9" strokeWidth={2.6} />
        </g>
      ))}
      {live && <><circle cx={c.end} cy={y(series[series.length - 1][1])} r="6.5" className="ss-now0" /><circle cx={c.end} cy={y(series[series.length - 1][1])} r="3" className="ss-now1" /></>}
      <text x="0" y={AY} className="ss-axis">{at(segs[0][0], multiDay)}</text>
      <text x={endX} y={AY} textAnchor="end" className="ss-axis">{live ? `now ${hhmm(now)}` : at(series[series.length - 1][0], multiDay)}</text>
    </svg>
  );
}

/** The SESSION tab (design .mystical/design-drafts/session-tab, B · CURVE round
 *  2): the window on the clock with who was working under it, TIME, ON WHAT (the
 *  window now, or what the session spent, by kind, each kind opening its biggest
 *  items), HELPERS, then your turns with their moments, time and spend, and the
 *  path's next step. Numbers come from bridge/meter.py (the CLI's transcript);
 *  the path from GET /local/flow. TURNS and FLOW were two tabs before this. */
export function SessionPanel({
  sessionId, turns, scrollRef, nav, following, max, onJump, onLatest, onCopy, onReuse, onCompact,
}: {
  sessionId: string | null;
  turns: Turn[];
  scrollRef: RefObject<HTMLDivElement | null>;
  nav: MutableRefObject<TranscriptNav | null>;
  /** The transcript is pinned to the newest turn. */
  following: boolean;
  /** What the window holds at most (the session's ctx_window). */
  max: number;
  /** Scroll the chat to a turn, or to an anchor inside it (an ask, a steer). */
  onJump: (turnId: string, key?: string) => void;
  onLatest: () => void;
  onCopy: (text: string) => void;
  /** Put a prompt back in the box — it never sends. */
  onReuse: (text: string) => void;
  /** Send /compact (queued behind a running turn). */
  onCompact: () => void;
}) {
  useClock12();
  const running = turns.some((t) => t.status === "running");
  const [now, setNow] = useState(() => Date.now() / 1000);
  const rows = useMemo(() => turnRows(turns, now), [turns, now]);
  // Off the turns alone: a running turn's clock changes no moment.
  const said = useMemo(() => new Map(turnRows(turns).map((r) => [r.id, moments(r, turns)])), [turns]);

  const ai = useAiFeatures();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [flowRead, setFlowRead] = useState(false);   // "no path" only once the bridge said so
  const [set, setSet] = useState<FlowSet | null>(null);
  const [meter, setMeter] = useState<Meter | null>(null);
  const [reread, setReread] = useState(0);   // bumped to read the path again, after a Skip
  // Tickets build and merge, and the council reviews, in sessions of their own: no turn
  // here says when they move.
  const busy = running || movesElsewhere(flow, set, !!ai.nextstep);
  // Read on a turn's edges, and every few seconds while one runs: a path moves
  // mid-turn (StepDone), and the window grows request by request.
  useEffect(() => {
    if (!sessionId) { setFlow(null); setSet(null); setMeter(null); return; }
    let live = true;
    const read = () => {
      api.getMeter(sessionId).then((m) => { if (live) setMeter((m as Partial<Meter>).series?.length ? (m as Meter) : null); }).catch(() => {});
      if (ai.router) api.getFlow(sessionId).then((r) => { if (live) { setFlow(r.flow); setSet(r.set ?? null); setFlowRead(true); } }).catch(() => {});
    };
    read();
    if (!busy) return () => { live = false; };
    const id = setInterval(() => { setNow(Date.now() / 1000); read(); }, 4000);
    return () => { live = false; clearInterval(id); };
  }, [sessionId, busy, ai.router, reread]);
  // Another session's path never shows under this one while its own loads.
  useEffect(() => { setFlow(null); setSet(null); setFlowRead(false); }, [sessionId]);
  // A change from the prompt box's FLOW chip shows here at once.
  useEffect(() => {
    const heard = (e: Event) => {
      const d = (e as CustomEvent<{ session: string; flow: Flow }>).detail;
      if (d.session === sessionId) setFlow(d.flow);
    };
    window.addEventListener(FLOW_EVENT, heard);
    return () => window.removeEventListener(FLOW_EVENT, heard);
  }, [sessionId]);
  // The clock and the strip run on between reads.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [running]);
  const v = useMemo(() => flowView(flow, turns, set, !!ai.ticketruns), [flow, turns, set, ai.ticketruns]);
  const path: Path | null = flow && v.stations.length ? { ...v, at: flow.at } : null;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [reading, setReading] = useState(-1);
  useEffect(() => {
    let raf = 0;
    const read = () => { raf = 0; setReading(readingRow(rowsRef.current, scrollRef.current, nav.current)); };
    // Caught on the way down from the document, not bound to the scroller: the
    // chat unmounts it in HIST and NEXT and comes back with a new one.
    const onScroll = (e: Event) => { if (e.target === scrollRef.current && !raf) raf = requestAnimationFrame(read); };
    raf = requestAnimationFrame(read);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => { document.removeEventListener("scroll", onScroll, { capture: true }); cancelAnimationFrame(raf); };
  }, [scrollRef, nav, turns]);

  // The hero draws to its own width: the rail's seam resizes it. A callback ref,
  // because the hero mounts whenever both the turns and the meter are in, in either order.
  const [width, setWidth] = useState(275);
  const watch = useRef<ResizeObserver | null>(null);
  const heroRef = useCallback((el: HTMLDivElement | null) => {
    watch.current?.disconnect();
    watch.current = null;
    if (!el) return;
    watch.current = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.current.observe(el);
  }, []);

  const [open, setOpen] = useState(readOpen);
  const flip = (k: Fold) => setOpen((o) => {
    const next = { ...o, [k]: !o[k] };
    try { localStorage.setItem(FOLDS, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  /** A section's header: a button that folds what's under it; `shut` shows only while folded. */
  const head = (k: Fold, name: string, tag: ReactNode, right: ReactNode, shut?: ReactNode, title?: string) => (
    <button type="button" className={`ss-lbl ss-fold${open[k] ? " open" : ""}`} aria-expanded={open[k]} onClick={() => flip(k)} title={title}>
      <ChevronRight size={11} strokeWidth={2.6} className="ss-fc" aria-hidden />{name}
      {tag != null && tag !== false && <span className="ss-tag">{tag}</span>}
      {(right || (!open[k] && shut)) && <span className="ss-r">{right}{!open[k] && shut}</span>}
    </button>
  );
  const [lens, setLens] = useState<"window" | "spent">("window");
  const [opened, setOpened] = useState<string | null>(null);
  const [allHelpers, setAllHelpers] = useState(false);
  const [find, setFind] = useState<string | null>(null);
  const [pickAt, setSel] = useState(0);
  const q = (find ?? "").trim().toLowerCase();
  const newest = rows.map((r, i) => ({ r, i })).reverse();
  const shown = find === null ? newest : newest.filter(({ r }) => hit(r, q));
  const sel = Math.min(pickAt, shown.length - 1);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (find === null) return;
    listRef.current?.querySelector<HTMLElement>(".ss-t.sel")?.scrollIntoView({ block: "nearest" });
  }, [find === null, sel, q]);

  const tools = (
    <>
      <button className={`gp-ib${find !== null ? " on" : ""}`} title="find a turn" aria-label="find a turn"
        onClick={() => { setFind(find === null ? "" : null); setSel(0); }}><Search size={14} /></button>
      <button className={`gp-ib${following ? " on" : ""}`} title={following ? "on the latest turn" : "go to the latest turn"}
        aria-label="go to the latest turn" onClick={onLatest}><ListEnd size={14} /></button>
    </>
  );
  if (!rows.length)
    return (
      <div className="panel gp tn ss" style={FRAME}>
        <TabKick name="SESSION" tools={tools} />
        <div className="tn-none">no turns yet — speak, and the first lands here.</div>
      </div>
    );

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setFind(null); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const m = shown[sel]; if (m) onJump(m.r.id); }
  };

  // The now bar: only the latest turn can run, and only a running one waits on you.
  const last = rows[rows.length - 1];
  const live = last.status === "running" ? last : null;
  const wants = activeOf(turns)?.pending[0];
  const ask = live?.subs.find((s) => s.kind === "question" && s.open);
  const bar = live && find === null && (live.waiting ? (
    <div className="tn-now ask">
      <span className="tn-nq" aria-hidden>?</span>
      <span className="tn-nt">Turn {live.n} waits on you
        {wants && <small>{wants.kind === "question" ? wants.questions?.[0]?.question
          : wants.kind === "secret" ? `Needs a secret: ${wants.summary}`
          : `Allow ${wants.tool_name}${wants.summary ? `: ${wants.summary}` : "?"}`}</small>}</span>
      <button type="button" onClick={() => (ask?.kind === "question" ? onJump(ask.turnId, ask.key) : onLatest())}>Answer ›</button>
    </div>
  ) : (
    <div className="tn-now run">
      <span className="tn-dot" aria-hidden />
      <span className="tn-nt">Turn {live.n} is working
        <small>{fmtElapsed(live.secs ?? 0)} · {meter?.helpers.some((h) => h.running)
          ? `${meter.helpers.filter((h) => h.running).length} ${meter.helpers.filter((h) => h.running).length === 1 ? "helper" : "helpers"} running`
          : `${live.tools} ${live.tools === 1 ? "tool" : "tools"} so far`}</small></span>
      <button type="button" onClick={onLatest}>Go to it ›</button>
    </div>
  ));

  const win = meter?.window.total ?? 0;
  const peak = meter?.series.reduce((m, [, w]) => Math.max(m, w), 0) ?? 0;
  const hero = meter && (
    <div className="ss-hero" ref={heroRef}>
      <div className="ss-top">
        <span className="ss-k">WINDOW</span><b>{tok(win)}</b><span>of {tok(max)}</span>
        {win >= ZONE && sessionId
          ? <button type="button" className="ss-compact" onClick={onCompact} title={running ? "compacts after this turn" : "summarise the session so far and start the window again"}>
              <Shrink size={11} strokeWidth={2.2} aria-hidden /> Compact</button>
          : peak > win * 1.2 && <span className="ss-r">peaked {tok(peak)}</span>}
      </div>
      <Curve meter={meter} turns={turns} rows={rows} path={path} live={running} now={now} width={width} max={max} />
    </div>
  );

  const segs = meter ? toNow(meter.segs, now, running) : [];
  const time = timeOf(segs);
  const all = WHO.reduce((s, [w]) => s + time[w], 0);
  const worked = time.claude + time.tools + time.helpers;
  const timeBlock = meter && all > 0 && (
    <>
      {head("time", "TIME", open.time && long(all), <>worked <b>{long(worked)}</b></>)}
      {open.time && <><div className="ss-tbar" role="img" aria-label={WHO.map(([w, n]) => `${n} ${fmtElapsed(time[w])}`).join(", ")}>
        {WHO.map(([w]) => time[w] > 0 && <i key={w} className={`ss-w-${w}`} style={{ width: `${(time[w] / all) * 100}%` }} />)}
      </div>
      <div className="ss-tleg">
        {WHO.map(([w, n]) => <span key={w}><i className={`ss-dot ss-w-${w}`} />{n}<em>{fmtElapsed(time[w])}</em></span>)}
      </div></>}
    </>
  );

  const lensRows = (which: "window" | "spent") => {
    if (!meter) return null;
    const kinds = kindRows(which === "window" ? meter.window.kinds : meter.spent.kinds);
    const top = kinds[0]?.tokens || 1;
    const items = (k: { kind: string; folded: string[] }): MeterItem[] => (k.folded.length ? k.folded : [k.kind])
      .flatMap((f) => meter.biggest[which][f] ?? []).sort((a, b) => b.tokens - a.tokens).slice(0, 3);
    return (
      <div className={`ss-lens${lens === which ? "" : " off"}`} aria-hidden={lens !== which}>
        {kinds.map((k) => {
          const open = opened === k.kind;
          const list = open ? items(k) : [];
          return (
            <Fragment key={k.kind}>
              <button type="button" className={`ss-kr${open ? " open" : ""}`} tabIndex={lens === which ? 0 : -1}
                aria-expanded={open} onClick={() => setOpened(open ? null : k.kind)}>
                <i className={`ss-dot ss-k-${k.kind}`} /><span className="ss-kn">{KIND[k.kind] ?? k.kind}</span>
                <span className="ss-kb"><i className={`ss-k-${k.kind}`} style={{ width: `${(k.tokens / top) * 100}%` }} /></span>
                <em>{tok(k.tokens)}</em><ChevronRight size={12} className="ss-kc" aria-hidden />
              </button>
              {open && (
                <div className="ss-big">
                  {list.map((it, i) => (
                    <button type="button" key={i} className="ss-bi" disabled={!it.turn} onClick={() => it.turn && onJump(it.turn)}
                      title={it.turn ? "go to the turn it came in" : undefined}>
                      <span className="ss-bx">{it.label}</span>
                      {which === "spent" && it.reads != null && it.size != null && <span className="ss-bw">{tok(it.size)} ×{it.reads}</span>}
                      <em>{tok(it.tokens)}</em>
                    </button>
                  ))}
                  {!list.length && <div className="ss-bi none">nothing big enough to list</div>}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    );
  };
  const onWhat = meter && (
    <>
      {head("onwhat", "ON WHAT", null, null, <>window <b>{tok(meter.window.total)}</b></>)}
      {open.onwhat && <><div className="ss-switch" role="tablist" aria-label="on what">
        {(["window", "spent"] as const).map((w) => (
          <button key={w} type="button" role="tab" aria-selected={lens === w} className={lens === w ? "on" : ""} onClick={() => setLens(w)}>
            {w === "window" ? "WINDOW" : "SPENT"} <em>{tok(w === "window" ? meter.window.total : meter.spent.total)}</em>
          </button>
        ))}
      </div>
      {/* both lenses in one cell: switching never resizes the box */}
      <div className="ss-lenses">{lensRows("window")}{lensRows("spent")}</div></>}
    </>
  );

  const hs = meter?.helpers ?? [];
  const helpers = hs.length > 0 && (
    <>
      {head("helpers", "HELPERS", hs.some((h) => h.running) ? `${hs.filter((h) => h.running).length} running` : `${hs.length} ran`,
        tok(hs.reduce((s, h) => s + h.tokens, 0)))}
      {open.helpers && (allHelpers ? hs : hs.slice(0, 3)).map((h) => (
        <button type="button" key={h.id} className="ss-h" onClick={() => openAgent(h.id)} title="open its run">
          <span className={`ss-hi${h.running ? " run" : ""}`}><Bot size={11} strokeWidth={2.2} aria-hidden /></span>
          <span className="ss-ht">{h.what}</span>
          <small>{fmtElapsed(Math.max(0, (h.running ? now : h.end) - h.start))}</small><em>{tok(h.tokens)}</em>
        </button>
      ))}
      {open.helpers && hs.length > 3 && <button type="button" className="ss-h more" onClick={() => setAllHelpers(!allHelpers)}>
        <span className="ss-hi" /><span className="ss-ht">{allHelpers ? "fewer" : `${hs.length - 3} more`}</span></button>}
    </>
  );

  const spentOf = (r: TurnRow) => meter ? r.ids.reduce((s, id) => s + (meter.turns[id]?.spent ?? 0), 0) : 0;
  const turnList = (
    <>
      {find === null && <div className="ss-lbl">TURNS <span className="ss-r">time · spent</span></div>}
      <div className="ss-turns" ref={listRef}>
        {q && !shown.length && <div className="tn-none">nothing answers to “{find?.trim()}”.</div>}
        {shown.map(({ r, i }, k) => {
          const ms = (said.get(r.id) ?? []).slice(0, 3);
          const ended = r.status === "error" ? "error" : r.stopped ? "stopped" : "";
          const cls = ["ss-t", i === reading && !q && "on", ended && "err", r.status === "running" && (r.waiting ? "ask" : "run"),
                       find !== null && k === sel && "sel"].filter(Boolean).join(" ");
          const spend = spentOf(r);
          return (
            <div key={r.id} className={cls} data-ctx-type="turn" data-ctx-id={r.id} onClick={() => onJump(r.id)}
              onMouseEnter={find !== null ? () => setSel(k) : undefined}>
              <i className="ss-n">{r.n}</i>
              <span className="ss-p">{promptLine(r.prompt, q)}</span>
              <span className="ss-mk">{ms.map((m, j) => (
                <button key={j} type="button" className={`ss-m ${m.tone}`} title={`${m.kind}${m.text ? ` · ${m.text}` : ""}`}
                  onClick={(e) => { e.stopPropagation(); onJump(m.jump, m.key); }}>{glyph(m)}</button>
              ))}</span>
              <small>{ended || (r.secs != null ? fmtElapsed(r.secs) : "")}</small>
              <em>{spend ? tok(spend) : ""}</em>
              <span className="ss-acts">
                <button className="gp-ib" title="copy the prompt" aria-label="copy the prompt"
                  onClick={(e) => { e.stopPropagation(); onCopy(r.prompt); }}><Copy size={12} /></button>
                <button className="gp-ib" title="send again — puts it in the box" aria-label="send again"
                  onClick={(e) => { e.stopPropagation(); onReuse(r.prompt); }}><CornerDownLeft size={12} /></button>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );

  // The path's step after the one running (or the next to start), and AUTO.
  const nxt = path?.stations.find((s) => s.state !== "done" && s.state !== "now");
  const toggle = () => {
    if (!flow || !sessionId) return;
    const on = !flow.auto;
    const was = flow;
    flowChanged(sessionId, { ...flow, auto: on, overrides: flow.overrides && { ...flow.overrides, nextstep: on } });
    api.setFlowAuto(sessionId, on).catch(() => flowChanged(sessionId, was));
  };
  // Skip shows on a REVIEW that isn't running: one that stopped, or never started.
  const skipReview = () => {
    if (sessionId) api.skipReview(sessionId).then(() => setReread((n) => n + 1)).catch(() => {});
  };
  const nextLine = path && flow && find === null && (
    <div className="ss-next" title={`${path.by === "claude" ? "Claude" : "A rule"} picked the ${flow.path === "one" ? "one-skill" : flow.path.replace(/-/g, " ")} path: ${path.why}`}>
      {nxt ? <>NEXT <b>{nxt.label.toUpperCase()}</b>
        <span className="ss-nm">{nxt.who === "you" ? "waits for you" : flow.auto ? (running ? "starts by itself after this turn" : "starts by itself") : "held: you start it"}</span></>
        : <span className="ss-nm">path complete · {path.total} {path.total === 1 ? "step" : "steps"}</span>}
      {nxt?.key === "review" && flow.next?.station === "review" && (
        <button type="button" className="ss-auto caps" onClick={skipReview}
          title="go on to RETRO with the work as it stands, without the council's pass">
          <SkipForward size={11} strokeWidth={2.2} aria-hidden /> Skip
        </button>
      )}
      <button type="button" className={`ss-auto${flow.auto ? " on" : ""}`} aria-pressed={flow.auto} onClick={toggle}
        title={flow.auto ? "steps start by themselves; click to hold" : "held: you start each step; click to release"}>
        {nxt?.who === "you" ? <Hand size={11} strokeWidth={2.2} aria-hidden /> : <Zap size={11} strokeWidth={2.4} aria-hidden />} AUTO
      </button>
    </div>
  );

  // FLOW: the path's steps, each with the time worked on it and what its turns spent.
  // A step with no skill (BUILD, MERGE, the REVIEW after it) runs in sessions of its own: the ticket set's word stands in.
  const stats = meter && path ? stepStats(bands(turns, rows, { stations: path.stations, at: path.at }), segs, turns, meter.turns) : null;
  const away = path?.stations.find((s) => s.skill === null && s.state !== "done")?.key;
  const flowBlock = !path || !flow ? (flowRead || !ai.router) && <div className="ss-lbl">FLOW <span className="ss-tag">no path</span></div> : (
    <>
      {head("flow", "FLOW", flow.path === "one" ? flow.skill ?? "one skill" : flow.path.replace(/-/g, " "),
        path.stations.every((s) => s.state === "done") ? "complete" : <>step <b>{path.step}</b> of {path.total}</>, null,
        `${path.by === "claude" ? "Claude" : "A rule"} picked this path: ${path.why}`)}
      {open.flow && path.why && <div className="ss-why" title={path.why}>{path.by === "claude" ? "Claude" : "A rule"} picked it: {path.why}</div>}
      {open.flow && path.stations.map((s) => {
        const n = stats?.get(s.label.toUpperCase());
        const note = s.key === away ? path.note : undefined;
        return (
          <button type="button" key={s.key} className={`ss-h ss-st ${s.state}${s.skipped ? " skipped" : ""}`} disabled={!n?.turn} onClick={() => n?.turn && onJump(n.turn)}
            title={n?.turn ? "go to the step's first turn" : s.skipped ? "skipped" : undefined}>
            <span className={`ss-hi${s.state === "now" ? " run" : ""}`}>
              {s.skipped ? <SkipForward size={11} strokeWidth={2.2} aria-hidden /> : s.state === "done" ? <Check size={11} strokeWidth={2.6} aria-hidden /> : s.state === "you" ? <Hand size={11} strokeWidth={2.2} aria-hidden />
                : <i className="ss-sd" aria-hidden />}</span>
            <span className="ss-ht">{s.label.toUpperCase()}</span>
            {note ? <small className="ss-sn">{note}</small> : <>
              <small>{n && n.secs > 0 ? fmtElapsed(n.secs) : ""}</small><em>{n?.tokens ? tok(n.tokens) : ""}</em></>}
          </button>
        );
      })}
      {nextLine}
    </>
  );

  return (
    <div className="panel gp tn ss" style={FRAME} onKeyDown={find !== null ? onKey : undefined}>
      <TabKick name="SESSION" chip={<span className="tn-cnt">{rows.length}</span>} tools={tools} />
      {find !== null && (
        <>
          <label className="tn-find">
            <Search size={13} />
            <input autoFocus value={find} placeholder="prompts, answers, asks…" spellCheck={false}
              onChange={(e) => { setFind(e.target.value); setSel(0); }} />
            {q && <em>{shown.length} {shown.length === 1 ? "turn" : "turns"}</em>}
            <button className="gp-ib" title="clear — esc" aria-label="clear" onClick={() => setFind(null)}><X size={13} /></button>
          </label>
          <div className="tn-hint"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> jump · <kbd>esc</kbd> close</div>
        </>
      )}
      {find === null && hero}
      {bar}
      <div className="mscroll">
        {find === null && flowBlock}
        {find === null && timeBlock}
        {find === null && onWhat}
        {find === null && helpers}
        {turnList}
      </div>
    </div>
  );
}
