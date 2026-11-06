import type { ReactNode } from "react";
import { Play, SquarePen } from "lucide-react";
import type { RivendellTask } from "../../api";
import { splitTitle } from "../../lib/rivendelltasks";

// A task's edge: Rivendell's priority, in theme tokens only.
const EDGE: Record<string, string> = { high: "var(--err)", medium: "var(--acc)" };

/* The Rivendell tab's deck: the next task as one card on two offset cards, so
   the list reads as "this one first". Implement / Work on it / Skip are the
   tab's own handlers; `children` is IMPLEMENT's confirm (and its error), which
   opens in the card. The spec excerpt arrives late and never holds the card. */
export function TaskDeck({ task, n, text, go, frozen, onGo, onWork, onSkip, onLink, children }: {
  task: RivendellTask; n: number; text: string;
  /** the primary button's label, or null when this task cannot start (queued, running) */
  go: string | null; frozen: boolean;
  onGo: () => void; onWork: () => void; onSkip: () => void; onLink: (() => void) | null;
  children?: ReactNode;
}) {
  const { title } = splitTitle(task.name);
  const who = task.assignees.length ? task.assignees.map((a) => a.name).join(", ") : "nobody on it";
  const meta = [task.key, task.priority, who].filter(Boolean).join(" · ");
  return (
    <div className="dk">
      <span className="dk-bk dk-b2" aria-hidden /><span className="dk-bk" aria-hidden />
      <div className="dk-card" style={{ ["--dk-edge" as string]: EDGE[task.priority ?? ""] ?? "var(--txl)" }}>
        <div className="dk-k"><Play size={9} strokeWidth={2.6} aria-hidden />NEXT UP<span>1 of {n}</span></div>
        <div className="dk-tt" title={task.name}>{title}</div>
        <div className="dk-key"><span title={meta}>{meta}</span>
          {onLink && <button type="button" className="dk-ln" title="Open the task" aria-label="Open the task" onClick={onLink}>↗</button>}
        </div>
        {text && <div className="dk-ex">{text}</div>}
        <div className="dk-a">
          {go && !frozen && <button type="button" className="dk-btn dk-pri" onClick={onGo}><Play size={10} strokeWidth={2.4} aria-hidden />{go}</button>}
          <button type="button" className="dk-btn" onClick={onWork} title="A new session here, with this task in its composer">
            <SquarePen size={10} strokeWidth={2.2} aria-hidden />Work on it
          </button>
          {n > 1 && <button type="button" className="dk-skip" onClick={onSkip} title="Next task; this one comes back after a day">Skip ›</button>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A running task under the deck: its title, step pips, one live line, and Open ›. */
export function RunMini({ title, pips, live, foot, onOpen }: {
  title: string; pips: { done: number; total: number } | null; live: string | null; foot: string; onOpen: (() => void) | null;
}) {
  return (
    <div className="dk-mini">
      <div className="dk-mt" title={title}>{title}</div>
      {pips && (
        <div className="dk-pips" aria-hidden>
          {Array.from({ length: Math.min(pips.total, 12) }, (_, i) => <b key={i} className={i < pips.done ? "on" : ""} />)}
        </div>
      )}
      {live && <div className="dk-live" title={live}>› {live}</div>}
      <div className="dk-mf"><span>{foot}</span>{onOpen && <button type="button" onClick={onOpen}>Open ›</button>}</div>
    </div>
  );
}
