import { TriangleAlert, CircleStop } from "lucide-react";
import type { AnswerSelection, RunEvent } from "../api";
import type { PendingRequest } from "../chat";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";

// Tool-tag colors (HUD terminal). Mirrors the design's BASH/READ/WRITE accents.
function toolTag(name: string): { color: string; border: string } {
  if (name === "Bash") return { color: "var(--primary)", border: "var(--border-bright)" };
  if (name === "Read") return { color: "#b9a6ff", border: "rgba(185,166,255,.35)" };
  if (name === "Edit" || name === "Write" || name === "MultiEdit")
    return { color: "#8fd9a8", border: "rgba(143,217,168,.35)" };
  return { color: "var(--primary)", border: "var(--border-bright)" };
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
    <div className="my-2 ml-[18px] border border-[rgba(143,217,168,.28)] bg-[rgba(143,217,168,.04)]">
      <div className="border-b border-[rgba(143,217,168,.18)] px-3 py-1.5 text-[9.5px] tracking-[2px] text-success">
        RESULT // OK
      </div>
      <div className="px-3 py-2.5">
        <Markdown className="leading-relaxed text-[#c4e8df]">{result}</Markdown>
        {(typeof elapsed === "number" || typeof cost === "number") && (
          <div className="mt-1.5 text-[10px] tracking-[1px] text-muted-2">
            {typeof elapsed === "number" ? `${elapsed.toFixed(1)}s` : ""}
            {typeof elapsed === "number" && typeof cost === "number" ? " · " : ""}
            {typeof cost === "number" ? `$${cost.toFixed(4)}` : ""}
          </div>
        )}
      </div>
    </div>
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
              <Markdown key={i} className="pl-[18px] leading-relaxed text-[#9fc7c0]">
                {event.text}
              </Markdown>
            );
          case "tool": {
            const tt = toolTag(event.name);
            return (
              <div
                key={i}
                className="my-1.5 ml-[18px] flex items-center gap-2.5 border border-border bg-[var(--ac-03)] px-2.5 py-1.5"
              >
                <span
                  className="flex-none border px-1.5 py-px text-[10px] tracking-[1px]"
                  style={{ color: tt.color, borderColor: tt.border }}
                >
                  {event.name.toUpperCase()}
                </span>
                {event.summary && (
                  <span className="min-w-0 truncate text-[12px] text-muted-foreground">{event.summary}</span>
                )}
              </div>
            );
          }
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
                className="flex items-start gap-1.5 rounded-lg bg-red-500/15 px-2 py-1 text-sm text-red-300"
              >
                <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>{event.message}</span>
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
          case "stopped":
            return (
              <div
                key={i}
                className="flex items-center gap-1.5 text-xs text-[var(--tg-hint)]"
              >
                <CircleStop
                  size={14}
                  className="shrink-0 text-[var(--brand-soft)]"
                  aria-hidden
                />
                <span>Stopped — send a message to continue.</span>
              </div>
            );
          case "permission_resolved":
          case "question_answered":
            return null; // shown inside the relevant card
        }
      })}
    </div>
  );
}
