import { useEffect, useState } from "react";
import { GitMerge, Hourglass, MoreHorizontal, Ticket } from "lucide-react";
import { api, type SessionBrief, type SessionStatus, type TicketRow, type TicketSet } from "../../api";
import { dagLayout } from "../../lib/ticketdag";
import { askConfirm } from "../ui/Ask";

/** The TICKETS tab of the left sidebar: each ticket set as a card with its dependency
 *  graph, then one stub per ticket, then MERGE. A ticket's live state comes from its
 *  session (App's status map), so an ask shows here as it does on a session row. The
 *  sets are polled while the tab is open: ticket turns end on the bridge with no
 *  dashboard event to announce them. A finished set folds to a line. */

type Kind = "run" | "ask" | "q" | "done" | "fix";
const WORD: Record<Kind, string> = { run: "RUN", ask: "ASK", q: "WAIT", done: "DONE", fix: "FIX" };
const COLOR: Record<Kind, string> = { run: "var(--ok)", ask: "var(--warn)", q: "var(--txl)", done: "var(--ok)", fix: "var(--err)" };
const ASKING = ["awaiting", "asking", "credits"];

const kindOf = (t: TicketRow, st?: SessionStatus): Kind =>
  t.status === "done" ? "done" : t.status === "fix" ? "fix"
    : t.status === "running" ? (st && ASKING.includes(st.state) ? "ask" : "run") : "q";

function Dag({ set, kinds }: { set: TicketSet; kinds: Record<string, Kind> }) {
  const ns = Object.keys(set.tickets).sort();
  const g = dagLayout(ns.map((n) => ({ n, blockedBy: set.tickets[n].blocked_by })));
  const inCol = (c: number) => g.nodes.filter((x) => x.col === c).length;
  const rowsMax = Math.max(...Array.from({ length: g.cols }, (_, c) => inCol(c)));
  const H = Math.max(40, rowsMax * 28), W = 300;
  const pos = Object.fromEntries(g.nodes.map((x) => [x.n, {
    x: g.cols > 1 ? 28 + x.col * ((W - 56) / (g.cols - 1)) : W / 2,
    y: (H / inCol(x.col)) * (x.row + 0.5),
  }]));
  const merging = set.status === "merging" || set.status === "merged";
  return (
    <svg className="tk-dag" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Dependency graph of ${ns.length} tickets, then merge`}>
      {g.edges.map((e) => {
        const a = pos[e.from], b = pos[e.to], mx = (a.x + b.x) / 2;
        const live = kinds[e.from] === "done" && (e.to !== "MERGE" || merging);
        return <path key={`${e.from}>${e.to}`} d={`M${a.x + 22} ${a.y} C${mx} ${a.y}, ${mx} ${b.y}, ${b.x - 22} ${b.y}`} fill="none"
                     stroke={live ? "var(--ok)" : "var(--txl)"} strokeOpacity={live ? 0.7 : 0.35} strokeWidth={1.5} strokeDasharray={live ? undefined : "3 4"} />;
      })}
      {g.nodes.map((x) => {
        const { x: cx, y: cy } = pos[x.n];
        if (x.n === "MERGE") return (
          <g key="MERGE">
            <rect x={cx - 22} y={cy - 11} width={44} height={22} rx={11} fill={merging ? "color-mix(in srgb, var(--acc) 22%, transparent)" : "none"}
                  stroke={merging ? "var(--acc)" : "var(--txl)"} strokeOpacity={merging ? 1 : 0.5} strokeDasharray={merging ? undefined : "3 3"} />
            <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize={9} fontWeight={800} letterSpacing={1} fill={merging ? "var(--acc2, var(--acc))" : "var(--txl)"}>MERGE</text>
          </g>
        );
        const k = kinds[x.n], c = COLOR[k];
        return (
          <g key={x.n}>
            <rect x={cx - 22} y={cy - 10} width={44} height={20} rx={5} fill={k === "q" ? "none" : `color-mix(in srgb, ${c} ${k === "done" ? 16 : 22}%, transparent)`}
                  stroke={c} strokeOpacity={k === "q" ? 0.45 : 0.9} strokeDasharray={k === "q" ? "3 3" : undefined} />
            <circle cx={cx - 22} cy={cy} r={3.2} fill="var(--tk-side)" /><circle cx={cx + 22} cy={cy} r={3.2} fill="var(--tk-side)" />
            <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize={10} fontWeight={800} fill={c}>{k === "done" ? "✓" : k === "fix" ? "!" : ""}#{x.n}</text>
            {(k === "run" || k === "ask") && <rect className="tk-live" x={cx - 25} y={cy - 13} width={50} height={26} rx={7} fill="none" stroke={c} strokeOpacity={0.35} />}
          </g>
        );
      })}
    </svg>
  );
}

function Stub({ n, t, kind, st, onOpen, onRetry }: {
  n: string; t: TicketRow; kind: Kind; st?: SessionStatus; onOpen: () => void; onRetry: () => void;
}) {
  const live = kind === "ask" ? <span style={{ color: "var(--warn)" }}>asks: {st?.label || "waiting for your answer"}</span>
    : kind === "run" ? <span className="tk-live" style={{ color: "var(--ok)" }}>● {st?.label || (t.status === "retry" ? "retrying" : "working")}</span>
    : kind === "done" ? <span style={{ color: "var(--ok)" }}>✓ done</span>
    : kind === "fix" ? <span style={{ color: "var(--err)" }}>needs a fix</span>
    : <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Hourglass size={10} aria-hidden />
        {t.blocked_by.length ? `waits for ${t.blocked_by.map((b) => `#${b}`).join(" · ")}` : t.status === "missing" ? "ticket file missing" : "next in line"}</span>;
  const word = t.status === "retry" ? "RETRY" : WORD[kind];
  return (
    <div className={`tk-stub ${kind}`}>
      {t.session_id && <button className="tk-hit" onClick={onOpen} aria-label={`Open ticket ${n}, ${t.title}`} />}
      <div className="no">#{n}<small>{word}</small></div>
      <div className="bd">
        <div className="t1"><span>{t.title}</span>
          {kind === "ask" && <button className="tk-btn" onClick={onOpen} aria-label={`Answer ticket ${n}`}>Answer</button>}
          {kind === "fix" && <button className="tk-btn err" onClick={onRetry} aria-label={`Retry ticket ${n}`}>Retry</button>}
          {kind === "q" && <span className="r" style={{ color: "var(--txl)" }}>queued</span>}
        </div>
        <div className="t2"><span>⎇ {t.branch}</span>{live}</div>
      </div>
    </div>
  );
}

function SetCard({ set, parent, sessions, status, onOpenSession, reload }: {
  set: TicketSet; parent?: string; sessions: Map<string, SessionBrief>; status: Map<string, SessionStatus>;
  onOpenSession: (s: SessionBrief) => void; reload: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState("");
  const ns = Object.keys(set.tickets).sort();
  const kinds = Object.fromEntries(ns.map((n) => [n, kindOf(set.tickets[n], status.get(set.tickets[n].session_id))])) as Record<string, Kind>;
  const name = set.slug.replace(/-/g, " ").toUpperCase();
  const open = (sid: string) => { const s = sessions.get(sid); if (s) onOpenSession(s); };
  const retry = (n: string) => { void api.retryTicket(set.folder, n).then(reload, reload); };
  const running = ns.filter((n) => kinds[n] === "run" || kinds[n] === "ask").length;

  if (set.status === "merged") {
    const clean = async () => {
      setMenu(false);
      if (!(await askConfirm(`Remove ${name}'s ticket worktrees and branches? Anything unmerged or uncommitted stays.`, { ok: "Clean up" }))) return;
      try {
        const r = await api.cleanupTickets(set.folder);
        setNote(`removed ${r.removed.length}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`);
      } catch (e) { setNote(e instanceof Error ? e.message : "clean-up failed"); }
    };
    return (
      <div className="tk-fold">
        <Ticket size={13} aria-hidden /><span className="nm">{name}</span><span>{ns.length} tickets</span>
        <span style={{ marginLeft: "auto", color: "var(--ok)" }}>{note || "merged ✓"}</span>
        <button className="tk-more" aria-label={`More for ${name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={14} aria-hidden /></button>
        {menu && <div className="tk-menu" role="menu"><button role="menuitem" onClick={clean}>Clean up worktrees</button></div>}
      </div>
    );
  }

  const merging = set.status === "merging";
  const mfix = set.status === "fix";
  return (
    <>
      <div className="tk-set">
        <div className="hd">
          <span style={{ color: "var(--acc2, var(--acc))", display: "inline-flex" }}><Ticket size={14} aria-hidden /></span><span className="nm">{name}</span>
          {merging ? <span className="tk-pill">MERGING</span>
            : <span className="tk-slots" role="img" aria-label={`${running} of 3 running`}>{[0, 1, 2].map((i) => <i key={i} className={i < running ? "on" : ""} />)}</span>}
        </div>
        <div className="sub">{parent && <>from <b>{parent}</b> · </>}⎇ {set.feature_branch}</div>
        <Dag set={set} kinds={kinds} />
      </div>
      {ns.map((n) => {
        const t = set.tickets[n];
        return <Stub key={`${set.folder}#${n}`} n={n} t={t} kind={kinds[n]} st={status.get(t.session_id)}
                     onOpen={() => open(t.session_id)} onRetry={() => retry(n)} />;
      })}
      <div className={`tk-stub mg ${merging ? "run" : mfix ? "fix" : ""}`}>
        <div className="no"><GitMerge size={15} aria-hidden /><small>{merging ? `${set.merged} / ${ns.length}` : mfix ? "FIX" : "LAST"}</small></div>
        <div className="bd">
          <div className="t1"><span>Merge into {set.feature_branch}</span>
            {mfix ? <button className="tk-btn err" onClick={() => retry("merge")} aria-label="Retry the merge">Retry</button>
              : <span className="r" style={{ color: "var(--txl)" }}>{merging ? "" : `after all ${ns.length}`}</span>}
          </div>
          <div className="t2"><span>{set.status === "stopped" ? set.error || "stopped" : merging ? "one pass into the feature branch" : "one pass when the last ticket is done"}</span></div>
        </div>
      </div>
    </>
  );
}

export function TicketsMode({ sessions, status, onSelectSession }: {
  sessions: SessionBrief[]; status: Map<string, SessionStatus>; onSelectSession: (s: SessionBrief) => void;
}) {
  const [sets, setSets] = useState<TicketSet[] | null>(null);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => { api.tickets().then((r) => { if (live) setSets(r.sets); }).catch(() => { /* keep the last answer */ }); };
    load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [gen]);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  if (sets && sets.length === 0) return <div style={{ padding: "18px 12px", fontSize: "var(--t95)", color: "var(--txl)" }}>No ticket sets yet. A feature path's TICKETS step makes one.</div>;
  return (
    <div className="tk-list">
      {(sets ?? []).map((set) => (
        <SetCard key={set.folder} set={set} parent={byId.get(set.parent_session)?.title ?? undefined} sessions={byId} status={status}
                 onOpenSession={onSelectSession} reload={() => setGen((g) => g + 1)} />
      ))}
    </div>
  );
}
