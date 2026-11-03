import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Goal } from "../api";
import type { Turn } from "../chat";
import { barTime, goalPhase, goalTurns, spanTime, type GoalPhase } from "../lib/goal";
import { popPlace } from "../lib/prchip";
import { hhmm, useClock12 } from "../lib/surfaces";
import { askPrompt } from "./ui/Ask";
import { notify } from "./hud/Notifications";

/** The session's goal in the composer's pill strip: what it is, how far the
 *  loop has run and how it ended. A click opens its sheet — the brief or the
 *  model's note, a bar per turn sized by its minutes, and the buttons for that
 *  state (.mystical/design-drafts/goals, A · SHEET). The loop is the bridge's
 *  (bridge/goals.py); these only steer it. Set one with `/goal <objective>`, or
 *  the model does with CreateGoal. */

const INK: Record<GoalPhase, string> = { working: "var(--acc)", stalled: "var(--warn)", blocked: "var(--warn)", met: "var(--ok)" };
const SAY: Record<GoalPhase, string> = { working: "Working", stalled: "Stalled", blocked: "Needs you", met: "Met" };
const BARS = 11;   // slots in the sheet's track: the turn that set it + MAX_ITER

export function GoalPill({ goal, maxIter = 10, turns, running, held, onAct, onClear }: {
  goal?: Goal | null;
  maxIter?: number;
  /** The open session's turns: the sheet's bars and the stalled check read them. */
  turns: Turn[];
  running: boolean;
  /** Something else will start the next turn: a queued prompt, PAUSE, a wait. */
  held: boolean;
  onAct: (action: "done" | "keep" | "edit", objective?: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const h12 = useClock12();

  // Closes on a click outside or on Esc, as PrChip's popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!chipRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!goal) return null;
  const now = Date.now() / 1000;
  const mine = goalTurns(goal, turns, now);
  const last = turns.reduce((m, t) => Math.max(m, (t.started ?? 0) + (t.elapsed ?? 0)), goal.since ?? 0);
  const phase = goalPhase(goal, running || held, now - last, maxIter);
  if (!phase) return null;
  const ink = INK[phase];
  const title = goal.title || goal.objective;
  const act = (a: "done" | "keep" | "edit", objective?: string) => { setOpen(false); onAct(a, objective); };
  const edit = async () => {
    const v = await askPrompt("What must be true for this goal to be done?", goal.objective, "Save");
    if (v?.trim()) act("edit", v.trim());
  };
  const copy = () => void navigator.clipboard.writeText(goal.note || title)
    .then(() => notify("info", "Result copied."), () => notify("error", "Couldn't copy."));

  const bars = (mine ?? []).slice(-BARS);
  const longest = Math.max(1, ...bars.map((b) => b.secs));
  const spent = bars.reduce((n, b) => n + b.secs, 0);
  const empty = Math.max(0, Math.min(maxIter - goal.iter, BARS - bars.length));
  const rect = chipRef.current?.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect?.left ?? 0, window.innerWidth - 464));

  return (
    <>
      <button
        ref={chipRef}
        className="goal-pill"
        data-phase={phase}
        data-open={open || undefined}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={goal.note ? `${goal.objective}\n\n${goal.note}` : goal.objective}
        style={{ ["--gc" as string]: ink }}
      >
        {phase === "met" ? <span aria-hidden>✓</span> : <span className="goal-dot" aria-hidden />}
        <span style={{ flex: "0 0 auto" }}>
          {phase === "working" ? `Goal · ${goal.iter}/${maxIter}`
            : phase === "met" ? "Goal met" : phase === "blocked" ? "Needs you" : "Goal stalled"}
        </span>
        {phase === "working" && (
          <span className="goal-pips" aria-hidden>
            {Array.from({ length: maxIter }, (_, i) => (
              <i key={i} data-on={i < goal.iter || undefined} data-live={(running && i === goal.iter - 1) || undefined} />
            ))}
          </span>
        )}
        {/* pill-desc: the busy composer hides this and keeps the words in the title. */}
        <span className="pill-desc">{title}</span>
      </button>
      {open && createPortal(
        <div ref={popRef} className="goal-sheet" data-phase={phase}
          style={{ ["--gc" as string]: ink, ...popPlace(rect ?? { top: 0, bottom: 0 }, window.innerHeight), left }}>
          <div className="gs-h">
            <span className="gs-g" aria-hidden>◎</span>
            <span className="gs-lbl">Goal</span>
            <span className="gs-st">
              {phase === "met" ? "✓ " : <i aria-hidden />}{SAY[phase]}
              <span className="gs-m">
                {" · "}{phase === "working" ? `auto-turn ${goal.iter} of ${maxIter}`
                  : phase === "stalled" ? (goal.iter >= maxIter ? `used all ${maxIter} turns` : "nothing is queued")
                  : goal.at ? hhmm(goal.at, h12) : ""}
              </span>
            </span>
          </div>
          <div className="gs-t">{title}</div>
          {(phase === "working" || phase === "stalled") && (
            <button className="gs-b" data-open={more || undefined} onClick={() => setMore((m) => !m)}
              title={more ? "show less" : "show the whole brief"}>{goal.objective}</button>
          )}
          {phase === "blocked" && <div className="gs-note">{goal.note || "Claude stopped here and needs you to go on."}</div>}
          {phase === "met" && <div className="gs-note"><span className="gs-lbl">Result</span>{goal.note || "Done."}</div>}
          {bars.length > 0 && (
            <div className="gs-track">
              <div className="gs-sum">
                <span className="gs-lbl">Turns</span>
                <b>{spanTime(spent)}<span>{phase === "working" ? "so far" : `${bars.length} turn${bars.length === 1 ? "" : "s"}`}</span></b>
              </div>
              <div className="gs-bars">
                {bars.map((b, i) => (
                  <div key={b.id} className="gs-bar" data-first={b.first || undefined} data-live={b.live || undefined}
                    data-last={(phase === "blocked" && i === bars.length - 1) || undefined}
                    title={`${b.first ? "the turn that set it" : "auto-turn"} · ${spanTime(b.secs)}`}>
                    <i style={{ height: Math.max(3, Math.round((24 * b.secs) / longest)) }} />
                    <em>{b.live ? "now" : barTime(b.secs)}</em>
                  </div>
                ))}
                {Array.from({ length: empty }, (_, k) => (
                  <div key={`e${k}`} className="gs-bar" data-empty><i /><em>{goal.iter + k + 1}</em></div>
                ))}
              </div>
            </div>
          )}
          <div className="gs-a">
            {phase === "blocked" && (
              <button className="gs-btn pri" onClick={() => { setOpen(false); window.dispatchEvent(new Event("ask:focus")); }}>↵ Answer</button>
            )}
            {phase === "met" && <button className="gs-btn" onClick={copy}>⧉ Copy result</button>}
            {(phase === "met" || phase === "stalled") && <button className="gs-btn" onClick={() => act("keep")}>↻ Keep going</button>}
            {phase !== "met" && <button className="gs-btn" onClick={() => act("done")}>✓ Mark done</button>}
            {phase === "working" && <button className="gs-btn" onClick={() => void edit()}>✎ Edit</button>}
            <button className="gs-btn quiet" onClick={() => { setOpen(false); onClear(); }}>
              ✕ {phase === "met" ? "Clear" : "Stop goal"}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
