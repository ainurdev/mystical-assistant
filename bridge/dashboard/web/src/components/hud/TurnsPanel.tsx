import { Fragment, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { ArrowUp, Check, Copy, CornerDownLeft, Ellipsis, GitCommitHorizontal, GitMerge, GitPullRequest, ListEnd, Search, X } from "lucide-react";
import { activeOf, type Turn } from "../../chat";
import { ckId, fmtElapsed, turnRows, type TurnRow } from "../../lib/checkpoints";
import { span } from "../../lib/limit";
import { moments, type Moment } from "../../lib/moments";
import { hhmm, useClock12 } from "../../lib/surfaces";
import type { TranscriptNav } from "../Transcript";
import { SteerIcon } from "../Composer";
import { TabKick } from "./TabKick";

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
const day = (sec: number) => new Date(sec * 1000).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
// A turn's length the way the stream says it: 40s, 44m, 1h 21m.
const took = (s: number) => (s < 60 ? `${Math.round(s)}s` : span(s));
// What a moment line says before its text, and how the text joins on.
const SAY: Record<Moment["kind"], [string, string]> = {
  ask: ["asked you", " · "], steer: ["you steered", " · "], commit: ["committed", " "], merge: ["merged", " "],
  push: ["pushed", " "], pr: ["opened PR", " "], tests: ["tests", " · "],
};

function glyph(m: Moment): ReactNode {
  if (m.kind === "ask") return "?";
  if (m.kind === "steer") return <SteerIcon size={10} />;
  const I = m.kind === "commit" ? GitCommitHorizontal : m.kind === "merge" ? GitMerge : m.kind === "push" ? ArrowUp
    : m.kind === "pr" ? GitPullRequest : m.tone === "ok" ? Check : X;
  return <I size={10} strokeWidth={2.6} aria-hidden />;
}

function marked(text: string, q: string): ReactNode {
  if (!q) return text;
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{marked(text.slice(at + q.length), q)}</>;
}

function hit(r: TurnRow, q: string): boolean {
  if (!q) return true;
  const words = [r.prompt, r.answer, ...r.subs.map((s) => s.kind === "question" ? `${s.label} ${s.pick ?? ""} ${s.note ?? ""}` : s.kind === "steer" ? s.label : "")];
  return words.some((w) => w.toLowerCase().includes(q));
}

/** The TURNS tab (spec right-rail-reimagine, Turns · MOMENTS): a now bar while
 *  the latest turn waits on you or works, then the open session's turns newest
 *  first on one line — your prompt heading each, and under it the moments that
 *  mattered (lib/moments): it asked you, committed, merged, pushed, opened a PR,
 *  ran the tests. The three newest turns with moments list up to three
 *  of them, older ones fold theirs into a count; a gap over half an hour says how
 *  long you were away. Every line jumps the chat to its place; the turn on screen
 *  is lit and followed. It replaced the B · LEDGER list and
 *  the TIME dock (the Mini App's spend sheet still reads that breakdown). */
export function TurnsPanel({
  turns, scrollRef, nav, following, onJump, onLatest, onCopy, onReuse,
}: {
  turns: Turn[];
  scrollRef: RefObject<HTMLDivElement | null>;
  nav: MutableRefObject<TranscriptNav | null>;
  /** The transcript is pinned to the newest turn. */
  following: boolean;
  /** Scroll the chat to a turn, or to an anchor inside it (an ask, a steer). */
  onJump: (turnId: string, key?: string) => void;
  onLatest: () => void;
  onCopy: (text: string) => void;
  /** Put a prompt back in the box — it never sends. */
  onReuse: (text: string) => void;
}) {
  useClock12();
  const running = turns.some((t) => t.status === "running");
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [running]);
  const rows = useMemo(() => turnRows(turns, now), [turns, now]);
  // Off the turns alone: a running turn's clock changes no moment, and a long
  // session's Bash calls are megabytes to read every second.
  const said = useMemo(() => new Map(turnRows(turns).map((r) => [r.id, moments(r, turns)])), [turns]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The rows whose moments you unfolded (+N more, N moments).
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());

  const [reading, setReading] = useState(-1);
  useEffect(() => {
    let raf = 0;
    const read = () => { raf = 0; setReading(readingRow(rowsRef.current, scrollRef.current, nav.current)); };
    // Caught on the way down from the document, not bound to the scroller: the
    // chat unmounts it in HIST and NEXT and comes back with a new one.
    const onScroll = (e: Event) => { if (e.target === scrollRef.current && !raf) raf = requestAnimationFrame(read); };
    // A frame late on purpose: turns that just landed reach the transcript's
    // nav in its own effect, and a page prepended above a jump can leave the
    // scroll where it was, firing no scroll event to re-read on.
    raf = requestAnimationFrame(read);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => { document.removeEventListener("scroll", onScroll, { capture: true }); cancelAnimationFrame(raf); };
  }, [scrollRef, nav, turns]);

  // Keep the lit header in sight with the moments under it, unless you're
  // browsing the list yourself.
  const listRef = useRef<HTMLDivElement>(null);
  const browsed = useRef(0);
  const under = said.get(rows[reading]?.id ?? "")?.length ?? 0;
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-row="${reading}"]`);
    if (!list || !row || Date.now() - browsed.current < 2500) return;
    let end: HTMLElement = row;
    for (let n = row.nextElementSibling as HTMLElement | null; n?.classList.contains("tn-m"); n = n.nextElementSibling as HTMLElement | null) end = n;
    const y = (el: HTMLElement) => el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const top = y(row) - 4, bottom = y(end) + end.offsetHeight + 4;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = Math.min(top, bottom - list.clientHeight);
  }, [reading, under]);

  const [find, setFind] = useState<string | null>(null);
  const [pickAt, setSel] = useState(0);
  const q = (find ?? "").trim().toLowerCase();
  const newest = rows.map((r, i) => ({ r, i })).reverse();
  const shown = find === null ? newest : newest.filter(({ r }) => hit(r, q));
  const sel = Math.min(pickAt, shown.length - 1);
  useEffect(() => {
    if (find === null) return;
    listRef.current?.querySelector<HTMLElement>(".tn-h.sel")?.scrollIntoView({ block: "nearest" });
  }, [find === null, sel, q]);

  if (!rows.length)
    return (
      <div className="panel gp tn" style={FRAME}>
        <TabKick name="TURNS" />
        <div className="tn-none">no turns yet — speak, and the first lands here.</div>
      </div>
    );

  const pick = (i: number) => {
    const m = shown[i];
    if (m) onJump(m.r.id);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setFind(null); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(sel); }
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
          : `Allow ${wants.tool_name}${wants.summary ? `: ${wants.summary}` : "?"}`}</small>}</span>
      <button type="button" onClick={() => (ask?.kind === "question" ? onJump(ask.turnId, ask.key) : onLatest())}>Answer ›</button>
    </div>
  ) : (
    <div className="tn-now run">
      <span className="tn-dot" aria-hidden />
      {/* the elapsed on its own line: beside the title and the button it never fits */}
      <span className="tn-nt">Turn {live.n} is working
        <small>{fmtElapsed(live.secs ?? 0)} · {live.tools} {live.tools === 1 ? "tool" : "tools"} so far</small></span>
      <button type="button" onClick={onLatest}>Go to it ›</button>
    </div>
  ));

  // The line between a turn and the one before it: how long you were away,
  // and the day when it changes (the times on the lines are clock times).
  const between = (newer: TurnRow | null, older: TurnRow) => {
    const away = newer?.started != null && older.ended != null ? newer.started - older.ended : 0;
    const d = older.started == null ? "" : day(older.started);
    return [away > 1800 && `away ${span(away)}`, d && d !== day(newer?.started ?? now) && d].filter(Boolean).join(" · ");
  };
  let listing = 0;   // turns with moments that list them: the three newest
  return (
    <div className="panel gp tn" style={FRAME} onKeyDown={find !== null ? onKey : undefined}>
      <TabKick name="TURNS" chip={<span className="tn-cnt">{rows.length}</span>} tools={<>
        <button className={`gp-ib${find !== null ? " on" : ""}`} title="find a turn" aria-label="find a turn"
          onClick={() => { setFind(find === null ? "" : null); setSel(0); }}><Search size={14} /></button>
        <button className={`gp-ib${following ? " on" : ""}`} title={following ? "on the latest turn" : "go to the latest turn"}
          aria-label="go to the latest turn" onClick={onLatest}><ListEnd size={14} /></button>
      </>} />
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
      {bar}
      <div ref={listRef} className="mscroll"
        onWheel={() => { browsed.current = Date.now(); }} onPointerDown={() => { browsed.current = Date.now(); }}>
        {q && !shown.length && <div className="tn-none">nothing answers to “{find?.trim()}”.</div>}
        <div className={`tn-st${find === null && between(null, last) ? " day" : ""}`}>
          {shown.map(({ r, i }, k) => {
            const ms = find === null ? said.get(r.id) ?? [] : [];
            const lists = ms.length > 0 && listing++ < 3;
            const list = unfolded.has(r.id) ? ms : lists ? ms.slice(0, 3) : [];
            const sep = find === null ? between(k ? rows[i + 1] : null, r) : "";
            const ended = r.status === "error" ? "error" : r.stopped ? "stopped" : "";
            const cls = ["tn-h", i === reading && !q && "on", ended && "err", r.status === "running" && (r.waiting ? "ask" : "run"),
                         find !== null && k === sel && "sel"].filter(Boolean).join(" ");
            return (
              <Fragment key={r.id}>
                {sep && <div className="tn-gap">{sep}</div>}
                <div className={cls} data-row={i} data-ctx-type="turn" data-ctx-id={r.id} onClick={() => onJump(r.id)}
                  onMouseEnter={find !== null ? () => setSel(k) : undefined}>
                  <i className="tn-n">{r.n}</i>
                  <span className="tn-p">{marked(r.prompt || "(no words)", q)}</span>
                  <small className="tn-w">{ended || [r.started != null && hhmm(r.started), r.secs != null && took(r.secs)].filter(Boolean).join(" · ")}</small>
                  <span className="tn-acts">
                    <button className="gp-ib" title="copy the prompt" aria-label="copy the prompt"
                      onClick={(e) => { e.stopPropagation(); onCopy(r.prompt); }}><Copy size={12} /></button>
                    <button className="gp-ib" title="send again — puts it in the box" aria-label="send again"
                      onClick={(e) => { e.stopPropagation(); onReuse(r.prompt); }}><CornerDownLeft size={12} /></button>
                  </span>
                </div>
                {list.map((m, j) => (
                  <div key={j} className={`tn-m ${m.tone}`} onClick={() => onJump(m.jump, m.key)}>
                    <span className="tn-i">{glyph(m)}</span>
                    <span className="tn-x"><b>{SAY[m.kind][0]}</b>{m.text && SAY[m.kind][1] + m.text}</span>
                    {m.at != null && <small>{hhmm(m.at)}</small>}
                  </div>
                ))}
                {list.length < ms.length && (
                  <button type="button" className="tn-m more" onClick={() => setUnfolded(new Set(unfolded).add(r.id))}>
                    <span className="tn-i"><Ellipsis size={10} strokeWidth={2.6} aria-hidden /></span>
                    <span className="tn-x">{lists ? `+${ms.length - list.length} more` : `${ms.length} ${ms.length === 1 ? "moment" : "moments"}`}</span>
                  </button>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
