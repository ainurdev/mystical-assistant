import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import {
  STATE_WORD, canReset, cellWhy, gridClick, levelTag, type AgentRef, type Cell, type Level, type Section,
} from "../../lib/agenttools";

/* The one grid behind MCP, Skills, Tools and Mystical tools. A row is a thing, a column an
   agent. It reads well at 30+ rows because it stays still: a fixed layout, every cell the
   same two lines (the state, then who set it) and the reset's place held whether or not
   there's a reset, so nothing shifts when a pick lands. The header and the name column stay
   in view in the grid's own scroller.

   Keyboard: one stop in the tab order, the arrows walk the rest (a roving tabindex, set on
   the DOM after each render so a filtered row can't strand it). Enter and Space are the
   buttons' own. A click on a cell that can't flip opens its row, which says why. */

export interface GridRow { id: string; title: string; sub?: string; hint?: string; cells: Record<string, Cell> }

export function ToolGridTable({ section, rows, agents, level, busy, open, onOpen, onCell, onReset, held, detail, nameHead }: {
  section: Section;
  rows: GridRow[];
  agents: AgentRef[];
  level: Level;
  /** The cell mid-save, as `${row}|${agent}`. */
  busy: Set<string>;
  open: string | null;
  onOpen: (id: string | null) => void;
  onCell: (row: GridRow, agent: AgentRef, cell: Cell) => void;
  onReset: (row: GridRow, agent: AgentRef) => void;
  /** A pick that can't flip here though it reads off: the chat's own ⚒ switch. */
  held?: (row: GridRow, cell: Cell) => boolean;
  detail: (row: GridRow) => ReactNode;
  nameHead: string;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const cursor = useRef<string | null>(null);

  // One stop in the tab order: wherever you last were, or the first row.
  useLayoutEffect(() => {
    const all = [...(body.current?.querySelectorAll<HTMLElement>("[data-gc]") ?? [])];
    all.forEach((el) => { el.tabIndex = -1; });
    const here = all.find((el) => cellKey(el) === cursor.current) ?? all[0];
    if (here) here.tabIndex = 0;
  });

  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    const el = e.target as HTMLElement;
    if (!el.dataset.gc) return;
    const tr = el.closest<HTMLElement>("tr[data-gr]");
    if (!tr) return;
    const inRow = [...tr.querySelectorAll<HTMLElement>("[data-gc]")];
    let next: HTMLElement | undefined;
    if (e.key === "ArrowRight") next = inRow[inRow.indexOf(el) + 1];
    else if (e.key === "ArrowLeft") next = inRow[inRow.indexOf(el) - 1];
    else if (e.key === "Home") next = inRow[0];
    else if (e.key === "End") next = inRow[inRow.length - 1];
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const rowsHere = [...(body.current?.querySelectorAll<HTMLElement>("tr[data-gr]") ?? [])];
      const to = rowsHere[rowsHere.indexOf(tr) + (e.key === "ArrowUp" ? -1 : 1)];
      const col = el.dataset.gc.replace(/-reset$/, "");
      next = to?.querySelector<HTMLElement>(`[data-gc="${col}"]`) ?? undefined;
    } else return;
    e.preventDefault();
    next?.focus();
  };
  const [, bump] = useState(0);
  const onFocus = (e: { target: EventTarget }) => {
    const el = e.target as HTMLElement;
    if (!el.dataset?.gc) return;
    cursor.current = cellKey(el);
    bump((n) => n + 1);
  };

  return (
    <div className="at-scroll">
      <table className="at-tbl" style={{ minWidth: 200 + agents.length * 104 }}>
        <colgroup>
          <col className="at-col-name" />
          {agents.map((a) => <col key={a.id} className="at-col-agent" />)}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="at-th-name">{nameHead}</th>
            {agents.map((a) => <th key={a.id} scope="col" title={a.label}>{a.label}</th>)}
          </tr>
        </thead>
        <tbody ref={body} onKeyDown={onKey} onFocus={onFocus}>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr data-gr={r.id} data-open={open === r.id || undefined}>
                <th scope="row" className="at-name">
                  <button type="button" data-gc="name" aria-expanded={open === r.id} title={r.hint ?? r.title}
                    onClick={() => onOpen(open === r.id ? null : r.id)}>
                    <ChevronRight size={11} aria-hidden className="at-chev" />
                    <span className="at-nm"><b>{r.title}</b>{r.sub && <small>{r.sub}</small>}</span>
                  </button>
                </th>
                {agents.map((a) => {
                  const c = r.cells[a.id] ?? { state: "cant", why: `${a.label} isn't in this list.` } as Cell;
                  return (
                    <GridCell key={a.id} section={section} row={r} agent={a} cell={c} level={level}
                      busy={busy.has(`${r.id}|${a.id}`)} heldHere={held?.(r, c) ?? false}
                      onClick={() => { if (gridClick(c) === "open" || held?.(r, c)) onOpen(r.id); else onCell(r, a, c); }}
                      onReset={() => onReset(r, a)} />
                  );
                })}
              </tr>
              {open === r.id && (
                <tr className="at-dtr">
                  <td colSpan={agents.length + 1}><div className="at-detail">{detail(r)}</div></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cellKey = (el: HTMLElement) => `${el.closest<HTMLElement>("tr[data-gr]")?.dataset.gr ?? ""}|${el.dataset.gc}`;

function GridCell({ section, row, agent, cell, level, busy, heldHere, onClick, onReset }: {
  section: Section; row: GridRow; agent: AgentRef; cell: Cell; level: Level; busy: boolean; heldHere: boolean;
  onClick: () => void; onReset: () => void;
}) {
  const click = heldHere ? "open" : gridClick(cell);
  const why = heldHere ? `Off in this chat's ⚒ Tools. Change it there.` : cellWhy(section, cell, agent.label);
  const reset = !heldHere && canReset(section, cell, level);
  const act = click === "toggle" ? ` Click to turn ${cell.state === "off" ? "on" : "off"}.` : click === "login" ? " Click to log in." : "";
  const tag = heldHere ? "⚒ CHAT" : levelTag(cell);
  const toggle = click === "toggle";
  return (
    <td className="at-td" data-state={cell.state}>
      <span className="at-cellwrap">
        <button type="button" className="at-cell" data-gc={agent.id} data-state={cell.state} data-busy={busy || undefined}
          title={`${why}${act}`} disabled={busy}
          role={toggle ? "switch" : undefined} aria-checked={toggle ? cell.state !== "off" : undefined}
          aria-label={`${row.title}, ${agent.label}: ${STATE_WORD[cell.state]}${tag ? `, set by ${tag.toLowerCase()}` : ""}. ${why}${act}`}
          onClick={onClick}>
          <span className="at-st"><i aria-hidden />{STATE_WORD[cell.state]}</span>
          <span className="at-lv">{tag}</span>
        </button>
        {reset
          ? (
            <button type="button" className="at-reset" data-gc={`${agent.id}-reset`} disabled={busy} onClick={onReset}
              title={`Reset: ${level} stops saying anything, and the next level decides`}
              aria-label={`Reset ${row.title} for ${agent.label} at ${level} level`}>
              <RotateCcw size={10} aria-hidden />
            </button>
          )
          : <span className="at-reset-gap" aria-hidden />}
      </span>
    </td>
  );
}

/** Rows while the first answer's on its way: the grid's own shape, so nothing jumps. */
export function GridLoading({ agents = 2 }: { agents?: number }) {
  return (
    <div className="at-scroll" aria-busy role="status" aria-label="Reading what's available">
      <div className="at-skel">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="at-skelrow">
            <span style={{ width: `${30 + ((i * 17) % 40)}%` }} />
            {Array.from({ length: agents }, (_, j) => <em key={j} />)}
          </div>
        ))}
      </div>
    </div>
  );
}
