import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { main } from "../../lib/queries";
import { ChevronDown, ChevronUp, Hand, Radio, RotateCcw, Ticket, Zap } from "lucide-react";
import { api, type SessionStatus, type TicketSet } from "../../api";
import { derivePending } from "../../chat";
import { dagLayout, graphWidth, kindOf, waveLabel, type Kind } from "../../lib/ticketdag";
import { changeFlows, useFlowSettings } from "../../lib/flowsettings";
import { askConfirm } from "../ui/Ask";
import { Switch } from "../ui/Switch";

/** A ticket set lives in the flow chat that made it, the super session: a strip docked
 *  above the prompt box (A · WAVES, picked 2026-11-12, .mystical/design-drafts/ticket-map-v2)
 *  and TICKETS, a list of its ticket sessions in place of its chat (2026-11-13,
 *  .mystical/design-drafts/ticket-reading). A row opens that session in the normal session
 *  view, under a ‹ back crumb and a TicketBrief: following a ticket reads like any session.
 *  TICKETS replaced a grid of live tiles (C · LIVE GRID), which replaced a full-window map;
 *  ticket sessions stay out of the sidebar (they fold under the super session's row there).
 *  Every ready ticket starts at once, so a graph column (1 + its longest blocker chain) is
 *  a wave that runs together; the strip shows a dot group per wave, what waits on you and
 *  its button, and its chevron opens the graph in place, remembered per set. A ticket's
 *  live state comes from its session (App's status map); the set is polled while the chat
 *  is open, since ticket turns end on the bridge with no dashboard event to announce them. */

const WORD: Record<Kind, string> = { run: "Running", ask: "Asks you", idle: "Stopped", q: "Waiting", done: "Done", fix: "Fix", you: "Yours" };
const COLOR: Record<Kind, string> = { run: "var(--acc)", ask: "var(--warn)", idle: "var(--warn)", q: "var(--txl)", done: "var(--ok)", fix: "var(--err)", you: "var(--warn)" };
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
  // A column has a floor width so labels never overlap; a wider set scrolls sideways.
  const r = big ? 20 : 13, padX = big ? 80 : 54, top = big ? 44 : 30, W = graphWidth(g.cols, !!big);
  const H = top + (big ? Math.max(260, rowsMax * 120) : Math.max(56, rowsMax * 40)) + (big ? 30 : 8);
  const colW = g.cols > 1 ? (W - 2 * padX) / (g.cols - 1) : W - 2 * padX;
  const X = (c: number) => (g.cols > 1 ? padX + c * colW : W / 2);
  const pos = Object.fromEntries(g.nodes.map((x) => [x.n, {
    x: X(x.col), y: top + ((H - top - (big ? 30 : 8)) / inCol(x.col)) * (x.row + 0.5),
  }]));
  const merging = set.status === "merging" || set.status === "merged";
  const label = (c: number) => waveLabel(c, g.cols, g.nodes.every((x) => x.col !== c || kinds[x.n] === "done") ? "done" : c === now ? "now" : "", !!big);
  return (
    <svg className={`tm-graph${big ? " big" : ""}`} viewBox={`0 0 ${W} ${H}`} style={big ? { "--min-w": `${W}px` } as CSSProperties : W > 680 ? { minWidth: W, maxHeight: "none" } : undefined}
         role="group" aria-label={`Dependency graph of ${ns.length} parts in ${g.cols - 1} waves, then merge`}>
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
  return ns.find((n) => kinds[n] === "ask") ?? ns.find((n) => kinds[n] === "you") ?? ns.find((n) => kinds[n] === "fix") ?? ns.find((n) => kinds[n] === "idle")
    ?? ((set.status === "fix" || set.merge_stalled) ? "merge" : "");
}

/** The flow session's ticket set, polled while its chat is open: quick while the set
 *  builds or merges, lazy when it rests, nothing while the window is hidden. Ticket turns
 *  end on the bridge with no dashboard event to announce them. */
function useTicketSet(sessionId: string): TicketSet | null {
  // GET /local/flow's `set` is tickets.summary_for: the whole set.json plus its folder. The
  // prompt box and the SESSION tab read the same key (lib/queries), so they share it.
  const key = main.flow({ session: sessionId });
  const q = useQuery({ ...key, refetchInterval: (qq) => {
    const s = qq.state.data?.set as unknown as TicketSet | null | undefined;
    return s && (s.status === "building" || s.status === "merging") ? 4000 : 15000;
  } });
  return (q.data?.set as unknown as TicketSet | null | undefined) ?? null;
}

/** AUTO-START beside Approve & build while a set waits: every flow that builds as tickets at once
 *  (the FLOWS sheet sets one), for later sets only; the set waiting now still waits for the tap. */
function AutoStart({ flows, onErr }: { flows: AutoFlows; onErr: (text: string) => void }) {
  const on = flows.every((f) => !f.approve);
  // One at a time: each answer is the whole settings, so the last one back must be the last one sent.
  const flip = async () => { for (const f of flows) await changeFlows({ flow: f.id, key: "approve", value: on }); };
  return (
    <label className="fs-sw tm-auto" title="later sets in DESIGN, BUILD and REFACTOR start by themselves; this one still waits for Approve & build">
      <Switch on={on} label="Auto-start later tasks' parts" onClick={() => void flip().catch((e: Error) => onErr(e.message))} /><span className="caps">Auto-start</span></label>
  );
}

/** What a set says in a few words, and the buttons that act on it: the strip and TICKETS share these. */
type AutoFlows = NonNullable<ReturnType<typeof useFlowSettings>>["flows"];

function useSetView(set: TicketSet | null, status: Map<string, SessionStatus>, onOpenSession: (id: string) => void) {
  const flows = useFlowSettings()?.flows.filter((f) => f.tickets !== undefined) ?? [];
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
  const act = (p: Promise<{ text: string }>, fail: string) => { p.then((r) => setNote(r.text), (e) => setNote(e instanceof Error ? e.message : fail)); };   // a move rereads the set (lib/queries CHANGES)
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
    decline: () => act(api.declineTickets(set.folder), "not now failed"),
    go: async (n: string) => {
      if (!(await askConfirm(`Mark #${n} ${set.tickets[n].title} done? What waits on it starts.`, { ok: "Go" }))) return;
      act(api.goTicket(set.folder, n), "go failed");
    },
    clean: async () => {
      if (!(await askConfirm(`Remove ${name}'s part worktrees and branches? Anything unmerged or uncommitted stays; their .mystical/ scratch moves to .mystical/archive/, other ignored files (.env) go with them.`, { ok: "Clean up" }))) return;
      try {
        const r = await api.cleanupTickets(set.folder);
        setNote(`removed ${r.removed.length}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`);
      } catch (e) { setNote(e instanceof Error ? e.message : "clean-up failed"); }
    },
  };
  const first = urgent(set, ns, kinds);
  const t = first && first !== "merge" ? set.tickets[first] : null;
  const call = note ? <span className="tm-call"><span>{note}</span></span>
    : set.status === "stopped" && set.error !== undefined   // Not now leaves no error: set aside, nothing failed
      ? <span className="tm-call err" title={set.error}><span>{set.error || "BUILD could not start"}</span></span>
    : t && kinds[first] === "ask" ? <span className="tm-call warn" title={status.get(t.session_id)?.label ?? undefined}><Hand size={13} aria-hidden /><b>#{first}</b> asks you</span>
    : t && kinds[first] === "you" ? <span className="tm-call warn" title={t.title}><Hand size={13} aria-hidden /><b>#{first}</b> is yours</span>
    : t && kinds[first] === "fix" ? <span className="tm-call err" title={t.why}><b>#{first}</b> needs a fix</span>
    : t ? <span className="tm-call warn"><b>#{first}</b> stopped</span>
    : first === "merge" ? <span className={`tm-call ${set.status === "fix" ? "err" : "warn"}`}>the merge {set.status === "fix" ? "needs a fix" : "stopped"}</span>
    : null;
  // AUTO-START shown: the strip and the bar drop their facts for it (index.css [data-auto])
  const auto = !note && set.status === "approve" && flows.length > 0;
  const action = note ? null
    : set.status === "approve" ? <>{auto && <AutoStart flows={flows} onErr={setNote} />}<button className="tm-btn ghost" onClick={ops.decline}>Not now</button>
      <button className="tm-btn acc" onClick={ops.approve}>Approve &amp; build</button></>
    : set.status === "stopped" ? <button className="tm-btn" onClick={ops.build}>Build</button>
    : t && kinds[first] === "ask" ? <button className="tm-btn warn" onClick={() => onOpenSession(t.session_id)}>Answer</button>
    : t && kinds[first] === "you" ? <button className="tm-btn warn" onClick={() => void ops.go(first)}>Go</button>
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
  return { set, ns, kinds, name, facts, ops, call, action, dots, first, auto };
}

/** Switch the open super session's view (Terminal listens): the strip's Sessions button. */
export const showTicketsLive = (on: boolean) => window.dispatchEvent(new CustomEvent("hud:tickets-live", { detail: on }));

/** `except`: the ticket session open now, inside this set. Then only NEEDS YOU shows, without
 *  that ticket (its own question is in its transcript): the strip belongs to the super session. */
export function TicketMapCard({ sessionId, status, onOpenSession, except }: {
  sessionId: string; status: Map<string, SessionStatus>; onOpenSession: (id: string) => void; except?: string;
}) {
  const set = useTicketSet(sessionId);
  const [wide, setWide] = useState(false);
  useEffect(() => { setWide(!!set && localStorage.getItem(openKey(set.folder)) === "1"); }, [set?.folder]);   // eslint-disable-line react-hooks/exhaustive-deps
  const v = useSetView(set, status, onOpenSession);
  // In the chat column the card marks it, so the transcript keeps its room (index.css [data-tmcard])
  const card = useRef<HTMLDivElement>(null);
  const shown = !!v && !except;
  useLayoutEffect(() => {
    const col = card.current?.parentElement;
    if (!shown || !col?.matches('[data-ctx-type="terminal"]')) return;
    col.dataset.tmcard = "";
    return () => { delete col.dataset.tmcard; };
  }, [shown]);
  if (!v) return null;
  const { ns, kinds, name, facts, call, action, dots } = v;
  if (except) return <TicketAsks set={v.set} kinds={kinds} status={status} onOpenSession={onOpenSession} except={except} />;
  const toggle = () => { const x = !wide; setWide(x); if (x) localStorage.setItem(openKey(v.set.folder), "1"); else localStorage.removeItem(openKey(v.set.folder)); };
  // The expanded strip's last line: what runs together now, and what starts next.
  const together = ns.filter((n) => busy(kinds[n]));
  const nextUp = ns.find((n) => kinds[n] === "q" && v.set.tickets[n].blocked_by.every((b) => kinds[b] === "done" || busy(kinds[b])));
  const waitsOn = nextUp ? v.set.tickets[nextUp].blocked_by.filter((b) => kinds[b] !== "done") : [];
  return (
    <>
    <TicketAsks set={v.set} kinds={kinds} status={status} onOpenSession={onOpenSession} />
    <div ref={card} className="tm-card" role="region" aria-label={`Parts: ${name}`}>
      <div className="tm-row" data-call={v.call ? "" : undefined} data-auto={v.auto ? "" : undefined}>
        <Ticket size={15} aria-hidden className="tm-ic" /><span className="caps tm-k">Parts</span><span className="tm-nm">{name}</span>
        <span className="tm-div" />
        {dots}
        <span className="tm-c">{facts}</span>
        {call && <><span className="tm-div" />{call}</>}
        <span style={{ flex: 1 }} />
        {action}
        <button className="tm-btn ghost" onClick={toggle} aria-expanded={wide} aria-label={wide ? "Fold the parts graph" : "Show the parts graph"} title={wide ? "Fold" : "Show the graph"}>
          {wide ? <ChevronUp size={15} aria-hidden /> : <ChevronDown size={15} aria-hidden />}
        </button>
        <button className="tm-btn acc" onClick={() => showTicketsLive(true)} aria-label="Show the parts' sessions"><span className="tm-open-w">Sessions</span> <Radio size={11} aria-hidden /></button>
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

/** TICKETS (2026-11-13, .mystical/design-drafts/ticket-reading): the super session lists its
 *  ticket sessions, one row each, and a row opens that session in the normal session view (it
 *  carries a ‹ back crumb and a TicketBrief). It replaced a grid of live tiles (C · LIVE GRID):
 *  a tile's tool-name tail read nothing like a session, so following a ticket was hard. */
const RANK: Record<Kind, number> = { ask: 0, you: 0.5, fix: 1, idle: 2, run: 3, q: 4, done: 5 };
export function TicketList({ sessionId, status, onOpenSession, top = 4 }: {
  sessionId: string; status: Map<string, SessionStatus>; onOpenSession: (id: string) => void;
  /** Where the list starts: below the chat's header island, which floats over the column. */
  top?: number;
}) {
  const set = useTicketSet(sessionId);
  const v = useSetView(set, status, onOpenSession);
  if (!v) return <div className="tl-live" style={{ paddingTop: top }}><div className="tl-empty">No parts in this session.</div></div>;
  const { ns, kinds, name, facts, ops, call, action, dots } = v;
  const tk = v.set.tickets;
  const now = (n: string) => {
    const k = kinds[n], t = tk[n], st = status.get(t.session_id);
    if (k === "done") return "done";
    if (k === "fix") return `needs a fix: ${t.why || "it did not finish"}`;
    if (k === "q") { const w = t.blocked_by.filter((b) => kinds[b] !== "done"); return w.length ? `waits on ${w.map((b) => `#${b}`).join(" ")}` : "starts next"; }
    if (k === "ask") return `asks you${st?.label ? `: ${st.label}` : ""}`;
    if (k === "you") return "yours: do its to-dos, then Go";
    if (k === "idle") return "stopped before it finished";
    return st?.label || "working";
  };
  const order = [...ns].sort((a, b) => RANK[kinds[a]] - RANK[kinds[b]] || a.localeCompare(b));
  const mergeSid = v.set.merge_session;
  // A row lights while its open button is hovered, not its Retry or Go (index.css .tl-row[data-hot])
  const hot = {
    onPointerEnter: (e: React.PointerEvent<HTMLButtonElement>) => { if (!e.currentTarget.disabled) e.currentTarget.parentElement!.dataset.hot = ""; },
    onPointerLeave: (e: React.PointerEvent<HTMLButtonElement>) => { delete e.currentTarget.parentElement!.dataset.hot; },
  };
  const into = v.set.feature_branch || "the feature branch";
  return (
    <div className="tl-live" role="region" aria-label={`Parts: ${name}`} style={{ paddingTop: top }}>
      <div className="tl-bar" data-auto={v.auto ? "" : undefined}>
        <Ticket size={14} aria-hidden className="tm-ic" /><span className="caps tm-k">Parts</span>
        {dots}<span className="tm-c">{facts}</span>
        {call && <><span className="tm-div" />{call}</>}
        <span style={{ flex: 1 }} />
        {action}
        {v.set.status === "merged" && <button className="tm-btn ghost" onClick={() => void ops.clean()}>Clean up</button>}
        {/* The way back where the header's CHAT | PARTS has no room (COMPACT). */}
        <button className="tm-btn ghost" onClick={() => showTicketsLive(false)} title="Back to this session's chat">Chat</button>
      </div>
      <div className="tl-list">
        {mergeSid && (
          <div className={`tl-row${v.set.status === "fix" ? " k-fix" : ""}`}>
            <button className="tl-open" {...hot} onClick={() => onOpenSession(mergeSid)} title={`Open the merge into ${into}`}>
              <span className="tl-dot" style={{ background: v.set.status === "fix" ? COLOR.fix : v.set.status === "merged" ? COLOR.done : COLOR.run }} />
              <span className="tl-no">⇢</span>
              <span className="tl-lt"><b>merge into {into}</b>
                <span>{v.set.status === "merged" ? "merged" : v.set.status === "fix" ? "needs a fix" : status.get(mergeSid)?.label || "merging"}</span></span>
              <span className="tl-go" aria-hidden>›</span>
            </button>
          </div>
        )}
        {order.map((n) => {
          const t = tk[n], k = kinds[n], sid = t.session_id;
          return (
            <div key={n} className={`tl-row k-${k}`}>
              <button className="tl-open" {...hot} disabled={!sid} onClick={() => sid && onOpenSession(sid)}
                      title={sid ? `Open #${n} ${t.title}` : `#${n} has no session yet`}>
                <span className="tl-dot" style={k === "q" ? undefined : { background: COLOR[k], boxShadow: busy(k) ? `0 0 6px ${COLOR[k]}` : undefined }} />
                <span className="tl-no">#{n}</span>
                <span className="tl-lt"><b>{t.title}</b><span style={k === "ask" || k === "idle" || k === "you" ? { color: COLOR[k] } : undefined}>{now(n)}</span></span>
                {busy(k) && <span className="tl-tm">{ago(status.get(sid)?.since)}</span>}
                {sid && <span className="tl-go" aria-hidden>›</span>}
              </button>
              {(k === "fix" || k === "idle") && <button className="tm-btn sm" onClick={() => ops.retry(n)}><RotateCcw size={10} aria-hidden /> {k === "fix" ? "Retry" : "Continue"}</button>}
              {k === "you" && <button className="tm-btn sm warn" onClick={() => void ops.go(n)}>Go</button>}
            </div>
          );
        })}
      </div>
      {v.set.status === "approve" && <div className="tl-empty">Approve the parts to start them.</div>}
    </div>
  );
}

/** Where a session sits in its set: the ticket numbers, its own (if a ticket), or whether it is the merge pass. */
function partOf(set: TicketSet, sessionId: string) {
  const ns = Object.keys(set.tickets).sort();
  const n = ns.find((x) => set.tickets[x].session_id === sessionId);
  return { ns, n, merge: !n && set.merge_session === sessionId };
}

/** The ticket crumb's count (prompt box B · ISLAND): which part this is, of how many; "merge" on the merge pass. */
export function TicketPart({ superId, sessionId }: { superId: string; sessionId: string }) {
  // shortcut: polls the set a second time beside TicketBrief's poll, lift the hook into Terminal if a third reader appears.
  const set = useTicketSet(superId);
  if (!set?.tickets) return null;
  const { ns, n, merge } = partOf(set, sessionId);
  if (!n && !merge) return null;
  return <span className="ma-crumb-n">{n ? `${Number(n) || n}/${ns.length}` : "merge"}</span>;
}

/** What a ticket session is, pinned at the top of its transcript: its number of the set, the
 *  super session it came from, what it waits on, its branch and where it merges. */
export function TicketBrief({ superId, sessionId, superTitle }: { superId: string; sessionId: string; superTitle?: string }) {
  const set = useTicketSet(superId);
  if (!set?.tickets) return null;
  const { ns, n, merge } = partOf(set, sessionId);
  if (!n && !merge) return null;
  const t = n ? set.tickets[n] : null;
  const into = set.feature_branch || "the feature branch";
  return (
    <div className="tk-brief" role="note" aria-label={t ? `Part #${n} of ${ns.length}` : "The merge of these parts"}>
      <div className="k"><Ticket size={12} aria-hidden /><span className="caps">{t ? `Part #${n}` : "Merge"}</span>
        <em>{t ? `of ${ns.length}` : `${ns.length} parts`} · from “{superTitle || set.slug.replace(/-/g, " ")}”</em></div>
      <p>{t ? t.title : `One pass of every part's branch into ${into}.`}</p>
      {t && <div className="f">
        <span>needs <b>{t.blocked_by.length ? t.blocked_by.map((b) => `#${b}`).join(", ") : "nothing"}</b></span>
        <span>branch <b>{t.branch}</b></span>
        <span>merges into <b>{into}</b></span>
      </div>}
    </div>
  );
}
/** A session's last turn, polled: quick while it runs, lazy at rest, nothing while hidden.
 *  An answer rereads it (lib/queries CHANGES), so the card it answered goes at once. */
function useTail(sid: string) {
  const r = useQuery({ ...main.session({ id: sid, cursor: 0, tail: 1 }),
    refetchInterval: (q) => (q.state.data?.turns.at(-1)?.status === "running" ? 2500 : 8000) }).data;
  const last = r?.turns[r.turns.length - 1];
  const turn = r && last ? { id: last.id, status: last.status, events: r.events.filter((e) => e.turn_id === last.id) } : null;
  const pending = turn?.status === "running" ? derivePending(turn.events) : [];
  return { turn, q: pending[0] };
}

/** NEEDS YOU: every ticket session that waits on you, one full-width row each, stacked like
 *  a queue above the prompt box, oldest first (the user's call, 2026-11-12: a question in a
 *  small tile was hard to read). A plain pick answers in a tap; anything more opens its session. */
function TicketAsks({ set, kinds, status, onOpenSession, except }: {
  set: TicketSet; kinds: Record<string, Kind>; status: Map<string, SessionStatus>; onOpenSession: (id: string) => void; except?: string;
}) {
  const asking = Object.keys(set.tickets).sort()
    .filter((n) => kinds[n] === "ask" && set.tickets[n].session_id && set.tickets[n].session_id !== except)
    .sort((a, b) => (status.get(set.tickets[a].session_id)?.since ?? 0) - (status.get(set.tickets[b].session_id)?.since ?? 0));
  if (!asking.length) return null;
  return (
    <div className="tk-asks" role="region" aria-label={`${asking.length} part${asking.length === 1 ? "" : "s"} waiting on you`}>
      <div className="tk-asks-h"><Hand size={12} aria-hidden /><span className="caps">Needs you</span><span>{asking.length}</span></div>
      {asking.map((n) => <AskRow key={n} n={n} title={set.tickets[n].title} sid={set.tickets[n].session_id} st={status.get(set.tickets[n].session_id)}
                                 onOpen={() => onOpenSession(set.tickets[n].session_id)} />)}
    </div>
  );
}

function AskRow({ n, title, sid, st, onOpen }: { n: string; title: string; sid: string; st?: SessionStatus; onOpen: () => void }) {
  const { turn, q } = useTail(sid);
  const one = q?.kind === "question" && q.questions?.length === 1 && !q.questions[0].multiSelect ? q.questions[0] : null;
  const ask = q?.kind === "question" ? q.questions?.[0]?.question : q?.kind === "permission" ? `${q.tool_name}: ${q.summary ?? ""}` : st?.label;
  const answer = (body: Parameters<typeof api.respond>[1]) => { if (turn) void api.respond(turn.id, body); };
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
