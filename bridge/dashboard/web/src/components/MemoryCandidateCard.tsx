import { useState } from "react";
import { Brain, Check, X } from "lucide-react";
import { Button, Card } from "./ui";
import { api } from "../api";

// Mirrors bridge/miniapp/web/src/components/MemoryCandidateCard.tsx (shared design).
// Rendered from a `memory_candidate` transcript event: a proposed durable fact with
// a Keep/Skip gate. Self-contained — owns its API call + optimistic state.
export function MemoryCandidateCard({
  itemId,
  memType,
  scope,
  title,
  body,
}: {
  itemId: string;
  memType: string;
  scope: string;
  title: string;
  body: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "kept" | "skipped">("idle");

  async function act(action: "keep" | "skip") {
    setState("busy");
    try {
      await api.memoryCandidate(itemId, action);
      setState(action === "keep" ? "kept" : "skipped");
    } catch {
      setState("idle");
    }
  }

  return (
    <Card className="space-y-2 border border-[var(--brand-soft)]/30">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Brain size={15} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
        <span>Remember this?</span>
        <span className="ml-auto rounded bg-[var(--tg-secondary-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--tg-hint)]">
          {scope === "user" ? "you" : memType}
        </span>
      </div>
      <div className="text-sm font-semibold">{title}</div>
      {body && <div className="text-xs text-[var(--tg-hint)]">{body}</div>}
      {state === "kept" ? (
        <div className="flex items-center gap-1 text-xs text-[var(--tg-hint)]">
          <Check size={13} className="text-green-400" aria-hidden /> Kept
        </div>
      ) : state === "skipped" ? (
        <div className="flex items-center gap-1 text-xs text-[var(--tg-hint)]">
          <X size={13} className="text-red-400" aria-hidden /> Skipped
        </div>
      ) : (
        <div className="flex gap-2">
          <Button className="flex-1" disabled={state === "busy"} onClick={() => void act("keep")}>
            Keep
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={state === "busy"}
            onClick={() => void act("skip")}
          >
            Skip
          </Button>
        </div>
      )}
    </Card>
  );
}
