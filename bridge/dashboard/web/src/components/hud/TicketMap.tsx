import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { ChevronDown, ChevronUp, Hand, Maximize2, Minimize2, Radio, RotateCcw, Ticket, Zap } from "lucide-react";
import { api, type SessionStatus, type TicketSet, type TimedEvent } from "../../api";
import { derivePending } from "../../chat";
import { QuestionCard } from "../QuestionCard";
import { dagLayout, kindOf, type Kind } from "../../lib/ticketdag";
import { askConfirm } from "../ui/Ask";

/** A ticket set lives in the flow chat that made it, the super session: a strip docked
 *  above the prompt box (A · WAVES, picked 2026-11-12, .mystical/design-drafts/ticket-map-v2)
 *  and LIVE, its ticket sessions at work inside it (C · LIVE GRID, picked the same day,
 *  .mystical/design-drafts/ticket-flow). LIVE replaced a full-window ticket map: the user
 *  wanted the working sessions shown in the session, not a modal over the app, and the
 *  ticket sessions out of the sidebar (they fold under the super session's row there).
 *  Every ready ticket starts at once, so a graph column (1 + its longest blocker chain) is
 *  a wave that runs together; the strip shows a dot group per wave, what waits on you and
 *  its button, and its chevron opens the graph in place, remembered per set. A ticket's
 *  live state comes from its session (App's status map); the set is polled while the chat
 *  is open, since ticket turns end on the bridge with no dashboard event to announce them. */

const WORD: Record<Kind, string> = { run: "Running", ask: "Asks you", idle: "Stopped", q: "Waiting", done: "Done", fix: "Fix" };
const COLOR: Record<Kind, string> = { run: "var(--acc)", ask: "var(--warn)", idle: "var(--warn)", q: "var(--txl)", done: "var(--ok)", fix: "var(--err)" };
const openKey = (folder: string) => `ticketmap.open:${folder}`;
const busy = (k: Kind) => k === "run" || k === "ask" || k === "idle";   // holds a session right now
const ago = (since?: number) => {
  if (!since) return "";
  const m = Math.max(0, Math.round((Date.now() / 1000 - since) / 60));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};
/** A title in at most two lines of about `n` characters, cut on words. */
function lines(title: string, n: number): [string, string] {
  const words = title.split(/\s+/);
  let a = "";
  while (words.length && (a + " " + words[0]).trim().length <= n) a = (a + " " + words.shift()).trim();
  if (!a) a = words.shift() ?? "";
  const rest = words.join(" ");
  return [a, rest.length > n ? `${rest.slice(0, n - 1)}…` : rest];
}

/** The set as waves: which column each ticket is in, how many columns, and the first one
 *  not yet done (NOW), or -1 once every ticket is done. */
function waves(set: TicketSet, kinds: Record<string, Kind>) {
  const ns = Object.keys(set.tickets).sort();
  const g = dagLayout(ns.map((n) => ({ n, blockedBy: set.tickets[n].blocked_by })));
  const ticketCols = g.cols - 1;   // the last column is MERGE
  const now = Array.from({ length: ticketCols }, (_, c) => c).find((c) => g.nodes.some((x) => x.col === c && kinds[x.n] !== "done")) ?? -1;
  return { g, ticketCols, now };
}

function Graph({ set, kinds, status, big, sel, onPick }: {
  set: TicketSet; kinds: Record<string, Kind>; status: Map<string, SessionStatus>; big?: boolean; sel?: string; onPick: (n: string) => void;
}) {
  const ns = Object.keys(set.tickets).sort();
  const { g, now } = waves(set, kinds);
  const inCol = (c: number) => g.nodes.filter((x) => x.col === c).length;
  const rowsMax = Math.max(1, ...Array.from({ length: g.cols }, (_, c) => inCol(c)));
  // A column is at least 150px (big) so labels never overlap; a wide set scrolls sideways.
  const r = big ? 20 : 13, padX = big ? 80 : 54, top = big ? 44 : 30, W = big ? Math.max(640, 2 * padX + (g.cols - 1) * 150) : 680;
  const H = top + (big ? Math.max(260, rowsMax * 120) : Math.max(56, rowsMax * 40)) + (big ? 30 : 8);
  const colW = g.cols > 1 ? (W - 2 * padX) / (g.cols - 1) : W - 2 * padX;
  const X = (c: number) => (g.cols > 1 ? padX + c * colW : W / 2);
  const pos = Object.fromEntries(g.nodes.map((x) => [x.n, {
    x: X(x.col), y: top + ((H - top - (big ? 30 : 8)) / inCol(x.col)) * (x.row + 0.5),
  }]));
  const merging = set.status === "merging" || set.status === "merged";
  const label = (c: number) => (c === g.cols - 1 ? "MERGE"
    : `WAVE ${c + 1}${g.nodes.every((x) => x.col !== c || kinds[x.n] === "done") ? " ✓" : c === now ? " · NOW" : ""}`);
  return (
    <svg className={`tm-graph${big ? " big" : ""}`} viewBox={`0 0 ${W} ${H}`} style={big ? { "--min-w": `${W}px` } as CSSProperties : undefined}
         role="group" aria-label={`Dependency graph of ${ns.length} tickets in ${g.cols - 1} waves, then merge`}>
      {Array.from({ length: g.cols }, (_, c) => (
        <g key={`w${c}`} className={`tm-wave${c === now ? " now" : ""}`}>
          <rect x={X(c) - colW / 2 + 5} y={top - (big ? 30 : 24)} width={colW - 10} height={H - top + (big ? 22 : 20)} />
          <text x={X(c)} y={top - (big ? 13 : 10)} textAnchor="middle">{label(c)}</text>
        </g>
      ))}
      {g.edges.map((e) => {
        const a = pos[e.from], b = pos[e.to], mx = (a.x + b.x) / 2;
        const done = kinds[e.from] === "done" && (e.to !== "MERGE" || merging);
        const flow = kinds[e.from] === "done" && e.to !== "MERGE" && busy(kinds[e.to]);   // feeding a ticket at work now
        return <path key={`${e.from}>${e.to}`} className={flow ? "tm-flow" : undefined}
                     d={`M${a.x + r} ${a.y} C${mx} ${a.y}, ${mx} ${b.y}, ${b.x - r} ${b.y}`} fill="none"
                     stroke={flow ? "var(--acc)" : done ? "var(--ok)" : "var(--txl)"} strokeOpacity={flow ? 0.8 : done ? 0.5 : 0.3}
                     strokeWidth={big ? 2 : 1.6} strokeDasharray={flow ? "5 5" : e.to === "MERGE" && !merging ? "3 4" : undefined} />;
      })}
      {g.nodes.map((x) => {
        const { x: cx, y: cy } = pos[x.n];
        if (x.n === "MERGE") {
          const c = set.status === "merged" ? "var(--ok)" : set.status === "fix" ? "var(--err)" : merging ? "var(--acc)" : "var(--txl)";
          return (
            <g key="MERGE" className="tm-node" onClick={() => onPick("merge")} role="button" tabIndex={0} aria-label={`Merge into ${set.feature_branch || "the feature branch"}`}
               onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick("merge"); } }}>
              <title>Merge into {set.feature_branch || "the feature branch"}</title>
              {sel === "merge" && <rect x={cx - r - 9} y={cy - r - 9} width={2 * r + 18} height={2 * r + 18} fill="none" stroke="var(--txb)" strokeOpacity={0.6} transform={`rotate(45 ${cx} ${cy})`} />}
              <rect x={cx - r * 0.8} y={cy - r * 0.8} width={r * 1.6} height={r * 1.6} transform={`rotate(45 ${cx} ${cy})`}
                    fill={merging ? `color-mix(in srgb, ${c} 18%, transparent)` : "none"} stroke={c} strokeDasharray={merging ? undefined : "3 3"} strokeWidth={1.5} />
              <g transform={`translate(${cx - r * 0.5},${cy - r * 0.5}) scale(${r / 24})`} stroke={c} fill="none" strokeWidth={2.4} strokeLinecap="round">
                <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" />
              </g>
              {big && <><text x={cx} y={cy + r + 22} textAnchor="middle" className="tm-lab">one pass into</text>
                <text x={cx} y={cy + r + 36} textAnchor="middle" className="tm-lab">{set.feature_branch || "the feature branch"}</text></>}
            </g>
          );
        }
        const t = set.tickets[x.n], k = kinds[x.n], c = COLOR[k];
        const took = busy(k) ? ago(status.get(t.session_id)?.since) : "";
        const [l1, l2] = lines(t.title, 22);
        return (
          <g key={x.n} className="tm-node" onClick={() => onPick(x.n)} role="button" tabIndex={0} aria-label={`#${x.n} ${t.title}: ${WORD[k]}`}
             onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(x.n); } }}>
            <title>#{x.n} {t.title}: {WORD[k]}</title>
            {busy(k) && <circle className="tm-live" cx={cx} cy={cy} r={r + 6} fill="none" stroke={c} strokeOpacity={0.4} strokeWidth={2} />}
            {sel === x.n && <rect x={cx - r - 8} y={cy - r - 8} width={2 * r + 16} height={2 * r + 16} fill="none" stroke="var(--txb)" strokeOpacity={0.6} />}
            <circle cx={cx} cy={cy} r={r} fill={k === "q" ? "var(--panel2)" : `color-mix(in srgb, ${c} 16%, var(--panel2))`} stroke={c} strokeWidth={2} />
            <text x={cx} y={cy + (big ? 4.5 : 3.8)} textAnchor="middle" fontSize={big ? 12 : 10.5} fontWeight={800} fill={c}>{k === "fix" ? "!" : x.n}</text>
            {big ? <>
              <text x={cx} y={cy + r + 22} textAnchor="middle" className="tm-lab">{l1}</text>
              {l2 && <text x={cx} y={cy + r + 36} textAnchor="middle" className="tm-lab">{l2}</text>}
              {(took || k === "fix") && <text x={cx} y={cy + r + (l2 ? 51 : 37)} textAnchor="middle" className="tm-lab2" style={{ fill: c }}>{k === "fix" ? "needs a fix" : took}</text>}
            </> : took && <text x={cx + r + 6} y={cy + 4} className="tm-lab2" style={{ fill: c }}>{took}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/** What waits on you first, as the strip's call and the map's default pick. */
function urgent(set: TicketSet, ns: string[], kinds: Record<string, Kind>): string {
  return ns.find((n) => kinds[n] === "ask") ?? ns.find((n) => kinds[n] === "fix") ?? ns.find((n) => kinds[n] === "idle")
    ?? ((set.status === "fix" || set.merge_stalled) ? "merge" : "");
}

/** The flow session's ticket set, polled while its chat is open: quick while the set
 *  builds or merges, lazy when it rests, nothing while the window is hidden. Ticket turns
 *  end on the bridge with no dashboard event to announce them. */
function useTicketSet(sessionId: string): [TicketSet | null, () => void] {
  const [set, setSet] = useState<TicketSet | null>(null);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    let live = true, t = 0;
    const next = (fast: boolean) => { t = window.setTimeout(tick, fast ? 4000 : 15000); };
    const tick = () => {
      if (document.hidden) return next(false);
      // GET /local/flow's `set` is tickets.summary_for: the whole set.json plus its folder.
      api.getFlow(sessionId).then((r) => {
        if (!live) return;
        const s = (r.set as unknown as TicketSet | null) ?? null;
        setSet(s);
        next(!!s && (s.status === "building" || s.status === "merging"));
      }).catch(() => { if (live) next(false); });
    };
    tick();
    return () => { live = false; window.clearTimeout(t); };
  }, [sessionId, gen]);
  return [set, () => setGen((g) => g + 1)];
}

/** What a set says in a few words, and the buttons that act on it: the strip and LIVE share these. */
function useSetView(set: TicketSet | null, status: Map<string, SessionStatus>, reload: () => void, onOpenSession: (id: string) => void) {
  const [note, setNoteNow] = useState("");
  const noteT = useRef(0);
  useEffect(() => () => window.clearTimeout(noteT.current), []);
  if (!set || !set.tickets) return null;
  // What a retry, build or clean-up answered, for a few seconds: the bridge's replies are the only feedback.
  const setNote = (text: string) => {
    setNoteNow(text);
    window.clearTimeout(noteT.current);
    if (text) noteT.current = window.setTimeout(() => setNoteNow(""), 8000);
  };
  const act = (p: Promise<{ text: string }>, fail: string) => { p.then((r) => setNote(r.text), (e) => setNote(e instanceof Error ? e.message : fail)).then(reload); };
  const ns = Object.keys(set.tickets).sort();
  const kinds = Object.fromEntries(ns.map((n) => [n, kindOf(set.tickets[n], status.get(set.tickets[n].session_id)?.state)])) as Record<string, Kind>;
  const name = set.slug.replace(/-/g, " ");
  const { g, ticketCols, now } = waves(set, kinds);
  const done = ns.filter((n) => kinds[n] === "done").length, atOnce = ns.filter((n) => busy(kinds[n])).length;
  const branch = set.feature_branch || "the feature branch";
  const facts = set.status === "approve" ? "waiting for your approval"
    : set.status === "merged" ? `merged into ${branch}`
    : set.status === "merging" ? `merging ${set.merged} of ${ns.length}`
    : set.status === "stopped" ? "stopped"
    : [now >= 0 ? `wave ${now + 1}/${ticketCols}` : `${done} of ${ns.length} done`, atOnce && `${atOnce} at once`].filter(Boolean).join(" · ");
  const ops = {
    retry: (n: string) => act(api.retryTicket(set.folder, n), "retry failed"),
    build: () => act(api.buildTickets(set.folder), "build failed"),
    approve: () => act(api.approveTickets(set.folder), "approve failed"),
    clean: async () => {
      if (!(await askConfirm(`Remove ${name}'s ticket worktrees and branches? Anything unmerged or uncommitted stays; their .mystical/ scratch moves to .mystical/archive/, other ignored files (.env) go with them.`, { ok: "Clean up" }))) return;
      try {
        const r = await api.cleanupTickets(set.folder);
        setNote(`removed ${r.removed.length}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`);
      } catch (e) { setNote(e instanceof Error ? e.message : "clean-up failed"); }
    },
  };
  const first = urgent(set, ns, kinds);
  const t = first && first !== "merge" ? set.tickets[first] : null;
  const call = note ? <span className="tm-call">{note}</span>
    : set.status === "stopped" ? <span className="tm-call err" title={set.error}>{set.error || "BUILD could not start"}</span>
    : t && kinds[first] === "ask" ? <span className="tm-call warn" title={status.get(t.session_id)?.label ?? undefined}><Hand size={13} aria-hidden /><b>#{first}</b> asks you</span>
    : t && kinds[first] === "fix" ? <span className="tm-call err" title={t.why}><b>#{first}</b> needs a fix</span>
    : t ? <span className="tm-call warn"><b>#{first}</b> stopped</span>
    : first === "merge" ? <span className={`tm-call ${set.status === "fix" ? "err" : "warn"}`}>the merge {set.status === "fix" ? "needs a fix" : "stopped"}</span>
    : null;
  const action = note ? null
    : set.status === "approve" ? <button className="tm-btn acc" onClick={ops.approve}>Approve &amp; build</button>
    : set.status === "stopped" ? <button className="tm-btn" onClick={ops.build}>Build</button>
    : t && kinds[first] === "ask" ? <button className="tm-btn warn" onClick={() => onOpenSession(t.session_id)}>Answer</button>
    : t && kinds[first] === "fix" ? <button className="tm-btn" onClick={() => ops.retry(first)}><RotateCcw size={11} aria-hidden /> Retry</button>
    : t ? <button className="tm-btn" onClick={() => ops.retry(first)}>Continue</button>
    : first === "merge" ? <button className="tm-btn" onClick={() => ops.retry("merge")}>{set.status === "fix" ? "Retry" : "Continue"}</button>
    : null;
  const dots = (
    <span className="tm-dots" aria-hidden>
      {Array.from({ length: g.cols }, (_, c) => (
        <span key={c} className={`tm-wv${c === now ? " now" : ""}`}>
          {c === g.cols - 1 ? <i className="m" />
            : g.nodes.filter((x) => x.col === c).map((x) => <i key={x.n} style={kinds[x.n] === "q" ? undefined : { background: COLOR[kinds[x.n]], color: COLOR[kinds[x.n]] }} className={busy(kinds[x.n]) ? "on" : undefined} />)}
        </span>
      ))}
    </span>
  );
  return { set, ns, kinds, name, facts, ops, call, action, dots, first };
}

/** Switch the open super session's view (Terminal listens): the strip's Live button. */
export const showTicketsLive = (on: boolean) => window.dispatchEvent(new CustomEvent("hud:tickets-live", { detail: on }));

export function TicketMapCard({ sessionId, status, onOpenSession }: {
  sessionId: string; status: Map<string, SessionStatus>; onOpenSession: (id: string) => void;
}) {
  const [set, reload] = useTicketSet(sessionId);
  const [wide, setWide] = useState(false);
  useEffect(() => { setWide(!!set && localStorage.getItem(openKey(set.folder)) === "1"); }, [set?.folder]);   // eslint-disable-line react-hooks/exhaustive-deps
  const v = useSetView(set, status, reload, onOpenSession);
  if (!v) return null;
  const { ns, kinds, name, facts, call, action, dots } = v;
  const toggle = () => { const x = !wide; setWide(x); if (x) localStorage.setItem(openKey(v.set.folder), "1"); else localStorage.removeItem(openKey(v.set.folder)); };
  // The expanded strip's last line: what runs together now, and what starts next.
  const together = ns.filter((n) => busy(kinds[n]));
  const nextUp = ns.find((n) => kinds[n] === "q" && v.set.tickets[n].blocked_by.every((b) => kinds[b] === "done" || busy(kinds[b])));
  const waitsOn = nextUp ? v.set.tickets[nextUp].blocked_by.filter((b) => kinds[b] !== "done") : [];
  return (
    <>
    <TicketAsks set={v.set} kinds={kinds} status={status} onOpenSession={onOpenSession} />
    <div className="tm-card" role="region" aria-label={`Tickets: ${name}`}>
      <div className="tm-row">
        <Ticket size={15} aria-hidden className="tm-ic" /><span className="caps tm-k">Tickets</span><span className="tm-nm">{name}</span>
        <span className="tm-div" />
        {dots}
        <span className="tm-c">{facts}</span>
        {call && <><span className="tm-div" />{call}</>}
        <span style={{ flex: 1 }} />
        {action}
        <button className="tm-btn ghost" onClick={toggle} aria-expanded={wide} aria-label={wide ? "Fold the ticket graph" : "Show the ticket graph"} title={wide ? "Fold" : "Show the graph"}>
          {wide ? <ChevronUp size={15} aria-hidden /> : <ChevronDown size={15} aria-hidden />}
        </button>
        <button className="tm-btn acc" onClick={() => showTicketsLive(true)} aria-label="Watch the tickets at work"><span className="tm-open-w">Live</span> <Radio size={11} aria-hidden /></button>
      </div>
      {wide && (
        <>
          <div className="tm-body-s"><Graph set={v.set} kinds={kinds} status={status} onPick={(n) => { const sid = n === "merge" ? v.set.merge_session : v.set.tickets[n]?.session_id; if (sid) onOpenSession(sid); }} /></div>
          {(together.length > 0 || nextUp) && (
            <div className="tm-ft">
              <Zap size={12} aria-hidden />
              <span className="tm-line">
                {together.length > 0 && <>Running together: <b>{together.map((n) => `#${n}`).join(" ")}</b></>}
                {together.length > 0 && nextUp && " · "}
                {nextUp && <>#{nextUp} starts the moment {waitsOn.map((b) => `#${b}`).join(" and ")} {waitsOn.length > 1 ? "are" : "is"} done</>}
              </span>
            </div>
          )}
        </>
      )}
    </div>
    </>
  );
}

/** LIVE (C · LIVE GRID, picked 2026-11-12, .mystical/design-drafts/ticket-flow): the super
 *  session shows its ticket sessions at work inside it, one tile each, instead of a map
 *  over the app. Its own chat is the first tile (the composer under the grid still writes
 *  to it); each ticket tile is a live tail of its session, its question answerable there,
 *  and a box that queues a message to it. ⤢ puts one tile on the stage, the rest keep
 *  running in a column beside it. Done and waiting tickets are chips in the bar. */
export function TicketLive({ sessionId, title, status, onOpenSession }: {
  sessionId: string; title: string; status: Map<string, SessionStatus>; onOpenSession: (id: string) => void;
}) {
  const [set, reload] = useTicketSet(sessionId);
  const [stage, setStage] = useState<string | null>(null);
  const v = useSetView(set, status, reload, onOpenSession);
  if (!v) return <div className="tl-live"><div className="tl-empty">No ticket set in this session.</div></div>;
  const { ns, kinds, name, facts, ops, call, action, dots } = v;
  const tk = v.set.tickets;
  const merging = v.set.status === "merging" || v.set.status === "fix" || !!v.set.merge_stalled;
  const tiles: { sid: string; label: string; no: string; kind: Kind | "merge" | "self"; retry?: () => void }[] = [
    { sid: sessionId, label: title || "this session", no: "", kind: "self" },
    ...ns.filter((n) => busy(kinds[n]) || kinds[n] === "fix").filter((n) => tk[n].session_id)
      .map((n) => ({ sid: tk[n].session_id, label: tk[n].title, no: `#${n}`, kind: kinds[n],
                     retry: kinds[n] === "fix" || kinds[n] === "idle" ? () => ops.retry(n) : undefined })),
    ...(merging && v.set.merge_session ? [{ sid: v.set.merge_session, label: `merge into ${v.set.feature_branch || "the feature branch"}`, no: "⇢", kind: "merge" as const,
                                           retry: v.set.status === "fix" || v.set.merge_stalled ? () => ops.retry("merge") : undefined }] : []),
  ];
  const staged = stage && tiles.some((x) => x.sid === stage) ? stage : null;
  const order = staged ? [...tiles.filter((x) => x.sid === staged), ...tiles.filter((x) => x.sid !== staged)] : tiles;
  const chip = (n: string) => (
    <button key={n} className="tl-chip" title={`#${n} ${tk[n].title}: ${WORD[kinds[n]]}`}
            onClick={() => tk[n].session_id && onOpenSession(tk[n].session_id)} disabled={!tk[n].session_id}>
      {kinds[n] !== "q" && <i style={{ background: COLOR[kinds[n]] }} />}#{n}
    </button>
  );
  const doneNs = ns.filter((n) => kinds[n] === "done"), nextNs = ns.filter((n) => kinds[n] === "q");
  const n = tiles.length;
  return (
    <div className="tl-live" role="region" aria-label={`Tickets at work: ${name}`}>
      <div className="tl-bar">
        <Ticket size={14} aria-hidden className="tm-ic" /><span className="caps tm-k">Tickets</span>
        {dots}<span className="tm-c">{facts}</span>
        {call && <><span className="tm-div" />{call}</>}
        {action}
        <span style={{ flex: 1 }} />
        {doneNs.length > 0 && <span className="tl-chips"><span className="tl-chl">done</span>{doneNs.map(chip)}</span>}
        {nextNs.length > 0 && <span className="tl-chips"><span className="tl-chl">next</span>{nextNs.map(chip)}</span>}
        {v.set.status === "merged" && <button className="tm-btn ghost" onClick={() => void ops.clean()}>Clean up</button>}
        {/* The way back where the header's CHAT | LIVE has no room (COMPACT). */}
        <button className="tm-btn ghost" onClick={() => showTicketsLive(false)} title="Back to this session's chat">Chat</button>
      </div>
      <div className={`tl-grid${staged ? " staged" : ""}`} style={staged ? { gridTemplateRows: `repeat(${Math.max(1, n - 1)}, minmax(0, 1fr))` }
        : { gridTemplateColumns: n <= 1 ? "1fr" : n === 2 ? "1fr 1fr" : `minmax(0, .8fr) repeat(${Math.min(2, n - 1)}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${n <= 3 ? 1 : Math.ceil((n - 1) / 2)}, minmax(0, 1fr))` }}>
        {order.map((x, i) => (
          <LiveTile key={x.sid} sid={x.sid} label={x.label} no={x.no} kind={x.kind} st={status.get(x.sid)}
                    big={!!staged && i === 0} small={!!staged && i > 0}
                    span={!staged && x.kind === "self" && n > 3 ? Math.ceil((n - 1) / 2) : staged && i === 0 ? Math.max(1, n - 1) : 1}
                    onStage={() => setStage(staged === x.sid ? null : x.sid)} retry={x.retry} onOpen={() => onOpenSession(x.sid)} />
        ))}
      </div>
      {tiles.length === 1 && <div className="tl-empty">{v.set.status === "approve" ? "Approve the tickets to start them." : "No ticket is at work right now."}</div>}
    </div>
  );
}

/** A session's last turn, polled: quick while it runs, lazy at rest, nothing while hidden.
 *  `gen` bumps it after an answer, so the card it answered goes at once. */
function useTail(sid: string) {
  const [turn, setTurn] = useState<{ id: string; status: string; events: TimedEvent[] } | null>(null);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    let live = true, t = 0;
    const tick = () => {
      if (document.hidden) { t = window.setTimeout(tick, 5000); return; }
      api.transcript(sid, 0, { tail: 1 }).then((r) => {
        if (!live) return;
        const last = r.turns[r.turns.length - 1];
        setTurn(last ? { id: last.id, status: last.status, events: r.events.filter((e) => e.turn_id === last.id) } : null);
        t = window.setTimeout(tick, last?.status === "running" ? 2500 : 8000);
      }).catch(() => { if (live) t = window.setTimeout(tick, 8000); });
    };
    tick();
    return () => { live = false; window.clearTimeout(t); };
  }, [sid, gen]);
  const pending = turn?.status === "running" ? derivePending(turn.events) : [];
  return { turn, q: pending[0], refresh: () => setGen((g) => g + 1) };
}

/** NEEDS YOU: every ticket session that waits on you, one full-width row each, stacked like
 *  a queue above the prompt box, oldest first (the user's call, 2026-11-12: a question in a
 *  small tile was hard to read). A plain pick answers in a tap; anything more opens its session. */
function TicketAsks({ set, kinds, status, onOpenSession }: {
  set: TicketSet; kinds: Record<string, Kind>; status: Map<string, SessionStatus>; onOpenSession: (id: string) => void;
}) {
  const asking = Object.keys(set.tickets).sort()
    .filter((n) => kinds[n] === "ask" && set.tickets[n].session_id)
    .sort((a, b) => (status.get(set.tickets[a].session_id)?.since ?? 0) - (status.get(set.tickets[b].session_id)?.since ?? 0));
  if (!asking.length) return null;
  return (
    <div className="tk-asks" role="region" aria-label={`${asking.length} ticket${asking.length === 1 ? "" : "s"} waiting on you`}>
      <div className="tk-asks-h"><Hand size={12} aria-hidden /><span className="caps">Needs you</span><span>{asking.length}</span></div>
      {asking.map((n) => <AskRow key={n} n={n} title={set.tickets[n].title} sid={set.tickets[n].session_id} st={status.get(set.tickets[n].session_id)}
                                 onOpen={() => onOpenSession(set.tickets[n].session_id)} />)}
    </div>
  );
}

function AskRow({ n, title, sid, st, onOpen }: { n: string; title: string; sid: string; st?: SessionStatus; onOpen: () => void }) {
  const { turn, q, refresh } = useTail(sid);
  const one = q?.kind === "question" && q.questions?.length === 1 && !q.questions[0].multiSelect ? q.questions[0] : null;
  const ask = q?.kind === "question" ? q.questions?.[0]?.question : q?.kind === "permission" ? `${q.tool_name}: ${q.summary ?? ""}` : st?.label;
  const answer = (body: Parameters<typeof api.respond>[1]) => { if (turn) void api.respond(turn.id, body).then(refresh); };
  return (
    <div className="tk-ask">
      <span className="no">#{n}</span>
      <span className="body">
        <span className="tt">{title}{st?.since && <em> · {ago(st.since)}</em>}</span>
        <span className="qq">{ask || "It waits for your answer in its session."}</span>
      </span>
      <span className="acts">
        {one && turn && one.options.map((o) => (
          <button key={o.label} className="tm-btn sm" title={o.description} onClick={() => answer({ request_id: q!.request_id, answers: [{ header: one.header, labels: [o.label] }] })}>{o.label}</button>
        ))}
        {q?.kind === "permission" && turn && <>
          <button className="tm-btn acc sm" onClick={() => answer({ request_id: q.request_id, behavior: "allow" })}>Allow</button>
          <button className="tm-btn sm" onClick={() => answer({ request_id: q.request_id, behavior: "deny" })}>Deny</button>
        </>}
        <button className={`tm-btn sm${one || q?.kind === "permission" ? " ghost" : " warn"}`} onClick={onOpen}>{one || q?.kind === "permission" ? "Open" : "Answer"}</button>
      </span>
    </div>
  );
}

/** One session, live: its last turn's tools and words, newest at the bottom, what it asks
 *  you, and a box that queues a message to it. Polls its transcript tail while shown. */
function LiveTile({ sid, label, no, kind, st, big, small, span, onStage, retry, onOpen }: {
  sid: string; label: string; no: string; kind: Kind | "merge" | "self"; st?: SessionStatus;
  big: boolean; small: boolean; span: number; onStage: () => void; retry?: () => void; onOpen: () => void;
}) {
  const { turn, q, refresh } = useTail(sid);
  const [text, setText] = useState("");
  const [sent, setSent] = useState("");
  const running = turn?.status === "running";
  const lines = (turn?.events ?? []).flatMap((e, i): ReactElement[] => {
    if (e.type === "tool") return [<div key={i}><b>{e.name}</b> {e.summary}</div>];
    if (e.type === "text") return e.text.trim().split(/\n+/).filter(Boolean).slice(-4).map((l, j) => <div key={`${i}.${j}`} className="say">{l}</div>);
    if (e.type === "tool_done" && (e as { is_error?: boolean }).is_error) return [<div key={i} className="er">that failed</div>];
    return [];
  }).slice(big ? -60 : small ? -4 : -14);
  const c = kind === "self" || kind === "merge" ? (running ? COLOR.run : "var(--txl)") : COLOR[kind];
  const word = kind === "self" ? (running ? "working" : "this session") : kind === "merge" ? (running ? "merging" : "merge") : WORD[kind];
  const took = st?.since && running ? ago(st.since) : "";
  const send = () => {
    const p = text.trim();
    if (!p) return;
    setText("");
    api.queueEnqueue({ session_id: sid, text: p, prompt: p, surface: "dashboard" })
      .then(() => { setSent("queued"); refresh(); }, (e) => setSent(e instanceof Error ? e.message : "not sent"));
  };
  return (
    <div className={`tl-tile k-${kind}${big ? " big" : ""}${small ? " small" : ""}`} style={span > 1 ? { gridRow: `span ${span}` } : undefined}>
      <div className="tl-th">
        <span className="tl-dot" style={{ background: c, boxShadow: running ? `0 0 6px ${c}` : undefined }} />
        {kind === "self" ? <Ticket size={12} aria-hidden className="tm-ic" /> : <span className="tl-no">{no}</span>}
        <button className="tl-name" onClick={onOpen} title={`Open ${no ? `${no} ` : ""}${label}`}>{label}</button>
        <span style={{ flex: 1 }} />
        <span className="tl-st" style={{ color: c }}>{q ? "asks you" : word}</span>
        {took && <span className="tl-tm">{took}</span>}
        {retry && <button className="tm-btn sm" onClick={retry}><RotateCcw size={10} aria-hidden /> {kind === "fix" ? "Retry" : "Continue"}</button>}
        {kind !== "self" && <button className="tm-btn ghost sm" onClick={onStage} aria-label={big ? "Back to the grid" : `Put ${no || label} on the stage`} title={big ? "Back to the grid" : "On the stage"}>
          {big ? <Minimize2 size={11} aria-hidden /> : <Maximize2 size={11} aria-hidden />}
        </button>}
      </div>
      <div className="tl-tb"><div>
        {lines.length ? lines : <div className="say dim">{turn ? "Nothing to show yet." : "Loading…"}</div>}
        {q?.kind === "question" && q.questions && !small && turn && (big ? (
          <div className="tl-q">
            <QuestionCard questions={q.questions} requestId={q.request_id}
              onSubmit={(a) => api.respond(turn.id, { request_id: q.request_id, answers: a }).then(() => { refresh(); return true; }, () => false)} />
          </div>
        ) : (
          <div className="say" style={{ color: "var(--warn)" }}>asks you: answer it in NEEDS YOU below</div>
        ))}
        {q?.kind === "permission" && big && turn && (
          <div className="tl-q">
            <p><b>{q.tool_name}</b> {q.summary}</p>
            <span className="tl-qa">
              <button className="tm-btn acc sm" onClick={() => void api.respond(turn.id, { request_id: q.request_id, behavior: "allow" }).then(() => refresh())}>Allow</button>
              <button className="tm-btn sm" onClick={() => void api.respond(turn.id, { request_id: q.request_id, behavior: "deny" }).then(() => refresh())}>Deny</button>
            </span>
          </div>
        )}
        {q && !big && (small || q.kind === "permission") && <div className="say" style={{ color: "var(--warn)" }}>asks you: answer it in NEEDS YOU below</div>}
      </div></div>
      {kind !== "self" && !small && (
        <form className="tl-reply" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <span aria-hidden className="pr">❯</span>
          <input value={text} onChange={(e) => { setText(e.target.value); setSent(""); }} placeholder={sent || `${q ? "answer or " : ""}write to ${no || label}…`}
                 aria-label={`Message ${no || label}`} />
        </form>
      )}
    </div>
  );
}
