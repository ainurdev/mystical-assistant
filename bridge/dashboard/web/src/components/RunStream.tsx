import { useEffect, useState } from "react";
import { TriangleAlert, CircleStop } from "lucide-react";
import type { AnswerSelection, RunEvent } from "../api";
import type { PendingRequest } from "../chat";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { MemoryCandidateCard } from "./MemoryCandidateCard";
import { ReviewCandidateCard } from "./ReviewCandidateCard";

// Result blocks already "printed" this session — guards against re-typing when a
// session is reopened or the transcript re-renders.
const typedResults = new Set<string>();

/** Types `text` out left-to-right (plain) the first time a live result lands,
 *  then swaps to formatted Markdown. Non-live results render instantly. */
function Typewriter({
  text,
  animate,
  idKey,
  className,
}: {
  text: string;
  animate: boolean;
  idKey: string;
  className?: string;
}) {
  const [n, setN] = useState(() => (animate && !typedResults.has(idKey) ? 0 : text.length));

  useEffect(() => {
    if (n >= text.length) return;
    typedResults.add(idKey);
    const step = Math.max(1, Math.ceil(text.length / 60)); // ~60 frames ≈ 2.1s, capped
    const id = setInterval(() => {
      setN((p) => {
        const next = p + step;
        if (next >= text.length) {
          clearInterval(id);
          return text.length;
        }
        return next;
      });
    }, 35);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (n >= text.length) return <Markdown className={className}>{text}</Markdown>;
  return (
    <div className={`${className ?? ""} whitespace-pre-wrap break-words`}>
      {text.slice(0, n)}
      <span
        className="ml-px inline-block h-[1em] w-[7px] translate-y-[2px] bg-primary align-middle"
        style={{ animation: "caret 1s steps(1) infinite" }}
      />
    </div>
  );
}

// Tool-tag colors (HUD terminal). Mirrors the design's BASH/READ/WRITE accents.
function toolTag(name: string): { color: string; border: string } {
  if (name === "Bash") return { color: "var(--primary)", border: "var(--border-bright)" };
  if (name === "Read") return { color: "var(--purple)", border: "color-mix(in srgb, var(--purple) 35%, transparent)" };
  if (name === "Edit" || name === "Write" || name === "MultiEdit")
    return { color: "var(--ok)", border: "color-mix(in srgb, var(--ok) 35%, transparent)" };
  return { color: "var(--primary)", border: "var(--border-bright)" };
}

function FinalResult({
  result,
  elapsed,
  cost,
  animate,
  idKey,
}: {
  result: string;
  elapsed?: number;
  cost?: number;
  animate: boolean;
  idKey: string;
}) {
  const flash = animate && !typedResults.has(idKey);
  return (
    <div
      className="my-2 ml-[18px] border border-[color-mix(in srgb, var(--ok) 28%, transparent)] bg-[color-mix(in srgb, var(--ok) 4%, transparent)]"
      style={flash ? { animation: "resultflash 1.2s ease both" } : undefined}
    >
      <div className="border-b border-[color-mix(in srgb, var(--ok) 18%, transparent)] px-3 py-1.5 text-[9.5px] tracking-[2px] text-success">
        RESULT // OK
      </div>
      <div className="px-3 py-2.5">
        <Typewriter text={result} animate={animate} idKey={idKey} className="leading-relaxed text-[#c4e8df]" />
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
  onReviewResolve,
  animate = false,
  turnId = "",
}: {
  events: RunEvent[];
  pending?: PendingRequest[];
  onRespond?: RespondFn;
  onReviewResolve?: (itemId: string, action: "keep" | "skip") => void;
  animate?: boolean;
  turnId?: string;
}) {
  const pendingIds = new Set(pending.map((p) => p.request_id));
  const permResolved = new Map<string, "allow" | "deny">();
  const qAnswered = new Map<string, AnswerSelection[]>();
  for (const e of events) {
    if (e.type === "permission_resolved") permResolved.set(e.request_id, e.behavior);
    if (e.type === "question_answered") qAnswered.set(e.request_id, e.answers);
  }
  const reviewResolved = new Map<string, "kept" | "skipped">();
  for (const e of events) {
    if (e.type === "review_resolved") reviewResolved.set(e.item_id, e.action);
  }

  return (
    <div className="space-y-2">
      {events.map((event, i) => {
        switch (event.type) {
          case "text":
            return (
              <div key={i} style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}>
                <Markdown className="pl-[18px] leading-relaxed text-[var(--txm)]">{event.text}</Markdown>
              </div>
            );
          case "tool": {
            const tt = toolTag(event.name);
            return (
              <div
                key={i}
                className="my-1.5 ml-[18px] flex items-center gap-2.5 border border-border bg-[var(--ac-03)] px-2.5 py-1.5"
                style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
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
                animate={animate}
                idKey={`${turnId}:${i}`}
              />
            );
          case "error":
            return (
              <div
                key={i}
                className="flex items-start gap-1.5 rounded-lg bg-red-500/15 px-2 py-1 text-sm text-red-300"
                style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
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
          case "review_candidate":
            return (
              <ReviewCandidateCard
                key={i}
                title={event.title}
                whyItMatters={event.why_it_matters}
                snippet={event.snippet}
                active={!!onReviewResolve && !reviewResolved.has(event.item_id)}
                resolved={reviewResolved.get(event.item_id)}
                onKeep={() => onReviewResolve?.(event.item_id, "keep")}
                onSkip={() => onReviewResolve?.(event.item_id, "skip")}
              />
            );
          case "review_resolved":
            return null;
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
          case "memory_candidate":
            return (
              <MemoryCandidateCard
                key={i}
                itemId={event.item_id}
                memType={event.mem_type}
                scope={event.scope}
                title={event.title}
                body={event.body}
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
