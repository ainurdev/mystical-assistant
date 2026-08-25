import { useEffect, useRef, useState } from "react";
import { Button, Card } from "./ui";
import type { HudCard } from "../lib/api";
import { useFlows } from "../lib/flows";
import { CardField } from "./FlowFields";
import { handoffPrompt } from "../lib/cardfields";

// Mirrors bridge/dashboard/web/src/components/FlowCard.tsx (shared design), the
// way QuestionCard already does. A typed turn's settled result: what it did,
// the fields its stage owes, and the moves you can take from here — so the
// answer is a thing you act on rather than a wall to read.
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

  return (
    <Card className="space-y-2 border border-[var(--tg-button)]/30">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] tracking-[0.15em] text-muted-foreground">
          {card.stage.toUpperCase()}
        </span>
        <span className="text-sm">{card.summary}</span>
      </div>

      {fields.length > 0 && (
        <dl className="space-y-1.5">
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

      {(awaitingApproval || handoffs.length > 0 || (card.actions?.length ?? 0) > 0) && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {awaitingApproval && (
            shape?.input === "arm"
              ? <HoldToApprove onApprove={onApprove} />
              : <Button size="sm" onClick={onApprove}>APPROVE ▸</Button>
          )}
          {handoffs.map((t) => (
            <Button
              key={t}
              size="sm"
              variant="outline"
              disabled={sent === t}
              onClick={() => {
                setSent(t);
                onHandoff?.(t, handoffPrompt(card, flow?.label ?? (stype ?? "").toUpperCase()));
              }}
            >
              OPEN AS {(flows.find((f) => f.stype === t)?.label ?? t).toUpperCase()} ▸
            </Button>
          ))}
          {(card.actions ?? []).slice(0, 3).map((a) => (
            <Button
              key={a.label}
              size="sm"
              variant="outline"
              disabled={sent === a.label}
              onClick={() => {
                setSent(a.label);
                onAction(a.send);
              }}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

const HOLD_MS = 1000;

/** Approval for a stage that will do something to the machine. A tap is one
 *  finger's width from a scroll on a phone; a held second is not. Keyboard gets
 *  a confirm instead — holding a key is not a thing anyone should have to do. */
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
    <Button
      size="sm"
      title="hold to run"
      className={held ? "opacity-70" : ""}
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
      {held ? "HOLD…" : "HOLD TO RUN ◆"}
    </Button>
  );
}
