import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, GitMerge, Hand, Maximize2, MoreHorizontal, RotateCcw, Ticket, X } from "lucide-react";
import { api, type SessionStatus, type TicketSet } from "../../api";
import { dagLayout, kindOf, type Kind } from "../../lib/ticketdag";
import { askConfirm } from "../ui/Ask";

/** A ticket set lives in the flow chat that made it (B · MAP, picked 2026-11-12,
 *  .mystical/design-drafts/ticket-card): a card docked above the prompt box whose body
 *  is the live dependency graph, with what waits on you on its last line, and a full
 *  ticket map it opens (the graph large, the picked ticket beside it). This replaced the
 *  left sidebar's TICKETS tab. A ticket's live state comes from its session (App's
 *  status map), so an ask shows here as it does on a session row. The set is polled
 *  while the chat is open: ticket turns end on the bridge with no dashboard event to
 *  announce them. A merged set keeps its full map until you close the card. */

const WORD: Record<Kind, string> = { run: "Running", ask: "Asks you", idle: "Stopped", q: "Waiting", done: "Done", fix: "Fix" };
const COLOR: Record<Kind, string> = { run: "var(--acc)", ask: "var(--warn)", idle: "var(--warn)", q: "var(--txl)", done: "var(--ok)", fix: "var(--err)" };
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hideKey = (folder: string) => `ticketmap.hide:${folder}`;

function Graph({ set, kinds, big, sel, onPick }: {
  set: TicketSet; kinds: Record<string, Kind>; big?: boolean; sel?: string; onPick: (n: string) => void;
}) {
  const ns = Object.keys(set.tickets).sort();
  const g = dagLayout(ns.map((n) => ({ n, blockedBy: set.tickets[n].blocked_by })));
  const inCol = (c: number) => g.nodes.filter((x) => x.col === c).length;
  const rowsMax = Math.max(1, ...Array.from({ length: g.cols }, (_, c) => inCol(c)));
  // Big: a column is 150px whatever the set's width, so labels never overlap; a wide set scrolls sideways.
  const r = big ? 20 : 13, padX = big ? 80 : 30, W = big ? Math.max(560, 2 * padX + (g.cols - 1) * 150) : 680;
  const H = big ? Math.max(260, rowsMax * 110) : Math.max(64, rowsMax * 44);
  const pos = Object.fromEntries(g.nodes.map((x) => [x.n, {
    x: g.cols > 1 ? padX + x.col * ((W - 2 * padX) / (g.cols - 1)) : W / 2,
    y: (H / inCol(x.col)) * (x.row + 0.5) - (big ? 8 : 0),
  }]));
  const merging = set.status === "merging" || set.status === "merged";
  return (
    <svg className={`tm-graph${big ? " big" : ""}`} viewBox={`0 0 ${W} ${H}`} width={big ? W : undefined} height={big ? H : undefined} role="group" aria-label={`Dependency graph of ${ns.length} tickets, then merge`}>
      {g.edges.map((e) => {
        const a = pos[e.from], b = pos[e.to], mx = (a.x + b.x) / 2;
        const live = kinds[e.from] === "done" && (e.to !== "MERGE" || merging);
        return <path key={`${e.from}>${e.to}`} d={`M${a.x + r} ${a.y} C${mx} ${a.y}, ${mx} ${b.y}, ${b.x - r} ${b.y}`} fill="none"
                     stroke={live ? "var(--ok)" : "var(--txl)"} strokeOpacity={live ? 0.55 : 0.3} strokeWidth={big ? 2 : 1.6}
                     strokeDasharray={e.to === "MERGE" && !merging ? "4 4" : undefined} />;
      })}
      {g.nodes.map((x) => {
        const { x: cx, y: cy } = pos[x.n];
        const picked = sel === x.n;
        if (x.n === "MERGE") {
          const c = set.status === "merged" ? "var(--ok)" : set.status === "fix" ? "var(--err)" : merging ? "var(--acc)" : "var(--txl)";
          return (
            <g key="MERGE" className="tm-node" onClick={() => onPick("merge")} role="button" tabIndex={0} aria-label="Merge"
               onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick("merge"); } }}>
              {sel === "merge" && <rect x={cx - r - 8} y={cy - r - 8} width={2 * r + 16} height={2 * r + 16} rx={10} fill="none" stroke="var(--txb)" strokeOpacity={0.6} />}
              <rect x={cx - r} y={cy - r} width={2 * r} height={2 * r} rx={6} fill={merging ? `color-mix(in srgb, ${c} 18%, transparent)` : "none"}
                    stroke={c} strokeDasharray={merging ? undefined : "3 3"} strokeWidth={1.5} />
              <g transform={`translate(${cx - r * 0.55},${cy - r * 0.55}) scale(${(r * 1.1) / 24})`} stroke={c} fill="none" strokeWidth={2.4} strokeLinecap="round">
                <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" />
              </g>
              {big && <text x={cx} y={cy + r + 20} textAnchor="middle" className="tm-lab">Merge</text>}
            </g>
          );
        }
        const k = kinds[x.n], c = COLOR[k];
        return (
          <g key={x.n} className="tm-node" onClick={() => onPick(x.n)} role="button" tabIndex={0}
             aria-label={`#${x.n} ${set.tickets[x.n].title}: ${WORD[k]}`}
             onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(x.n); } }}>
            {(k === "run" || k === "ask") && <circle className="tm-live" cx={cx} cy={cy} r={r + 5} fill="none" stroke={c} strokeOpacity={0.4} strokeWidth={2} />}
            {picked && <circle cx={cx} cy={cy} r={r + 9} fill="none" stroke="var(--txb)" strokeOpacity={0.6} strokeWidth={1.5} />}
            <circle cx={cx} cy={cy} r={r} fill={k === "q" ? "var(--panel2)" : `color-mix(in srgb, ${c} 16%, var(--panel2))`} stroke={c} strokeWidth={2} />
            <text x={cx} y={cy + (big ? 4.5 : 3.8)} textAnchor="middle" fontSize={big ? 12 : 10.5} fontWeight={800} fill={c}>{k === "fix" ? "!" : x.n}</text>
            {big && <text x={cx} y={cy + r + 20} textAnchor="middle" className="tm-lab">{cut(set.tickets[x.n].title, 19)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/** What waits on you first, as the card's last line and the map's default pick. */
function urgent(set: TicketSet, ns: string[], kinds: Record<string, Kind>): string {
  return ns.find((n) => kinds[n] === "ask") ?? ns.find((n) => kinds[n] === "fix") ?? ns.find((n) => kinds[n] === "idle")
    ?? ((set.status === "fix" || set.merge_stalled) ? "merge" : "");
}

export function TicketMapCard({ sessionId, status, onOpenSession }: {
  sessionId: string; status: Map<string, SessionStatus>; onOpenSession: (id: string) => void;
}) {
  const [set, setSet] = useState<TicketSet | null>(null);
  const [gen, setGen] = useState(0);
  const [open, setOpen] = useState<string | null>(null);   // the map, with this ticket picked ("" = the default)
  const [note, setNoteNow] = useState("");
  const [hidden, setHidden] = useState(false);
  const noteT = useRef(0);
  useEffect(() => {
    let live = true, t = 0;
    // Quick while the set builds or merges, lazy when it rests; nothing while the window is hidden.
    const next = (fast: boolean) => { t = window.setTimeout(tick, fast ? 4000 : 15000); };
    const tick = () => {
      if (document.hidden) return next(false);
      // GET /local/flow's `set` is tickets.summary_for: the whole set.json plus its folder.
      api.getFlow(sessionId).then((r) => {
        if (!live) return;
        const s = (r.set as unknown as TicketSet | null) ?? null;
        setSet(s);
        setHidden(!!s && localStorage.getItem(hideKey(s.folder)) === "1");
        next(!!s && (s.status === "building" || s.status === "merging"));
      }).catch(() => { if (live) next(false); });
    };
    tick();
    return () => { live = false; window.clearTimeout(t); };
  }, [sessionId, gen]);
  useEffect(() => () => window.clearTimeout(noteT.current), []);
  if (!set || !set.tickets || hidden) return null;

  // What a retry, build or clean-up answered, for a few seconds: the bridge's replies are the only feedback.
  const setNote = (text: string) => {
    setNoteNow(text);
    window.clearTimeout(noteT.current);
    if (text) noteT.current = window.setTimeout(() => setNoteNow(""), 8000);
  };
  const reload = () => setGen((g) => g + 1);
  const act = (p: Promise<{ text: string }>, fail: string) => { p.then((r) => setNote(r.text), (e) => setNote(e instanceof Error ? e.message : fail)).then(reload); };
  const ns = Object.keys(set.tickets).sort();
  const kinds = Object.fromEntries(ns.map((n) => [n, kindOf(set.tickets[n], status.get(set.tickets[n].session_id)?.state)])) as Record<string, Kind>;
  const name = set.slug.replace(/-/g, " ");
  const count = (k: Kind) => ns.filter((n) => kinds[n] === k).length;
  const done = count("done"), run = count("run"), asks = count("ask");
  const facts = [`${done} of ${ns.length} done`, run && `${run} running`, asks && `${asks} ask${asks > 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  const ops = {
    retry: (n: string) => act(api.retryTicket(set.folder, n), "retry failed"),
    build: () => act(api.buildTickets(set.folder), "build failed"),
    approve: () => act(api.approveTickets(set.folder), "approve failed"),
    clean: async () => {
      if (!(await askConfirm(`Remove ${name}'s ticket worktrees and branches? Anything unmerged or uncommitted stays; ignored files in those worktrees (.env, .mystical/) go with them.`, { ok: "Clean up" }))) return;
      try {
        const r = await api.cleanupTickets(set.folder);
        setNote(`removed ${r.removed.length}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`);
      } catch (e) { setNote(e instanceof Error ? e.message : "clean-up failed"); }
    },
  };
  const first = urgent(set, ns, kinds);
  const t = first && first !== "merge" ? set.tickets[first] : null;
  const branch = set.feature_branch || "the feature branch";
  const line = note ? <span>{note}</span>
    : set.status === "approve" ? <span>Waiting for your approval before any ticket starts.</span>
    : set.status === "stopped" ? <span className="err">Stopped: {set.error || "BUILD could not start"}</span>
    : t && kinds[first] === "ask" ? <span><b className="warn"><Hand size={13} aria-hidden /> #{first} asks you:</b> {status.get(t.session_id)?.label || "waiting for your answer"}</span>
    : t && kinds[first] === "fix" ? <span><b className="err">#{first} needs a fix:</b> {t.why || "its turn failed"}</span>
    : t ? <span><b className="warn">#{first} stopped</b> without finishing</span>
    : first === "merge" ? <span className={set.status === "fix" ? "err" : "warn"}>The merge {set.status === "fix" ? "needs a fix" : "stopped without finishing"}</span>
    : set.status === "merged" ? <span className="ok">Merged into {branch}</span>
    : set.status === "merging" ? <span>Merging {set.merged} of {ns.length} into {branch}</span>
    : <span>{run ? `${run} running` : "Starting"} · merge runs once all {ns.length} are done</span>;
  const action = note ? null
    : set.status === "approve" ? <button className="tm-btn acc" onClick={ops.approve}>Approve &amp; build</button>
    : set.status === "stopped" ? <button className="tm-btn" onClick={ops.build}>Build</button>
    : t && kinds[first] === "ask" ? <button className="tm-btn" onClick={() => onOpenSession(t.session_id)}>Answer</button>
    : t && kinds[first] === "fix" ? <button className="tm-btn" onClick={() => ops.retry(first)}>Retry</button>
    : t ? <button className="tm-btn" onClick={() => ops.retry(first)}>Continue</button>
    : first === "merge" ? <button className="tm-btn" onClick={() => ops.retry("merge")}>{set.status === "fix" ? "Retry" : "Continue"}</button>
    : null;
  return (
    <div className="tm-card" role="region" aria-label={`Tickets: ${name}`}>
      <div className="tm-hd">
        <Ticket size={14} aria-hidden className="tm-ic" /><span className="caps tm-k">Tickets</span><span className="tm-nm">{name}</span>
        <span className="tm-c">{facts}</span>
        {set.status === "merged" && (
          <button className="tm-x" aria-label={`Close the ${name} card`} title="Close (the set stays merged)"
                  onClick={() => { localStorage.setItem(hideKey(set.folder), "1"); setHidden(true); }}><X size={13} aria-hidden /></button>
        )}
      </div>
      <Graph set={set} kinds={kinds} onPick={(n) => setOpen(n)} />
      <div className="tm-ft">
        <span className="tm-line">{line}</span>
        {action}
        <button className="tm-btn acc" onClick={() => setOpen("")}>Open map <Maximize2 size={11} aria-hidden /></button>
      </div>
      {open !== null && createPortal(
        <TicketMapPane set={set} kinds={kinds} name={name} facts={facts} pick={open || first || ns.find((n) => kinds[n] === "run") || ns[0]}
                       status={status} note={note} ops={ops} onOpenSession={onOpenSession} onClose={() => setOpen(null)} />, document.body)}
    </div>
  );
}

function TicketMapPane({ set, kinds, name, facts, pick, status, note, ops, onOpenSession, onClose }: {
  set: TicketSet; kinds: Record<string, Kind>; name: string; facts: string; pick: string; status: Map<string, SessionStatus>; note: string;
  ops: { retry: (n: string) => void; build: () => void; approve: () => void; clean: () => void };
  onOpenSession: (id: string) => void; onClose: () => void;
}) {
  const [sel, setSel] = useState(pick);
  const [menu, setMenu] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    shell.current?.focus();
    // Esc is the map's only while focus is in it: a confirm opened over it takes its own.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && shell.current?.contains(document.activeElement)) { e.stopPropagation(); if (menu) setMenu(false); else onClose(); } };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); prev?.focus?.(); };
  }, [menu, onClose]);
  const ns = Object.keys(set.tickets).sort();
  const t = sel !== "merge" ? set.tickets[sel] : null;
  const k = t ? kinds[sel] : null;
  const holds = t ? ns.filter((n) => set.tickets[n].blocked_by.includes(sel)) : [];
  const open = (sid: string) => { onClose(); onOpenSession(sid); };
  const branch = set.feature_branch || "the feature branch";
  const legend: Kind[] = ["done", "run", "ask", "q", "fix"];
  return (
    <div className="tm-pane" role="dialog" aria-modal="true" aria-label={`Ticket map: ${name}`} ref={shell} tabIndex={-1}>
      <div className="tm-ph">
        <button className="tm-back" onClick={onClose}><ChevronLeft size={14} aria-hidden /> Back to chat</button>
        <span className="tm-sep" />
        <Ticket size={18} aria-hidden className="tm-ic" /><h2>{name}</h2>
        <span className="tm-c">{facts}{set.feature_branch ? ` · ⎇ ${set.feature_branch}` : ""}</span>
        {note && <span className="tm-c" role="status">{note}</span>}
        <span style={{ flex: 1 }} />
        {set.status === "approve" && <button className="tm-btn acc" onClick={ops.approve}>Approve &amp; build</button>}
        {set.status === "stopped" && <button className="tm-btn" onClick={ops.build}>Build</button>}
        {set.status === "merged" && (
          <span style={{ position: "relative" }}>
            <button className="tm-btn ghost" aria-label={`More for ${name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={14} aria-hidden /></button>
            {menu && <div className="tm-menu" role="menu"><button role="menuitem" onClick={() => { setMenu(false); void ops.clean(); }}>Clean up worktrees</button></div>}
          </span>
        )}
      </div>
      <div className="tm-body">
        <div className="tm-map">
          <Graph set={set} kinds={kinds} big sel={sel} onPick={setSel} />
          <div className="tm-legend">{legend.map((x) => <span key={x}><i style={{ background: COLOR[x] }} />{WORD[x]}</span>)}</div>
        </div>
        <aside className="tm-det">
          {t && k ? (
            <>
              <span className="tm-no">#{sel}{t.branch ? ` · ${t.branch}` : ""}</span>
              <h3>{t.title}</h3>
              <span className={`tm-pill ${k}`}>{WORD[k]}</span>
              {k === "ask" && (
                <div className="tm-q">
                  <span className="caps">Its question</span>
                  <p>{status.get(t.session_id)?.label || "It waits for your answer in its session."}</p>
                  <button className="tm-btn warn" onClick={() => open(t.session_id)}>Answer in its session</button>
                </div>
              )}
              <dl>
                <dt>Blocked by</dt><dd>{t.blocked_by.length ? t.blocked_by.map((b) => `#${b} · ${WORD[kinds[b]].toLowerCase()}`).join(", ") : "nothing"}</dd>
                <dt>Holds</dt><dd>{holds.length ? holds.map((h) => `#${h} ${set.tickets[h].title}`).join(", ") : "the merge"}</dd>
                {k === "run" && status.get(t.session_id)?.label && <><dt>Now</dt><dd>{status.get(t.session_id)!.label}</dd></>}
                {k === "fix" && <><dt>Why</dt><dd>{t.why || "its turn failed"}</dd></>}
                {k === "idle" && <><dt>Why</dt><dd>its turn ended without finishing</dd></>}
                {t.status === "missing" && <><dt>Why</dt><dd>its ticket file is missing</dd></>}
              </dl>
              <div className="tm-acts">
                {t.session_id && <button className="tm-btn" onClick={() => open(t.session_id)}>Open session</button>}
                {(k === "fix" || k === "idle") && <button className="tm-btn" onClick={() => ops.retry(sel)}><RotateCcw size={11} aria-hidden /> {k === "fix" ? "Retry" : "Continue"}</button>}
              </div>
            </>
          ) : (
            <>
              <span className="tm-no"><GitMerge size={12} aria-hidden /> Merge</span>
              <h3>Merge into {branch}</h3>
              <span className={`tm-pill ${set.status === "merged" ? "done" : set.status === "fix" ? "fix" : set.status === "merging" ? "run" : "q"}`}>
                {set.status === "merged" ? "Done" : set.status === "fix" ? "Fix" : set.status === "merging" ? `${set.merged} of ${ns.length} merged` : `${ns.filter((n) => kinds[n] !== "done").length} to go`}
              </span>
              <dl>
                <dt>How</dt><dd>One pass, once every ticket is done, each branch merged in order.</dd>
                {set.merge_stalled && <><dt>Why</dt><dd>its turn ended without finishing</dd></>}
              </dl>
              <div className="tm-acts">
                {set.merge_session && <button className="tm-btn" onClick={() => open(set.merge_session!)}>Open session</button>}
                {(set.status === "fix" || set.merge_stalled) && <button className="tm-btn" onClick={() => ops.retry("merge")}><RotateCcw size={11} aria-hidden /> {set.status === "fix" ? "Retry" : "Continue"}</button>}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
