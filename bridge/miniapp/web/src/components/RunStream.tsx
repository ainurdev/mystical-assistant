import type { AnswerSelection, PendingRequest, RunEvent } from "../lib/api";
import { Card } from "./ui";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";

// Map a few common tool names to icons; default to a wrench.
function toolIcon(name: string): string {
  switch (name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
      return "✏️";
    case "Read":
      return "📖";
    case "Bash":
      return "🔧";
    case "Grep":
    case "Glob":
      return "🔎";
    default:
      return "🔧";
  }
}

function FinalResult({
  result,
  elapsed,
  cost,
}: {
  result: string;
  elapsed?: number;
  cost?: number;
}) {
  return (
    <Card className="space-y-2 border border-[var(--tg-button)]/30">
      <div className="whitespace-pre-wrap text-sm leading-relaxed">{result}</div>
      {(typeof elapsed === "number" || typeof cost === "number") && (
        <div className="text-xs text-[var(--tg-hint)]">
          {typeof elapsed === "number" ? `${elapsed.toFixed(1)}s` : ""}
          {typeof elapsed === "number" && typeof cost === "number" ? " · " : ""}
          {typeof cost === "number" ? `$${cost.toFixed(4)}` : ""}
        </div>
      )}
    </Card>
  );
}

type RespondFn = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void;

export function RunStream({
  events,
  pending = [],
  onRespond,
}: {
  events: RunEvent[];
  pending?: PendingRequest[];
  onRespond?: RespondFn;
}) {
  const pendingIds = new Set(pending.map((p) => p.request_id));
  const permResolved = new Map<string, "allow" | "deny">();
  const qAnswered = new Map<string, AnswerSelection[]>();
  for (const e of events) {
    if (e.type === "permission_resolved") permResolved.set(e.request_id, e.behavior);
    if (e.type === "question_answered") qAnswered.set(e.request_id, e.answers);
  }

  return (
    <div className="space-y-2">
      {events.map((event, i) => {
        switch (event.type) {
          case "text":
            return (
              <div key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
                {event.text}
              </div>
            );
          case "tool":
            return (
              <div key={i} className="font-mono text-xs text-[var(--tg-hint)]">
                {toolIcon(event.name)} {event.name}
                {event.summary ? `: ${event.summary}` : ""}
              </div>
            );
          case "tool_done":
            return null;
          case "result":
            return (
              <FinalResult
                key={i}
                result={event.result}
                elapsed={event.elapsed}
                cost={event.cost}
              />
            );
          case "error":
            return (
              <div
                key={i}
                className="rounded-lg bg-red-500/15 px-2 py-1 text-sm text-red-300"
              >
                ⚠️ {event.message}
              </div>
            );
          case "permission":
            return (
              <PermissionCard
                key={i}
                toolName={event.tool_name}
                summary={event.summary}
                active={!!onRespond && pendingIds.has(event.request_id)}
                resolved={permResolved.get(event.request_id)}
                onAllow={() => onRespond?.(event.request_id, { behavior: "allow" })}
                onDeny={() => onRespond?.(event.request_id, { behavior: "deny" })}
              />
            );
          case "question":
            return (
              <QuestionCard
                key={i}
                questions={event.questions}
                active={!!onRespond && pendingIds.has(event.request_id)}
                answered={qAnswered.get(event.request_id)}
                onSubmit={(answers) => onRespond?.(event.request_id, { answers })}
              />
            );
          case "permission_resolved":
          case "question_answered":
            return null; // shown inside the relevant card
        }
      })}
    </div>
  );
}
