import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronUp, GitMerge, Hand, Maximize2, MoreHorizontal, RotateCcw, Ticket, Zap } from "lucide-react";
import { api, type SessionStatus, type TicketSet } from "../../api";
import { dagLayout, kindOf, type Kind } from "../../lib/ticketdag";
import { askConfirm } from "../ui/Ask";

/** A ticket set lives in the flow chat that made it: a strip docked above the prompt box,
 *  and a full ticket map it opens (A · WAVES, picked 2026-11-12, .mystical/design-drafts/
 *  ticket-map-v2; it replaced the left sidebar's TICKETS tab). Every ready ticket starts at
 *  once, so a graph column (1 + its longest blocker chain) is a wave that runs together:
 *  the columns are drawn as labelled waves, the first unfinished one lit as NOW, and the
 *  edges into running tickets march. The strip is one line (a dot group per wave, what
 *  waits on you, its button) so it never eats the chat; its chevron opens the graph in
 *  place, remembered per set. A merged set stays a strip that opens to its full map:
 *  there is no dismiss that can't be undone. A ticket's live state comes from its session
 *  (App's status map); the set is polled while the chat is open, since ticket turns end
 *  on the bridge with no dashboard event to announce them. */

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

export function TicketMapCard({ sessionId, status, onOpenSession }: {
  sessionId: string; status: Map<string, SessionStatus>; onOpenSession: (id: string) => void;
}) {
  const [set, setSet] = useState<TicketSet | null>(null);
  const [gen, setGen] = useState(0);
  const [open, setOpen] = useState<string | null>(null);   // the map, with this ticket picked ("" = the default)
  const [note, setNoteNow] = useState("");
  const [wide, setWide] = useState(false);
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
        setWide(!!s && localStorage.getItem(openKey(s.folder)) === "1");
        next(!!s && (s.status === "building" || s.status === "merging"));
      }).catch(() => { if (live) next(false); });
    };
    tick();
    return () => { live = false; window.clearTimeout(t); };
  }, [sessionId, gen]);
  useEffect(() => () => window.clearTimeout(noteT.current), []);
  if (!set || !set.tickets) return null;

  // What a retry, build or clean-up answered, for a few seconds: the bridge's replies are the only feedback.
  const setNote = (text: string) => {
    setNoteNow(text);
    window.clearTimeout(noteT.current);
    if (text) noteT.current = window.setTimeout(() => setNoteNow(""), 8000);
  };
  const reload = () => setGen((g) => g + 1);
  const act = (p: Promise<{ text: string }>, fail: string) => { p.then((r) => setNote(r.text), (e) => setNote(e instanceof Error ? e.message : fail)).then(reload); };
  const toggle = () => { const v = !wide; setWide(v); if (v) localStorage.setItem(openKey(set.folder), "1"); else localStorage.removeItem(openKey(set.folder)); };
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
      if (!(await askConfirm(`Remove ${name}'s ticket worktrees and branches? Anything unmerged or uncommitted stays; ignored files in those worktrees (.env, .mystical/) go with them.`, { ok: "Clean up" }))) return;
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
  // The expanded strip's last line: what runs together now, and what starts next.
  const together = ns.filter((n) => busy(kinds[n]));
  const nextUp = ns.find((n) => kinds[n] === "q" && set.tickets[n].blocked_by.every((b) => kinds[b] === "done" || busy(kinds[b])));
  const waitsOn = nextUp ? set.tickets[nextUp].blocked_by.filter((b) => kinds[b] !== "done") : [];
  return (
    <div className="tm-card" role="region" aria-label={`Tickets: ${name}`}>
      <div className="tm-row">
        <Ticket size={15} aria-hidden className="tm-ic" /><span className="caps tm-k">Tickets</span><span className="tm-nm">{name}</span>
        <span className="tm-div" />
        <span className="tm-dots" aria-hidden>
          {Array.from({ length: g.cols }, (_, c) => (
            <span key={c} className={`tm-wv${c === now ? " now" : ""}`}>
              {c === g.cols - 1 ? <i className="m" />
                : g.nodes.filter((x) => x.col === c).map((x) => <i key={x.n} style={kinds[x.n] === "q" ? undefined : { background: COLOR[kinds[x.n]], color: COLOR[kinds[x.n]] }} className={busy(kinds[x.n]) ? "on" : undefined} />)}
            </span>
          ))}
        </span>
        <span className="tm-c">{facts}</span>
        {call && <><span className="tm-div" />{call}</>}
        <span style={{ flex: 1 }} />
        {action}
        <button className="tm-btn ghost" onClick={toggle} aria-expanded={wide} aria-label={wide ? "Fold the ticket graph" : "Show the ticket graph"} title={wide ? "Fold" : "Show the graph"}>
          {wide ? <ChevronUp size={15} aria-hidden /> : <ChevronDown size={15} aria-hidden />}
        </button>
        <button className="tm-btn acc" onClick={() => setOpen("")} aria-label="Open the ticket map"><span className="tm-open-w">Open map</span> <Maximize2 size={11} aria-hidden /></button>
      </div>
      {wide && (
        <>
          <div className="tm-body-s"><Graph set={set} kinds={kinds} status={status} onPick={(n) => setOpen(n)} /></div>
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
      {open !== null && createPortal(
        <TicketMapPane set={set} kinds={kinds} status={status} name={name} pick={open || first || ns.find((n) => busy(kinds[n])) || ns[0]}
                       note={note} ops={ops} onOpenSession={onOpenSession} onClose={() => setOpen(null)} />, document.body)}
    </div>
  );
}

function TicketMapPane({ set, kinds, status, name, pick, note, ops, onOpenSession, onClose }: {
  set: TicketSet; kinds: Record<string, Kind>; status: Map<string, SessionStatus>; name: string; pick: string; note: string;
  ops: { retry: (n: string) => void; build: () => void; approve: () => void; clean: () => void };
  onOpenSession: (id: string) => void; onClose: () => void;
}) {
  const [sel, setSel] = useState(pick);
  const [menu, setMenu] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    shell.current?.focus();
    // Esc and Tab are the map's only while focus is in it: a confirm opened over it takes its own.
    const key = (e: KeyboardEvent) => {
      const el = shell.current;
      if (!el || !el.contains(document.activeElement)) return;
      if (e.key === "Escape") { e.stopPropagation(); if (menu) setMenu(false); else onClose(); }
      if (e.key === "Tab") {   // keep focus inside the map: it covers the whole app
        const f = [...el.querySelectorAll<HTMLElement | SVGElement>("button, [tabindex='0']")];
        if (!f.length) return;
        const at = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && at === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); prev?.focus?.(); };
  }, [menu, onClose]);
  const ns = Object.keys(set.tickets).sort();
  const { g, ticketCols, now } = waves(set, kinds);
  const t = sel !== "merge" ? set.tickets[sel] : null;
  const k = t ? kinds[sel] : null;
  const holds = t ? ns.filter((n) => set.tickets[n].blocked_by.includes(sel)) : [];
  const col = t ? g.nodes.find((x) => x.n === sel)?.col ?? 0 : 0;
  const mates = t ? g.nodes.filter((x) => x.col === col && x.n !== sel && x.n !== "MERGE").map((x) => `#${x.n}`) : [];
  const open = (sid: string) => { onClose(); onOpenSession(sid); };
  const branch = set.feature_branch || "the feature branch";
  const n = (want: (k: Kind) => boolean) => ns.filter((x) => want(kinds[x])).length;
  const counts: [number, string, string][] = [
    [n((x) => x === "done"), "done", COLOR.done], [n(busy), "at work", COLOR.run], [n((x) => x === "fix"), "fix", COLOR.fix], [n((x) => x === "q"), "waiting", COLOR.q]];
  const legend: Kind[] = ["done", "run", "ask", "q", "fix"];
  const took = t && k && busy(k) ? ago(status.get(t.session_id)?.since) : "";
  return (
    <div className="tm-pane" role="dialog" aria-modal="true" aria-label={`Ticket map: ${name}`} ref={shell} tabIndex={-1}>
      <div className="tm-ph">
        <button className="tm-back" onClick={onClose}><ChevronLeft size={14} aria-hidden /> Back to chat</button>
        <span className="tm-sep" />
        <Ticket size={18} aria-hidden className="tm-ic" /><h2>{name}</h2>
        <span className="tm-c">{note || "every ready ticket runs at once · merge when all are done"}</span>
        <span style={{ flex: 1 }} />
        <span className="tm-cnt">{counts.filter(([v], i) => v || i < 2).map(([v, w, c]) => <span key={w}><i style={{ background: c }} /><b>{v}</b>{w}</span>)}</span>
        {set.feature_branch && <><span className="tm-sep" /><span className="tm-c">⎇ {set.feature_branch}</span></>}
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
          <div className="tm-canvas"><Graph set={set} kinds={kinds} status={status} big sel={sel} onPick={setSel} /></div>
          <div className="tm-legend">{legend.map((x) => <span key={x}><i style={{ background: COLOR[x] }} />{WORD[x]}</span>)}</div>
        </div>
        <aside className="tm-det">
          {set.status === "stopped" && <div className="tm-stop" role="alert"><b>Stopped:</b> {set.error || "BUILD could not start"}</div>}
          {t && k ? (
            <>
              <span className="tm-no">#{sel}{t.branch ? ` · ${t.branch}` : ""}</span>
              <h3>{t.title}</h3>
              <span className={`tm-pill ${k}`}>{k === "ask" && <Hand size={12} aria-hidden />}{WORD[k]}{took && ` · ${took}`}</span>
              {k === "ask" && (
                <div className="tm-q">
                  <span className="caps">Its question</span>
                  <p>{status.get(t.session_id)?.label || "It waits for your answer in its session."}</p>
                  <button className="tm-btn warn" onClick={() => open(t.session_id)}>Answer in its session</button>
                </div>
              )}
              <dl>
                <dt>Wave</dt><dd>{col + 1} of {ticketCols}{col === now ? " · now" : ""}{mates.length ? ` · with ${mates.join(", ")}` : ""}</dd>
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
                {set.status === "merged" ? "Done" : set.status === "fix" ? "Fix" : set.status === "merging" ? `${set.merged} of ${ns.length} merged` : `${ns.filter((x) => kinds[x] !== "done").length} to go`}
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
