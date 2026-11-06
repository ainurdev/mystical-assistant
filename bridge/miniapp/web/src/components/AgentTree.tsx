import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TreeRow } from "../lib/api";
import {
  elapsedOf, fmtElapsed, foldRows, isRunning, nextSort, sortLabel, startsOpen, tally, type AgentSort,
} from "../lib/agentrows";

/** One agent's status as the sidebar draws state: filled is happening, a ring is at rest. */
export function agentDot(r: TreeRow): { c: string; fill: boolean } {
  if (r.needs) return { c: "var(--warn)", fill: true };
  if (isRunning(r)) return { c: "var(--ok)", fill: true };
  if (r.conflict || r.status === "failed") return { c: "var(--err)", fill: true };
  return { c: "var(--txl)", fill: false };
}

function AgentRow({ r, on, onOpen }: { r: TreeRow; on: boolean; onOpen: (r: TreeRow) => void }) {
  const d = agentDot(r);
  const body = (
    <>
      <span className="sb-dot" data-work={isRunning(r) ? "" : undefined}
        style={{ background: d.fill ? d.c : "transparent", borderColor: d.c }} title={r.status} />
      <span className="min-w-0 flex-1">
        <span className="at-name">{r.name}</span>
        <span className="sb-meta">
          <span>{r.provider}</span>
          {r.detail ? <span>{r.status}</span> : <span className="at-nodetail">no details available</span>}
        </span>
      </span>
      {r.needs && <span className="at-needs">NEEDS YOU</span>}
      <span className="sb-ago">{fmtElapsed(elapsedOf(r, Date.now() / 1000))}</span>
    </>
  );
  // Nothing to open behind it, so it isn't a button.
  if (!r.detail) return <div className="at-row" data-flat="">{body}</div>;
  return (
    <button type="button" className="at-row" data-on={on ? "" : undefined} onClick={() => onOpen(r)}>
      {body}
    </button>
  );
}

/** A chat's agents, under its row in CHATS. Sort is lifted to the screen so every
 *  chat's fold moves together, and it's saved there. */
export function AgentTree({ rows, sort, onSort, openId, onOpen, stay }: {
  rows: TreeRow[];
  sort: AgentSort;
  onSort: (s: AgentSort) => void;
  openId: string | null;
  onOpen: (r: TreeRow) => void;
  /** Keep the fold open though everything's finished: the chat you're in. */
  stay?: boolean;
}) {
  // null: follow what's going on. A tap makes it yours until you leave the screen.
  const [picked, setPicked] = useState<boolean | null>(null);
  const [all, setAll] = useState(false);
  const open = picked ?? (startsOpen(rows) || !!stay);
  const { shown, hidden } = foldRows(rows, sort, all);
  return (
    <div className="at">
      <div className="at-head">
        <button type="button" className="at-tog" aria-expanded={open} onClick={() => setPicked(!open)}>
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          <span className="truncate">{tally(rows)}</span>
        </button>
        {open && rows.length > 1 && (
          <button type="button" className="at-sort" onClick={() => onSort(nextSort(sort))}
            aria-label={`Sorted by ${sortLabel(sort).toLowerCase()}. Tap for ${sortLabel(nextSort(sort)).toLowerCase()}.`}>
            {sortLabel(sort)}
          </button>
        )}
      </div>
      {open && (
        <>
          {shown.map((r) => (
            <AgentRow key={r.key} r={r} on={r.kind === "member" && r.session_id === openId} onOpen={onOpen} />
          ))}
          {hidden > 0 && (
            <button type="button" className="at-more" onClick={() => setAll(true)}>
              +{hidden} more <ChevronDown size={12} aria-hidden />
            </button>
          )}
          {all && rows.length > 3 && (
            <button type="button" className="at-more" onClick={() => setAll(false)}>show fewer</button>
          )}
        </>
      )}
    </div>
  );
}
