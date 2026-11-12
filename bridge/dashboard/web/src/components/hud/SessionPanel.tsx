import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { ArrowUp, Bot, Check, Copy, CornerDownLeft, GitCommitHorizontal, GitMerge, GitPullRequest, Hand, ListEnd, Search, Shrink, SkipForward, Sparkles, X, Zap } from "lucide-react";
import { api, type Meter, type MeterHelper, type MeterItem, type MeterWho } from "../../api";
import { activeOf, type Turn } from "../../chat";
import { useAiFeatures } from "../../lib/ai";
import { ckId, fmtElapsed, turnRows, type TurnRow } from "../../lib/checkpoints";
import { flowGlobals, flowLabel, flowOf, flowView, movesElsewhere, pastSteps, startedBy, type Flow, type FlowSet, type PastFlow, type StationState } from "../../lib/flowview";
import { useFlowSettings } from "../../lib/flowsettings";
import { FLOW_EVENT, flowChanged } from "../../lib/useFlow";
import { BREAK, KIND, ZONE, bands, calm, clock, flowSpans, helperGroups, kindRows, mixLine, stepLine, stepStarts, stepStats, timeOf, toNow, trackSegs, trackWidths, treemap, type TrackSeg } from "../../lib/meter";
import { moments, type Moment } from "../../lib/moments";
import { openAgent } from "../../lib/subagents";
import { hhmm, useClock12 } from "../../lib/surfaces";
import { fmtTokens } from "../../lib/week";
import type { TranscriptNav } from "../Transcript";
import { FLOW_ICON, SteerIcon } from "../Composer";
import { TabKick } from "./TabKick";

// Which sections are open, kept across sessions. Every one starts folded: a click opens it in place.
const FOLDS = "hud-session-folds";
const OPEN0 = { window: false, flows: false, time: false, onwhat: false, helpers: false };
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
/** A stretch of time as the tab says it: 40s, 12m, 9h 05m. */
const dur = (s: number) => {
  if (s < 59.5) return `${Math.round(s)}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const tok = (n: number) => fmtTokens(Math.round(n));
// A kind as ON WHAT's sentence says it: "files read", but Claude and MCP keep their capitals.
const kindWord = (k: string) => { const n = KIND[k] ?? k; return /^(Claude|MCP)/.test(n) ? n : n[0].toLowerCase() + n.slice(1); };

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

// A band's name as it fits: whole, else its first word ("BUILD HERE" → "BUILD"), else none.
const fit = (label: string, w: number) => [label, label.split(" ")[0]].find((l) => l && 12 + l.length * 5.6 <= w) ?? "";

/** A prompt in its row: a skill command reads as its name, then its words. */
function promptLine(prompt: string, q: string): ReactNode {
  const cmd = /^\/(?:mattpocock-skills:)?([\w-]+)\s*([\s\S]*)$/.exec(prompt.trim());
  if (!cmd) return marked(prompt || "(no words)", q);
  return <><span className="ss-cmd">{cmd[1]}</span>{cmd[2] && <> · {marked(cmd[2], q)}</>}</>;
}

/** A flow's colour class (index.css .sq-f-*): its flow, or one skill. */
const tint = (path: string) => `sq-f-${flowOf(path) ?? "one"}`;
const FlowIcon = ({ path }: { path: string }) => {
  const I = FLOW_ICON[flowOf(path) ?? ""] ?? Sparkles;
  return <I size={11} strokeWidth={2.2} aria-hidden />;
};
/** A step's name, and a flow's, in natural case ("Build here", "Fix", a skill as it is):
 *  `.caps` shouts them where the theme does (CODING_STANDARDS: capitals come from `.caps`). */
const stepName = (key: string) => key[0].toUpperCase() + key.slice(1).replace(/-/g, " ");
const flowName = (f: Pick<Flow, "path" | "skill">) => { const l = flowLabel(f); return l[0] + l.slice(1).toLowerCase(); };

/** A flow under the opened curve: its turns' span, and when each of its steps began. */
type FlowBand = { from: number; to: number; label: string; path: string; active: boolean; starts: number[] };

/** The window on the clock, one step per request, the 150k line and the compactions;
 *  a wait over half an hour folds into a break (lib/meter clock). Slim, as the tab
 *  opens: 40px, the breaks as gaps. Opened: who was working under it, the flows as
 *  bands (their steps as hairlines; the turns while no flow ran) and the clock. */
function Curve({ meter, turns, rows, flowBands, live, now, width, max, slim }: {
  meter: Meter; turns: Turn[]; rows: TurnRow[]; flowBands: FlowBand[]; live: boolean; now: number; width: number; max: number; slim: boolean;
}) {
  const W = Math.max(160, width), CH = slim ? 40 : 62, SY = CH + 4, SH = 6, BY = SY + SH + 3, BH = 14, AY = BY + BH + 11;
  const span = W - (live ? 7 : 0);   // room for the live dot at the end
  const segs = toNow(meter.segs, now, live);
  if (!segs.length) return null;
  const c = clock(segs, span, slim ? 6 : BREAK);
  const series = meter.series;
  const peak = series.reduce((m, [, v]) => Math.max(m, v), 0);
  const ymax = Math.min(max, Math.max(ZONE * 1.25, peak * 1.1));
  const y = (v: number) => 3 + (CH - 3) * (1 - Math.min(v, ymax) / ymax);
  const endX = live ? c.end : c.at(series[series.length - 1][0]);
  const d = stepLine(series, c.at, y, endX);
  const x0 = c.at(series[0][0]);
  const z = y(ZONE);
  // Long waits side by side (on you, then away) read as one break.
  const breaks: { x0: number; x1: number; secs: number; who: MeterWho }[] = [];
  for (const m of c.marks) {
    if (!m.fold) continue;
    const g = breaks[breaks.length - 1];
    if (g && Math.abs(g.x1 - m.x0) < 0.5) { g.x1 = m.x1; g.secs += m.b - m.a; }
    else breaks.push({ x0: m.x0, x1: m.x1, secs: m.b - m.a, who: m.who });
  }
  const multiDay = new Date(segs[0][0] * 1000).toDateString() !== new Date((segs.at(-1)?.[1] ?? now) * 1000).toDateString();
  const first = at(segs[0][0], multiDay), last = live ? `now ${hhmm(now)}` : at(series[series.length - 1][0], multiDay);
  // Only the longest break is named (names of breaks side by side would print on each other),
  // under it, slid in from the ends so it never sits on the clock's two times (~5.2px a character).
  const longest = breaks.reduce<(typeof breaks)[number] | null>((l, b) => (!l || b.secs > l.secs ? b : l), null);
  const named = longest && `${dur(longest.secs)} ${longest.who === "you" ? "on you" : "away"}`;
  const half = named ? named.length * 2.6 : 0;
  const lo = first.length * 5.2 + 6 + half, hi = W - last.length * 5.2 - 6 - half;
  const lx = longest ? Math.min(hi, Math.max(lo, (longest.x0 + longest.x1) / 2)) : 0;
  const turnBands = !slim && !flowBands.length ? bands(turns, rows, null) : [];
  const H = slim ? CH + 2 : AY + 3;
  const label = `Window ${tok(meter.window.total)} of ${tok(max)}, ${tok(peak)} at its peak.`;
  return (
    <svg className="ss-curve" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <defs>
        <linearGradient id="ss-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="ss-a0" /><stop offset="1" className="ss-a1" /></linearGradient>
        <pattern id="ss-fold" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" className="ss-f0" /><rect width="1.4" height="4" className="ss-f1" /></pattern>
      </defs>
      <line x1="0" x2={W} y1={CH} y2={CH} className="ss-base" />
      <path d={`${d}V${CH}H${x0.toFixed(1)}Z`} fill="url(#ss-area)" />
      <path d={d} className="ss-line" />
      {breaks.map((b) => (
        <rect key={b.x0} x={b.x0 + 1} y="0" width={Math.max(1, b.x1 - b.x0 - 2)} height={CH} className={slim ? "ss-gap" : undefined} fill={slim ? undefined : "url(#ss-fold)"} />
      ))}
      {ZONE < ymax && <>
        <line x1="0" x2={span} y1={z} y2={z} className="ss-zone" />
        <text x="1" y={z - 3} className="ss-zt">150k</text>
      </>}
      {meter.compactions.map(([t]) => slim
        ? <path key={t} d={`M${c.at(t) - 3},${CH} l3,-4 l3,4z`} className="ss-tick" />
        : (
          <g key={t} transform={`translate(${c.at(t) - 6.5},${Math.min(CH - 14, z + 5)})`} className="ss-cmp">
            <rect width="13" height="13" rx="3" /><Shrink x="2" y="2" width="9" height="9" strokeWidth={2.6} />
          </g>
        ))}
      {!slim && calm(c.marks).map((m) => m.fold
        ? <rect key={m.a} x={m.x0 + 2} y={SY - 1} width={Math.max(1, m.x1 - m.x0 - 4)} height={SH + 2} rx="1" fill="url(#ss-fold)" />
        : <rect key={m.a} x={m.x0} y={SY} width={Math.max(0.6, m.x1 - m.x0)} height={SH} className={`ss-w-${m.who}`} />)}
      {!slim && flowBands.map((f) => {
        const a = c.at(f.from) + 0.5, w = Math.max(2.5, c.at(f.to) - a - 1.5);
        return (
          <g key={f.from} className={tint(f.path)}>
            <rect x={a} y={BY} width={w} height={BH} rx="3" className={`ss-fb${f.active ? " now" : ""}`} />
            {f.starts.filter((t) => t > f.from).map((t) => <line key={t} x1={c.at(t)} x2={c.at(t)} y1={BY + 2} y2={BY + BH - 2} className="ss-fh" />)}
            {w > 40 && <text x={a + 5} y={BY + 10} className={`ss-bt-flow caps${f.active ? " now" : ""}`}>{f.label}</text>}
          </g>
        );
      })}
      {turnBands.map((b) => {
        const a = c.at(b.from) + 0.5, e = b.to == null ? endX : c.at(b.to);
        return (
          <g key={b.from}>
            <rect x={a} y={BY} width={Math.max(2, e - a - 1.5)} height={BH} rx="3" className={`ss-b-${b.tone}`} />
            {fit(b.label, e - a) && <text x={a + 5} y={BY + 10} className={`ss-bt-${b.tone}`}>{fit(b.label, e - a)}</text>}
          </g>
        );
      })}
      {live && <><circle cx={c.end} cy={y(series[series.length - 1][1])} r="6.5" className="ss-now0" /><circle cx={c.end} cy={y(series[series.length - 1][1])} r="3" className="ss-now1" /></>}
      {!slim && <>
        <text x="0" y={AY} className="ss-axis">{first}</text>
        {named && lo <= hi && <text x={lx} y={AY} textAnchor="middle" className="ss-ft">{named}</text>}
        <text x={W} y={AY} textAnchor="end" className="ss-axis">{last}</text>
      </>}
    </svg>
  );
}

/** TIME's ring: worked, waiting on you and away, round the clock of the session. */
function Dial({ size, w, time, all, center }: { size: number; w: number; time: Record<MeterWho, number>; all: number; center?: string }) {
  const r = size / 2 - w / 2, c = 2 * Math.PI * r, mid = size / 2;
  let off = 0;
  return (
    <svg className="sq-dial" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      {WHO.map(([k]) => {
        const len = all > 0 ? (time[k] / all) * c : 0;
        const arc = len > 0 && <circle key={k} cx={mid} cy={mid} r={r} className={`sq-arc ss-w-${k}`} strokeWidth={w}
          strokeDasharray={`${Math.max(0, len - 1)} ${c}`} strokeDashoffset={-off} transform={`rotate(-90 ${mid} ${mid})`} />;
        off += len;
        return arc;
      })}
      {center && <><text x={mid} y={mid - 1} textAnchor="middle" className="sq-dn">{center}</text>
        <text x={mid} y={mid + 11} textAnchor="middle" className="sq-dw">worked</text></>}
    </svg>
  );
}

/** A stop on an opened flow's line: one of its steps, or for a folded segment one of its runs. */
type StopState = StationState | "skip" | "stopped";
type Stop = { key: string; label: string; state: StopState; secs?: number; tokens?: number; turn: string | null };
const WORD: Partial<Record<StopState, string>> = { skip: "skipped", stopped: "stopped", you: "on you", now: "running", done: "done" };

/** An opened flow's steps (or a folded flow's runs) as stops on a line, each with what it took. */
function Metro({ stops, onJump }: { stops: Stop[]; onJump: (turnId: string) => void }) {
  // Past five a line can't hold the names: the stops go on two lines.
  const per = stops.length > 5 ? Math.ceil(stops.length / 2) : stops.length;
  const lines: Stop[][] = [];
  for (let i = 0; i < stops.length; i += per) lines.push(stops.slice(i, i + per));
  return <>{lines.map((line, k) => (
    <div key={k} className="sq-metro" style={{ gridTemplateColumns: `repeat(${per}, 1fr)`, "--l": `${50 / per}%`, "--r": `${((per - line.length + 0.5) / per) * 100}%` } as CSSProperties}>
      {line.map((n) => (
        <button key={n.key} type="button" className={`sq-mn ${n.state}`} disabled={!n.turn} onClick={() => n.turn && onJump(n.turn)}
          title={n.turn ? "go to its first turn" : undefined}>
          <span className="sq-md">{n.state === "done" ? <Check size={9} strokeWidth={3} aria-hidden /> : n.state === "skip" ? <SkipForward size={8} strokeWidth={2.4} aria-hidden />
            : n.state === "you" ? <Hand size={8} strokeWidth={2.4} aria-hidden /> : null}</span>
          <span className="sq-ml caps">{n.label}</span>
          {n.secs ? <><span className="sq-mt">{dur(n.secs)}</span>{!!n.tokens && <span className="sq-mk">{tok(n.tokens)}</span>}</>
            : <span className="sq-mt">{WORD[n.state] ?? "next"}</span>}
        </button>
      ))}
    </div>
  ))}</>;
}

/** The SESSION tab, quiet at first glance (docs/superpowers/specs/session-tab.md:
 *  HORIZON · TRACK · DIAL · BLOCKS · BY FLOW · QUIET ROWS): each section says one thing
 *  until a click opens it in place. WINDOW is a slim curve and its number; FLOWS a track
 *  of every flow the session ran, the active one striped, a segment opening its steps;
 *  TIME a ring; ON WHAT a sentence over blocks; HELPERS a face pile over the helpers by
 *  the flow that started them; then your turns, their extras on hover. Numbers come from
 *  bridge/meter.py (the CLI's transcript), the flows from GET /local/flow. */
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
  const [past, setPast] = useState<PastFlow[]>([]);
  const [flowRead, setFlowRead] = useState(false);   // "none yet" only once the bridge said so
  const [set, setSet] = useState<FlowSet | null>(null);
  const [meter, setMeter] = useState<Meter | null>(null);
  const [reread, setReread] = useState(0);   // bumped to read the flow again, after a Skip
  // Tickets build and merge, and the council reviews, in sessions of their own: no turn
  // here says when they move.
  const glob = flowGlobals(flow, useFlowSettings(), ai);   // the session's flow's NEXT and TICKETS
  const busy = running || movesElsewhere(flow, set, glob.nextstep);
  // Read on a turn's edges, and every few seconds while one runs: a flow moves
  // mid-turn (StepDone), and the window grows request by request.
  useEffect(() => {
    if (!sessionId) { setFlow(null); setPast([]); setSet(null); setMeter(null); return; }
    let live = true;
    const read = () => {
      api.getMeter(sessionId).then((m) => { if (live) setMeter((m as Partial<Meter>).series?.length ? (m as Meter) : null); }).catch(() => {});
      if (ai.router) api.getFlow(sessionId).then((r) => { if (live) { setFlow(r.flow); setPast(r.past ?? []); setSet(r.set ?? null); setFlowRead(true); } }).catch(() => {});
    };
    read();
    if (!busy) return () => { live = false; };
    const id = setInterval(() => { setNow(Date.now() / 1000); read(); }, 4000);
    return () => { live = false; clearInterval(id); };
  }, [sessionId, busy, ai.router, reread]);
  const [pick, setPick] = useState<string | null>(null);   // the FLOWS segment opened
  const [moreOf, setMoreOf] = useState<Record<string, boolean>>({});   // HELPERS groups shown whole
  // Another session's flows never show under this one while its own load.
  useEffect(() => { setFlow(null); setPast([]); setSet(null); setFlowRead(false); setPick(null); setMoreOf({}); }, [sessionId]);
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
  const v = useMemo(() => flowView(flow, turns, set, glob.ticketruns), [flow, turns, set, glob.ticketruns]);

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

  // Every section draws to the hero's width: the rail's seam resizes it. A callback ref,
  // because the hero mounts whenever both the turns and the meter are in, in either order.
  const [width, setWidth] = useState(265);
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
  const [lens, setLens] = useState<"window" | "spent">("window");
  const [opened, setOpened] = useState<string | null>(null);   // the ON WHAT block whose biggest items show
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

  // The flows this session ran, oldest first, the current one last, and what each took.
  const segs = meter ? toNow(meter.segs, now, running) : [];
  const flows: (Flow | PastFlow)[] = flow ? [...past, flow] : past;
  const cur = flow ? flows.length - 1 : -1;   // the current flow's index; the rest are past
  const spans = flowSpans(flows, rows, segs, meter?.turns ?? {}, now);
  const active = !!flow && v.stations.some((s) => s.state !== "done");   // on it until its last step is done
  const stateOf = (i: number) => (i === cur ? (active ? "now" : "done") : (flows[i] as PastFlow).stopped ? "stopped" : "done");
  const stepsOf = (i: number) => (i === cur ? v.stations : pastSteps(flows[i] as PastFlow));
  const firstRow = (i: number) => rows[spans[i].rows[0]] as TurnRow | undefined;
  /** A flow's own turns and their bands, the last band ending where the flow does. */
  const bandsOf = (i: number) => {
    const ids = new Set(spans[i].rows.flatMap((j) => rows[j].ids));
    const ts = turns.filter((t) => ids.has(t.id));
    const bs = bands(ts, [], { stations: stepsOf(i), at: flows[i].at });
    if (bs.length) bs[bs.length - 1].to = spans[i].to;
    return { ts, bs };
  };

  const win = meter?.window.total ?? 0;
  const peak = meter?.series.reduce((m, [, w]) => Math.max(m, w), 0) ?? 0;
  const flowBands: FlowBand[] = flows.flatMap((f, i) => spans[i].rows.length ? [{ from: spans[i].from, to: spans[i].to, label: flowName(f), path: f.path,
    active: stateOf(i) === "now", starts: stepsOf(i).length > 1 ? stepStarts(bandsOf(i).bs) : [] }] : []);
  const hero = meter && (
    <div className={`ss-hero${open.window ? " open" : ""}`} ref={heroRef}>
      <div className="ss-top">
        <button type="button" className="sq-wbtn" aria-expanded={open.window} onClick={() => flip("window")}
          title={open.window ? "fold the curve" : "who was working, the flows and the clock"}>
          <span className="ss-k caps">Window</span><b>{tok(win)}</b><span>of {tok(max)}</span>
        </button>
        {win >= ZONE && sessionId
          ? <button type="button" className="ss-compact" onClick={onCompact} title={running ? "compacts after this turn" : "summarise the session so far and start the window again"}>
              <Shrink size={11} strokeWidth={2.2} aria-hidden /> Compact</button>
          : open.window && peak > win * 1.2 && <span className="ss-r">peaked {tok(peak)}</span>}
      </div>
      {/* the curve opens and folds too; the button above is the keyboard's way in */}
      <div className="sq-curve" onClick={() => flip("window")}>
        <Curve meter={meter} turns={turns} rows={rows} flowBands={flowBands} live={running} now={now} width={width} max={max} slim={!open.window} />
      </div>
      {open.window && <div className="sq-wleg">{WHO.map(([w, n]) => <span key={w}><i className={`ss-dot ss-w-${w}`} />{w === "you" ? "you" : n}</span>)}</div>}
    </div>
  );

  // FLOWS: one segment per flow, sized by the time worked on it; a click opens its steps.
  const track = trackSegs(flows, spans);
  const ws = trackWidths(track.map((g) => g.secs), width);
  const lastOf = (g: TrackSeg) => g.runs[g.runs.length - 1];
  const segName = (g: TrackSeg) => `${flowName(flows[lastOf(g)])}${g.runs.length > 1 ? ` ×${g.runs.length}` : ""}`;
  const openSeg = open.flows ? track.find((g) => g.key === pick) ?? track.find((g) => stateOf(lastOf(g)) === "now") ?? track[track.length - 1] : undefined;
  const tap = (g: TrackSeg) => {
    if (open.flows && openSeg?.key === g.key) { flip("flows"); return; }
    setPick(g.key);
    if (!open.flows) flip("flows");
  };
  // The header names the step the active flow is on: one running or started, else the one it waits to start.
  const underway = v.stations.find((s) => s.state === "now")
    ?? v.stations.find((s) => s.key === flow?.next?.station && flow.next.started && s.state !== "done");
  const onStep = active && v.stations.length > 1 ? underway ?? v.stations.find((s) => s.state !== "done") : undefined;

  // The active flow's NEXT and AUTO, under its steps.
  const nxt = v.stations.find((s) => s.state !== "done" && s.state !== "now");
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
  const nextLine = flow && (
    <div className="ss-next">
      {nxt ? <><span className="caps">Next</span> <b className="caps">{stepName(nxt.key)}</b>
        <span className="ss-nm">{nxt.who === "you" ? "waits for you" : flow.auto ? (running ? "after this turn" : "starts by itself") : "held: you start it"}</span></>
        : <span className="ss-nm">flow complete · {v.total} {v.total === 1 ? "step" : "steps"}</span>}
      {nxt?.key === "review" && flow.next?.station === "review" && (
        <button type="button" className="ss-auto caps" onClick={skipReview}
          title="go on to RETRO with the work as it stands, without the council's pass">
          <SkipForward size={11} strokeWidth={2.2} aria-hidden /> Skip
        </button>
      )}
      <button type="button" className={`ss-auto caps${flow.auto ? " on" : ""}`} aria-pressed={flow.auto} onClick={toggle}
        title={flow.auto ? "steps start by themselves; click to hold" : "held: you start each step; click to release"}>
        {nxt?.who === "you" ? <Hand size={11} strokeWidth={2.2} aria-hidden /> : <Zap size={11} strokeWidth={2.4} aria-hidden />} Auto
      </button>
    </div>
  );

  /** An opened segment: why its flow started, its steps (a folded one's runs) and, on the
   *  active flow, what comes next. */
  const detail = (g: TrackSeg) => {
    const i = lastOf(g);
    const f = flows[i];
    const stopped = i !== cur && (f as PastFlow).stopped;
    let stops: Stop[];
    if (g.runs.length > 1) {
      // a run that never got a turn of its own (replaced inside the turn that set it) has nothing to show
      const ran = g.runs.filter((k) => spans[k].rows.length);
      stops = (ran.length ? ran : g.runs).map((k) => ({ key: String(k), label: firstRow(k) ? `#${firstRow(k)!.n}` : "—", state: stateOf(k),
        secs: spans[k].secs, tokens: spans[k].tokens, turn: firstRow(k)?.id ?? null }));
    } else {
      const { ts, bs } = bandsOf(i);
      const nums = meter ? stepStats(bs, segs, ts, meter.turns) : undefined;
      stops = stepsOf(i).map((s) => {
        const n = nums?.get(s.label.toUpperCase());
        return { key: s.key, label: stepName(s.key), state: s.skipped ? "skip" : s.state, secs: n?.secs, tokens: n?.tokens, turn: n?.turn ?? null };
      });
    }
    // A step with no skill (BUILD, MERGE, the REVIEW after it) runs in sessions of its own: the ticket set's word.
    const away = i === cur && v.note ? v.stations.find((s) => s.skill === null && s.state !== "done") : undefined;
    return (
      <div className="sq-flow">
        <div className="sq-why" title={f.why}><span className="caps">{segName(g)}</span>
          {stopped && <> · stopped at <span className="caps">{stepName(stopped)}</span></>} · {startedBy(f.by, f.why)}</div>
        <Metro stops={stops} onJump={(t) => onJump(t)} />
        {away && <div className="sq-note"><span className="caps">{stepName(away.key)}</span>: {v.note}</div>}
        {i === cur && active && g.runs.length === 1 && nextLine}
      </div>
    );
  };
  const flowsBlock = (flows.length > 0 || (ai.router && flowRead)) && (
    <section className="sq">
      <button type="button" className="sq-head" aria-expanded={open.flows} disabled={!flows.length} onClick={() => flip("flows")}>
        <span className="sq-lab caps">Flows</span>
        <span className="sq-cap">{active && flow ? <><b className="caps">{flowName(flow)}</b>
          {onStep && <> · {onStep === underway ? "on" : "next"} <span className="caps">{stepName(onStep.key)}</span></>}
          {spans[cur].secs > 0 && <> · {dur(spans[cur].secs)}</>}</>
          : flows.length ? "none running" : "none yet"}</span>
      </button>
      {flows.length > 0 && <>
        <div className="sq-track">
          {track.map((g, k) => {
            const st = stateOf(lastOf(g));
            return (
              <button key={g.key} type="button" className={`sq-seg ${st} ${tint(flows[lastOf(g)].path)}${openSeg?.key === g.key ? " sel" : ""}`} style={{ width: ws[k] }}
                aria-pressed={openSeg?.key === g.key} onClick={() => tap(g)}
                title={`${segName(g)}${st === "stopped" ? " · stopped" : st === "now" ? " · running" : ""}${g.secs > 0 ? ` · ${dur(g.secs)}` : ""}`} />
            );
          })}
        </div>
        <div className="sq-tlab" aria-hidden>
          {track.map((g, k) => (
            <span key={g.key} className={stateOf(lastOf(g))} style={{ width: ws[k] }}>
              {ws[k] > 48 ? <span className="caps">{segName(g)}</span> : <FlowIcon path={flows[lastOf(g)].path} />}
              <em>{ws[k] > 30 && g.secs > 0 ? dur(g.secs) : ""}</em>
            </span>
          ))}
        </div>
        {/* every segment's detail in one cell, the others hidden: switching never resizes the box */}
        {openSeg && <div className="sq-details">{track.map((g) => (
          <div key={g.key} className={g.key === openSeg.key ? undefined : "off"} aria-hidden={g.key !== openSeg.key || undefined}>{detail(g)}</div>
        ))}</div>}
      </>}
    </section>
  );

  const time = timeOf(segs);
  const all = WHO.reduce((s, [w]) => s + time[w], 0);
  const worked = time.claude + time.tools + time.helpers;
  const timeBlock = meter && all > 0 && (
    <section className="sq">
      <button type="button" className="sq-head" aria-expanded={open.time} onClick={() => flip("time")}
        aria-label={`time: ${WHO.map(([w, n]) => `${n} ${dur(time[w])}`).join(", ")}`}>
        <span className="sq-lab caps">Time</span>
        <Dial size={20} w={4.5} time={time} all={all} />
        <span className="sq-tv"><b>{dur(worked)}</b> worked of {dur(all)}</span>
      </button>
      {open.time && (
        <div className="sq-dialbig">
          <Dial size={86} w={11} time={time} all={all} center={dur(worked).split(" ")[0]} />
          <div className="sq-dleg">{WHO.map(([w, n]) => <div key={w}><i className={`ss-dot ss-w-${w}`} />{n}<em>{dur(time[w])}</em></div>)}</div>
        </div>
      )}
    </section>
  );

  // ON WHAT: one sentence on what fills the window; opened, the window (or what the session
  // spent) as blocks, a block opening its biggest items.
  const kinds = meter ? kindRows(lens === "window" ? meter.window.kinds : meter.spent.kinds) : [];
  const mix = meter ? mixLine(meter.window.kinds) : [];
  const kw = (k: string) => <b className={`sq-kw ss-k-${k}`}>{kindWord(k)}</b>;
  const blk = kinds.find((k) => k.kind === opened) ?? kinds[0];
  const biggest = blk ? (blk.folded.length ? blk.folded : [blk.kind]).flatMap((f) => meter?.biggest[lens][f] ?? [])
    .sort((a, b) => b.tokens - a.tokens).slice(0, 3) : [];
  const boxes = treemap(kinds.map((k) => k.tokens), width, 132);
  const onWhat = meter && mix.length > 0 && (
    <section className="sq">
      <button type="button" className="sq-head sq-col" aria-expanded={open.onwhat} onClick={() => flip("onwhat")}>
        <span className="sq-lab caps">On what</span>
        <span className="sq-sent">{mix.length === 1 ? <>All {kw(mix[0].kind)}</>
          : <>Mostly {kw(mix[0].kind)} ({mix[0].pct}%), then {kw(mix[1].kind)}{mix[2] && <> and {kw(mix[2].kind)}</>}</>}</span>
      </button>
      {open.onwhat && <>
        <div className="ss-switch" role="tablist" aria-label="on what">
          {(["window", "spent"] as const).map((w) => (
            <button key={w} type="button" role="tab" aria-selected={lens === w} className={`caps${lens === w ? " on" : ""}`} onClick={() => setLens(w)}>
              {w === "window" ? "Window" : "Spent"} <em>{tok(w === "window" ? meter.window.total : meter.spent.total)}</em>
            </button>
          ))}
        </div>
        <div className="sq-tmap">
          {kinds.map((k, i) => {
            const b = boxes[i];
            return (
              <button key={k.kind} type="button" className={`sq-blk ss-k-${k.kind}${blk?.kind === k.kind ? " sel" : ""}`} aria-pressed={blk?.kind === k.kind}
                style={{ left: b.x + 1, top: b.y + 1, width: Math.max(1, b.w - 2), height: Math.max(1, b.h - 2) }}
                title={`${KIND[k.kind] ?? k.kind} · ${tok(k.tokens)}`} onClick={() => setOpened(k.kind)}>
                {b.w > 52 && b.h > 30 ? <><b>{KIND[k.kind] ?? k.kind}</b><em>{tok(k.tokens)}</em></> : b.w > 26 && b.h > 16 ? <em>{tok(k.tokens)}</em> : null}
              </button>
            );
          })}
        </div>
        {blk && (
          <div className="ss-big sq-big">
            {biggest.map((it: MeterItem, i) => (
              <button type="button" key={i} className="ss-bi" disabled={!it.turn} onClick={() => it.turn && onJump(it.turn)}
                title={it.turn ? "go to the turn it came in" : undefined}>
                <span className="ss-bx">{it.label}</span>
                {lens === "spent" && it.reads != null && it.size != null && <span className="ss-bw">{tok(it.size)} ×{it.reads}</span>}
                <em>{tok(it.tokens)}</em>
              </button>
            ))}
            {!biggest.length && <div className="ss-bi none">nothing big enough to list</div>}
          </div>
        )}
      </>}
    </section>
  );

  // HELPERS: a face pile; opened, the helpers under the flow that started them, newest flow first.
  const hs = meter?.helpers ?? [];
  const nRun = hs.filter((h) => h.running).length;
  const grouped = helperGroups(hs, rows, spans, track);
  const flat = grouped.length === 1 && grouped[0][0] < 0;   // no flow ran: one list, no headings
  const faces = [...hs].sort((a, b) => Number(b.running) - Number(a.running) || b.start - a.start).slice(0, 5);
  const helperRow = (h: MeterHelper) => (
    <button type="button" key={h.id} className="ss-h" onClick={() => openAgent(h.id)} title="open its run">
      <span className={`ss-hi${h.running ? " run" : ""}`}><Bot size={11} strokeWidth={2.2} aria-hidden /></span>
      <span className="ss-ht">{h.what}</span>
      <small>{dur(Math.max(0, (h.running ? now : h.end) - h.start))}</small><em>{tok(h.tokens)}</em>
    </button>
  );
  const helpers = hs.length > 0 && (
    <section className="sq">
      <button type="button" className="sq-head" aria-expanded={open.helpers} onClick={() => flip("helpers")}>
        <span className="sq-lab caps">Helpers</span>
        <span className="sq-pile" aria-hidden>{faces.map((h) => <span key={h.id} className={h.running ? "run" : ""}><Bot size={11} strokeWidth={2} /></span>)}</span>
        <span className="sq-hc">{hs.length} ran{nRun > 0 && <> · <b>{nRun} running</b></>}</span>
      </button>
      {open.helpers && grouped.map(([k, list]) => {
        const id = track[k]?.key ?? "", keep = flat ? 3 : 2, whole = !!moreOf[id];
        return (
          <Fragment key={id}>
            {!flat && <div className="sq-grp caps">{k >= 0 ? <><FlowIcon path={flows[lastOf(track[k])].path} />{segName(track[k])}</> : "Outside a flow"}
              <em>{list.length} · {tok(list.reduce((s, h) => s + h.tokens, 0))}</em></div>}
            {(whole ? list : list.slice(0, keep)).map(helperRow)}
            {list.length > keep && <button type="button" className="ss-h more" onClick={() => setMoreOf((m) => ({ ...m, [id]: !whole }))}>
              <span className="ss-hi" /><span className="ss-ht">{whole ? "fewer" : `${list.length - keep} more`}</span></button>}
          </Fragment>
        );
      })}
    </section>
  );

  const spentOf = (r: TurnRow) => meter ? r.ids.reduce((s, id) => s + (meter.turns[id]?.spent ?? 0), 0) : 0;
  const turnList = (
    <>
      {find === null && <div className="ss-lbl caps">Turns</div>}
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
              {/* marks, spend, copy and send again: on hover */}
              <span className="ss-mk">{ms.map((m, j) => (
                <button key={j} type="button" className={`ss-m ${m.tone}`} title={`${m.kind}${m.text ? ` · ${m.text}` : ""}`}
                  onClick={(e) => { e.stopPropagation(); onJump(m.jump, m.key); }}>{glyph(m)}</button>
              ))}</span>
              <small>{ended || (r.secs != null ? fmtElapsed(r.secs) : "")}</small>
              {spend > 0 && <em>{tok(spend)}</em>}
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
        {find === null && flowsBlock}
        {find === null && timeBlock}
        {find === null && onWhat}
        {find === null && helpers}
        {turnList}
      </div>
    </div>
  );
}
