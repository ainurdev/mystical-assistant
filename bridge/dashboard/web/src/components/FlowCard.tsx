import { Fragment, useEffect, useRef, useState } from "react";
import type { HudCard } from "../api";
import { useFlows } from "../lib/flows";
import { CardField } from "./FlowFields";
import { handoffPrompt } from "../lib/cardfields";

// Mirrors bridge/miniapp/web/src/components/FlowCard.tsx (shared design), the
// way QuestionCard already does. A typed turn's settled result: what it did,
// the fields its stage owes, and the moves you can take from here — so the
// answer is a thing you act on rather than a wall to read.
//
// It wears the same frame as the agent block (.agb): a hue rail, a tracked
// header, brackets from .panel. That is deliberate — both are a turn's own
// structure surfacing in the stream, and the stream has exactly one idiom for
// that. The hue says who is waiting: accent while the flow is running itself,
// amber when the card is asking you to approve something.
//
// How each field draws is the flow's declaration, not this component's: the
// stage names a type, flow.catalog() ships it, FlowFields draws it. That is
// what keeps a custom flow's cards as rich as a built-in's.
export function FlowCard({
  card,
  stype,
  gated,
  isCurrent,
  onAction,
  onApprove,
  onOpenFile,
  onHandoff,
}: {
  card: HudCard;
  /** The flow this card belongs to, which is what names its fields' types. */
  stype?: string | null;
  /** The stage this card belongs to holds a gate. */
  gated: boolean;
  /** The session is still standing on that stage (an older card is history). */
  isCurrent: boolean;
  onAction: (send: string) => void;
  onApprove: () => void;
  onOpenFile?: (path: string, line?: number) => void;
  /** Open a fresh typed session from this card — a report becoming the work. */
  onHandoff?: (stype: string, prompt: string) => void;
}) {
  // The prompt only comes back on the next poll, so an untouched-looking button
  // reads as dropped and gets pressed twice (same reason QuestionCard tracks it).
  const [sent, setSent] = useState<string | null>(null);
  const flows = useFlows();
  const flow = flows.find((f) => f.stype === stype) ?? null;
  const shape = flow?.stages.find((s) => s.id === card.stage) ?? null;
  const fields = Object.entries(card.fields ?? {});
  const awaitingApproval = gated && card.advance === true && isCurrent;
  // Only the live card acts: triaging a finding on a stage you already left, or
  // re-sending last week's commit message, is never what you meant.
  const send = isCurrent ? onAction : undefined;
  // A target whose flow is gone or switched off simply has no button.
  const handoffs = isCurrent && onHandoff
    ? (shape?.handoff ?? []).filter((t) => flows.some((f) => f.stype === t))
    : [];
  const acts = (card.actions ?? []).slice(0, 3);
  // Exactly one filled control per card — the move it is asking for. The gate
  // owns it while the card waits to be let through; otherwise it is the first
  // action, because the model writes them in the order it would take them.
  // A departure gives up its box from here on: it opens a new session rather
  // than answering this one. Index 1 when there is nothing else on the row —
  // a lone ghost control is one nobody finds.
  const awayFrom = awaitingApproval || acts.length > 0 ? 0 : 1;

  return (
    <div
      className="flc panel"
      data-await={awaitingApproval ? "" : undefined}
      style={{ "--h": awaitingApproval ? "var(--warn)" : "var(--acc)" } as React.CSSProperties}
    >
      <i className="flc-rail" aria-hidden />
      <div className="flc-head">
        <i className="flc-mark" aria-hidden>{gated ? "◈" : "◇"}</i>
        <span className="flc-stage">{card.stage.toUpperCase()}</span>
        {gated && <span className="flc-gate" title="this stage waits for you">GATE</span>}
        <i className="flc-rule" aria-hidden />
        {awaitingApproval && <span className="flc-wait">AWAITING YOU</span>}
      </div>

      {/* The summary is the model speaking about the turn it just finished —
          the oracle register the agent block's brief already wears. */}
      <div className="flc-sum">{card.summary}</div>

      {fields.length > 0 && (
        <dl className="flc-fields">
          {fields.map(([name, value]) => (
            <CardField
              key={name}
              name={name}
              type={shape?.fields.find((f) => f.name === name)?.type ?? "text"}
              value={value}
              send={send}
              onOpenFile={onOpenFile}
            />
          ))}
        </dl>
      )}

      {(awaitingApproval || handoffs.length > 0 || acts.length > 0) && (
        <div className="flc-acts">
          {awaitingApproval && (
            shape?.input === "arm"
              ? <HoldToApprove onApprove={onApprove} />
              : <button type="button" className="flc-btn" data-go="" onClick={onApprove}>APPROVE ▸</button>
          )}
          {acts.map((a, i) => (
            <button
              key={a.label}
              type="button"
              className="flc-btn"
              data-go={!awaitingApproval && i === 0 ? "" : undefined}
              disabled={sent === a.label}
              onClick={() => { setSent(a.label); onAction(a.send); }}
            >
              {a.label}
            </button>
          ))}
          {handoffs.map((t, i) => (
            <Fragment key={t}>
              {i === awayFrom && <i className="flc-fence" aria-hidden />}
              <button
                type="button"
                className="flc-btn"
                data-away={i >= awayFrom ? "" : undefined}
                disabled={sent === t}
                onClick={() => {
                  setSent(t);
                  onHandoff?.(t, handoffPrompt(card, flow?.label ?? (stype ?? "").toUpperCase()));
                }}
              >
                ↗ OPEN AS {(flows.find((f) => f.stype === t)?.label ?? t).toUpperCase()}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

const HOLD_MS = 1000;

/** Approval for a stage that will do something to the machine. A tap is one
 *  finger's width from a scroll on a phone; a held second is not. The fill
 *  crossing the button is the only progress bar in the system, and it is the
 *  one place a bar means what it says: this is how much longer you hold.
 *  Keyboard gets a confirm — holding a key is not a thing anyone should do. */
function HoldToApprove({ onApprove }: { onApprove: () => void }) {
  const [held, setHeld] = useState(false);
  const timer = useRef<number | null>(null);
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setHeld(false);
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      className="flc-btn flc-hold"
      data-go=""
      data-held={held ? "" : undefined}
      title="hold to run"
      style={{ "--hold": `${HOLD_MS}ms` } as React.CSSProperties}
      onPointerDown={() => {
        setHeld(true);
        timer.current = window.setTimeout(() => { stop(); onApprove(); }, HOLD_MS);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (window.confirm("Run this stage's commands?")) onApprove();
      }}
    >
      <i className="flc-fill" aria-hidden />
      <span>{held ? "HOLD…" : "HOLD TO RUN ◆"}</span>
    </button>
  );
}
