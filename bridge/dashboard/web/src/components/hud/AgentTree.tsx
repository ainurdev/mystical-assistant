import { useEffect, useRef, useState } from "react";
import { fmtClock, fmtSpan } from "../../lib/subagents";
import { canOpen, elapsedOf, foldRows, isRunning, rowTags, statusWord, tally, TREE_SORTS, asSort, type AgentRow, type TreeSort } from "../../lib/multi";
import { useTreeRows } from "../../lib/multistore";
import { openAgentRow } from "../../lib/multiopen";
import { useStickyStr } from "../../lib/prefs";
import { SPIN } from "../AgentsModal";
import { RowTag } from "../MultiRows";

/* A chat's agents, beneath its row in the sidebar (plan §6): Mystical's helpers,
   Claude's own subagents and workflows, and what another provider's own
   sub-agents we can only say exist. It opens while they run and shuts when
   they're done, unless you've said otherwise since they last started. Shut or
   short, what needs you is on show (lib/multi foldRows), and the header counts it
   whatever's folded. A chat with no agents draws nothing at all. */

const useSpin = (live: boolean) => {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setT((n) => n + 1), 110);
    return () => window.clearInterval(id);
  }, [live]);
  return t;
};

/** Spinner while it runs, the same hollow ring AGENTS draws after, a mark on what waits. */
export function AgentGlyph({ row, frame }: { row: AgentRow; frame: number }) {
  if (row.needs) return <span className="ma-g" data-needs aria-label="needs you">!</span>;
  if (isRunning(row)) return <span className="ma-g" data-live aria-hidden>{SPIN[frame % SPIN.length]}</span>;
  return <span className="ma-g" aria-hidden><i className="agm-ring" /></span>;
}

export const rowClock = (r: AgentRow, now: number) => {
  const s = elapsedOf(r, now);
  return s === null ? "" : isRunning(r) ? fmtClock(s) : fmtSpan(s);
};

function TreeRow({ row, on, frame }: { row: AgentRow; on: boolean; frame: number }) {
  const open = canOpen(row);
  const now = Date.now() / 1000;
  const inner = (
    <>
      <AgentGlyph row={row} frame={frame} />
      <span className="ma-tr-name">{row.name}</span>
      {rowTags(row).map((t) => <RowTag key={t.text} {...t} />)}
      <span className="ma-tr-prov">{open ? row.provider : "no details available"}</span>
      <span className="ma-tr-time">{rowClock(row, now)}</span>
    </>
  );
  const title = `${row.name} · ${row.provider} · ${row.needs ? "needs you" : statusWord(row.status)}${row.owner && row.owner !== "main" ? ` · under ${row.owner}` : ""}`;
  return open
    ? <button type="button" className="ma-tr-row" data-on={on || undefined} data-needs={row.needs || undefined} title={title} onClick={() => openAgentRow(row)}>{inner}</button>
    : <div className="ma-tr-row" data-flat title={title}>{inner}</div>;
}

export function AgentTree({ chatId, selectedId }: { chatId: string; selectedId: string | null }) {
  const rows = useTreeRows(chatId);
  const [saved, setSaved] = useStickyStr("hud-agent-tree-sort", "attention");
  const sort: TreeSort = asSort(saved);
  // null: follow the agents. A click pins it until they next start up.
  const [pick, setPick] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { total, running, needs } = tally(rows);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running > 0 && wasRunning.current === 0) setPick(null);
    wasRunning.current = running;
  }, [running]);
  const holdsOpen = rows.some((r) => r.session_id === selectedId && r.kind === "member");
  const open = pick ?? (running > 0 || needs > 0 || holdsOpen);
  const frame = useSpin(open && running > 0);
  if (!total) return null;
  const { shown, hidden } = foldRows(rows, sort, expanded);
  return (
    <div className="ma-tree" onClick={(e) => e.stopPropagation()}>
      <div className="ma-tr-head">
        <button type="button" className="ma-tr-fold" aria-expanded={open} onClick={() => setPick(!open)}>
          <span aria-hidden className="ma-tr-car">{open ? "▾" : "▸"}</span>
          <span>{total} agent{total === 1 ? "" : "s"}</span>
          {running > 0 && <span className="ma-tr-live">{running} working</span>}
          {needs > 0 && <span className="ma-tr-needs">{needs} need{needs === 1 ? "s" : ""} you</span>}
        </button>
        {open && total > 1 && (
          <select className="ma-sort" aria-label="Sort agents" title="Sort agents, saved on this device"
            value={sort} onChange={(e) => setSaved(e.target.value)}>
            {TREE_SORTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}
      </div>
      {open && (
        <div className="ma-tr-list">
          {shown.map((r) => <TreeRow key={r.key} row={r} on={r.kind === "member" && r.session_id === selectedId} frame={frame} />)}
          {(hidden > 0 || expanded) && (
            <button type="button" className="ma-tr-more" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
              {expanded ? "show fewer" : `+${hidden} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
