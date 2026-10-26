import { Fragment, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { Check, ChevronRight, CircleHelp, Copy, CornerDownLeft, ListEnd, ListOrdered, RotateCw, Search, Timer, X } from "lucide-react";
import type { Turn } from "../../chat";
import { ckId, fmtElapsed, turnRows, type Resume, type Sub, type TurnRow } from "../../lib/checkpoints";
import { hhmm, useClock12 } from "../../lib/surfaces";
import { dur } from "../../lib/week";
import { modelName } from "../../models";
import type { TranscriptNav } from "../Transcript";
import { SteerIcon } from "../Composer";

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
  let idx = 0;
  rows.forEach((r, i) => {
    const el = document.getElementById(ckId(r.id));
    if (el) { if (el.getBoundingClientRect().top <= line) idx = i; return; }
    const y = nav?.turnTop(r.id);
    if (y != null && y <= scrollTop) idx = i;
  });
  return idx;
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
const FRAME = { border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)",
  display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } as const;
const CUT: Record<Resume, string> = { limit: "usage limit", restart: "restart", error: "error" };
const AFTER: Record<Resume, string> = { limit: "the usage limit", restart: "a bridge restart", error: "an error" };
const day = (sec: number) => new Date(sec * 1000).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

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

/** The TURNS tab (design: .mystical/design-drafts/turns-tab, B · LEDGER): the
 *  open session's turns as one spine, a node per turn and three even lines each
 *  — what you asked, the first line of what came back, when and how long, over
 *  a bar sized to the session's longest turn. Asks hang off the spine with the
 *  label you picked; the bridge's resumes fold into the turn they carried on.
 *  The turn on screen is lit and follows the transcript's scroll; a tap jumps.
 *  It replaced the header's TURNS dropdown, which closed on every jump and knew
 *  only the turns the chat had loaded. */
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
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const [reading, setReading] = useState(-1);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const read = () => { raf = 0; setReading(readingRow(rowsRef.current, el, nav.current)); };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
    // A frame late on purpose: turns that just landed reach the transcript's
    // nav in its own effect, and a page prepended above a jump can leave the
    // scroll where it was, firing no scroll event to re-read on.
    raf = requestAnimationFrame(read);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [scrollRef, nav, turns]);

  // Keep the lit row in sight with what hangs under it (an ask waiting on you
  // is the part that matters), unless you're browsing the list yourself.
  const listRef = useRef<HTMLDivElement>(null);
  const browsed = useRef(0);
  const subsOf = rows[reading]?.subs.length ?? 0;
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-row="${reading}"]`);
    if (!list || !row || Date.now() - browsed.current < 2500) return;
    let end: HTMLElement = row;
    for (let n = row.nextElementSibling as HTMLElement | null; n?.classList.contains("tn-s"); n = n.nextElementSibling as HTMLElement | null) end = n;
    const top = row.offsetTop - 4, bottom = end.offsetTop + end.offsetHeight + 4;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = Math.min(top, bottom - list.clientHeight);
  }, [reading, subsOf]);

  const [find, setFind] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const q = (find ?? "").trim().toLowerCase();
  const shown = rows.map((r, i) => ({ r, i })).filter(({ r }) => hit(r, q));

  if (!rows.length)
    return (
      <div className="panel gp tn" style={FRAME}>
        <div className="gp-head"><span className="gp-title">TURNS</span></div>
        <div className="tn-none">no turns yet — speak, and the first lands here.</div>
      </div>
    );

  const max = Math.max(1, ...rows.map((r) => r.secs ?? 0));
  const work = rows.reduce((s, r) => s + (r.secs ?? 0), 0);
  const asks = rows.reduce((s, r) => s + r.subs.filter((x) => x.kind === "question").length, 0);
  const waits = rows.filter((r) => r.waiting).length;
  const live = [...rows].reverse().find((r) => r.status === "running");
  const last = rows[rows.length - 1];
  const cut = rows.reduce((s, r) => s + r.resumes.length, 0);
  const ended = last.started != null && last.secs != null ? last.started + last.secs : null;

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

  const status = live
    ? <div className={`gp-rosub ${live.waiting ? "ask" : "run"}`}><span className="tn-dot" />
        <span><b>#{live.n}</b> {live.waiting === "question" ? "asked you a question" : live.waiting === "permission" ? "needs your permission" : "running"}
          {live.secs != null && <> · <b>{fmtElapsed(live.secs)}</b></>}</span></div>
    : <div className="gp-rosub ok"><Check size={13} strokeWidth={2.4} />
        <span>{ended != null ? <>idle since <b>{hhmm(ended)}</b></> : "idle"}
          {cut > 0 && rows.every((r) => !r.resumes.length || r.status === "done") && <> · {cut} cut off, all resumed</>}</span></div>;

  let lastDay = "";
  return (
    <div className="panel gp tn" style={FRAME} onKeyDown={find !== null ? onKey : undefined}>
      <div className="gp-head">
        <span className="gp-title">TURNS</span>
        <span className="tn-cnt">{rows.length}</span>
        <span className="tn-sp" />
        <button className={`gp-ib${find !== null ? " on" : ""}`} title="find a turn" aria-label="find a turn"
          onClick={() => { setFind(find === null ? "" : null); setSel(0); }}><Search size={14} /></button>
        <button className={`gp-ib${following ? " on" : ""}`} title={following ? "on the latest turn" : "go to the latest turn"}
          aria-label="go to the latest turn" onClick={onLatest}><ListEnd size={14} /></button>
      </div>
      {find !== null ? (
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
      ) : (
        <div className="gp-rdw"><div className="gp-rd">
          <div className="gp-ro">
            <div className="gp-roc"><b><ListOrdered size={15} /><span>{rows.length}</span></b><span>turns</span></div>
            <div className="gp-roc"><b><Timer size={15} /><span>{dur(work)}</span></b><span>working</span></div>
            {waits
              ? <div className="gp-roc ask"><b><CircleHelp size={15} /><span>{waits}</span></b><span>waits on you</span></div>
              : <div className="gp-roc"><b><CircleHelp size={15} /><span>{asks}</span></b><span>asks</span></div>}
          </div>
          {status}
        </div></div>
      )}
      <div ref={listRef} className="mscroll tn-list"
        onWheel={() => { browsed.current = Date.now(); }} onPointerDown={() => { browsed.current = Date.now(); }}>
        {q && !shown.length && <div className="tn-none">nothing answers to “{find?.trim()}”.</div>}
        {shown.map(({ r, i }, k) => {
          const d = r.started != null ? day(r.started) : "";
          const head = d && d !== lastDay ? <div className="tn-day">{d}</div> : null;
          if (d) lastDay = d;
          const prevModel = i > 0 ? rows[i - 1].model : null;
          const run = r.status === "running";
          const cls = ["tn-t", i === reading && !q && "on", r.status === "error" && "err", run && !r.waiting && "run",
                       r.waiting && "ask", q && k === sel && "sel"].filter(Boolean).join(" ");
          return (
            <Fragment key={r.id}>
              {head}
              <div className={cls} data-row={i} onClick={() => onJump(r.id)} onMouseEnter={q ? () => setSel(k) : undefined}>
                <span className="tn-o" />
                <div className="tn-l1">
                  <i className="tn-n">{r.n}</i>
                  <span className="tn-p">{marked(r.prompt || "(no words)", q)}</span>
                  <span className="tn-acts">
                    <button className="gp-ib" title="copy the prompt" aria-label="copy the prompt"
                      onClick={(e) => { e.stopPropagation(); onCopy(r.prompt); }}><Copy size={12} /></button>
                    <button className="gp-ib" title="send again — puts it in the box" aria-label="send again"
                      onClick={(e) => { e.stopPropagation(); onReuse(r.prompt); }}><CornerDownLeft size={12} /></button>
                  </span>
                </div>
                {run ? <div className="tn-l2 run">{r.waiting ? "waits on you" : "working"} · {r.tools} {r.tools === 1 ? "tool" : "tools"} so far</div>
                  : r.answer ? <div className="tn-l2"><i>↳</i>{marked(r.answer, q)}</div>
                  : <div className="tn-l2 none">{r.status === "error" ? "no answer — cut off before it finished" : "no answer"}</div>}
                <div className="tn-l3">
                  {r.started != null && <><span>{hhmm(r.started)}</span><span className="s">·</span></>}
                  <span>{r.secs != null ? fmtElapsed(r.secs) : "—"}</span>
                  {r.model && r.model !== prevModel && <span className="tn-tag">{modelName(r.model)}</span>}
                  {r.status === "error" && <span className="tn-tag err">{r.outcome?.toLowerCase() ?? "failed"}</span>}
                  {r.stopped && r.status !== "error" && <span className="tn-tag">stopped</span>}
                  {r.resumes.length > 0 && <span className="tn-tag re"><RotateCw size={9} strokeWidth={2.6} />
                    {r.resumes.length > 1 ? `${r.resumes.length} ${r.resumes.every((x) => x === r.resumes[0]) ? `${CUT[r.resumes[0]]}s` : "resumes"}` : CUT[r.resumes[0]]}</span>}
                  {r.waiting && <span className="tn-tag ask">waits on you</span>}
                  {run && !r.waiting && <span className="tn-tag run">running</span>}
                  {i === reading && !q && <em className="tn-here">reading</em>}
                </div>
                <span className="tn-bar">{r.parts.map((p, j) => <i key={j} style={{ width: `${Math.max(1.2, (p / max) * 100)}%` }} />)}</span>
              </div>
              {r.subs.map((s, j) => <SubRow key={j} s={s} q={q} onJump={onJump} />)}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function SubRow({ s, q, onJump }: { s: Sub; q: string; onJump: (turnId: string, key?: string) => void }) {
  if (s.kind === "resume")
    return (
      <div className="tn-s re" onClick={() => onJump(s.turnId)}>
        <RotateCw size={11} strokeWidth={2.2} />
        <span className="t">resumed after {AFTER[s.why]}{s.at != null && <> · {hhmm(s.at)}</>}</span>
      </div>
    );
  if (s.kind === "steer")
    return (
      <div className="tn-s steer" onClick={() => onJump(s.turnId, s.key)}>
        <SteerIcon size={12} /><span className="t">{marked(s.label, q)}</span>
      </div>
    );
  return (
    <div className={`tn-s${s.open ? " open" : ""}`} onClick={() => onJump(s.turnId, s.key)}>
      <span className="tn-q">?</span>
      <span className="t"><b>{marked(s.label, q)}</b>
        {s.open ? " · waits on you" : s.pick ? <> · {marked(s.pick, q)}</> : s.note ? <> · <span className="note">“{marked(s.note, q)}”</span></> : null}
      </span>
      {s.open && <span className="tn-go">Answer<ChevronRight size={11} strokeWidth={2.4} /></span>}
    </div>
  );
}
