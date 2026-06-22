import { useState } from "react";
import type { AnswerSelection, Question, RunEvent } from "../api";
import type { PendingRequest, Turn } from "../chat";

type Respond = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void;

function toolIcon(name: string): string {
  if (name === "Edit" || name === "Write" || name === "MultiEdit") return "✏️";
  if (name === "Read") return "📖";
  if (name === "Bash") return "🔧";
  if (name === "Grep" || name === "Glob") return "🔎";
  return "🔧";
}

function PermissionCard({
  ev,
  active,
  resolved,
  onRespond,
}: {
  ev: Extract<RunEvent, { type: "permission" }>;
  active: boolean;
  resolved?: "allow" | "deny";
  onRespond?: Respond;
}) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
      <div className="mb-2">
        <span className="font-medium">{ev.tool_name}</span>
        {ev.summary ? <span className="text-zinc-400"> · {ev.summary}</span> : null}
      </div>
      {resolved ? (
        <div className="text-xs text-zinc-400">{resolved === "allow" ? "✓ Allowed" : "✕ Denied"}</div>
      ) : active ? (
        <div className="flex gap-2">
          <button
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium hover:bg-emerald-500"
            onClick={() => onRespond?.(ev.request_id, { behavior: "allow" })}
          >
            Allow
          </button>
          <button
            className="rounded-md bg-zinc-700 px-3 py-1 text-xs font-medium hover:bg-zinc-600"
            onClick={() => onRespond?.(ev.request_id, { behavior: "deny" })}
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="text-xs text-zinc-500">waiting…</div>
      )}
    </div>
  );
}

function QuestionCard({
  ev,
  active,
  answered,
  onRespond,
}: {
  ev: Extract<RunEvent, { type: "question" }>;
  active: boolean;
  answered?: AnswerSelection[];
  onRespond?: Respond;
}) {
  const [sel, setSel] = useState<Record<string, string[]>>({});
  function toggle(q: Question, label: string) {
    setSel((prev) => {
      const cur = prev[q.header] ?? [];
      if (q.multiSelect) {
        return {
          ...prev,
          [q.header]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
        };
      }
      return { ...prev, [q.header]: [label] };
    });
  }
  function submit() {
    const answers: AnswerSelection[] = ev.questions.map((q) => ({
      header: q.header,
      labels: sel[q.header] ?? [],
    }));
    onRespond?.(ev.request_id, { answers });
  }
  return (
    <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm">
      {ev.questions.map((q) => (
        <div key={q.header}>
          <div className="mb-1 font-medium">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((o) => {
              const picked = answered
                ? answered.find((a) => a.header === q.header)?.labels.includes(o.label)
                : (sel[q.header] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  disabled={!active}
                  onClick={() => toggle(q, o.label)}
                  title={o.description}
                  className={`rounded-md px-2.5 py-1 text-xs ${
                    picked ? "bg-sky-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"
                  } disabled:opacity-60`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {answered ? (
        <div className="text-xs text-zinc-400">✓ Answered</div>
      ) : active ? (
        <button
          className="rounded-md bg-sky-600 px-3 py-1 text-xs font-medium hover:bg-sky-500"
          onClick={submit}
        >
          Submit
        </button>
      ) : (
        <div className="text-xs text-zinc-500">waiting…</div>
      )}
    </div>
  );
}

function Events({
  events,
  pendingIds,
  onRespond,
}: {
  events: RunEvent[];
  pendingIds: Set<string>;
  onRespond?: Respond;
}) {
  const permResolved = new Map<string, "allow" | "deny">();
  const qAnswered = new Map<string, AnswerSelection[]>();
  for (const e of events) {
    if (e.type === "permission_resolved") permResolved.set(e.request_id, e.behavior);
    if (e.type === "question_answered") qAnswered.set(e.request_id, e.answers);
  }
  return (
    <div className="space-y-1.5">
      {events.map((event, i) => {
        switch (event.type) {
          case "text":
            return (
              <div key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-100">
                {event.text}
              </div>
            );
          case "tool":
            return (
              <div key={i} className="font-mono text-xs text-zinc-400">
                {toolIcon(event.name)} {event.name}
                {event.summary ? `: ${event.summary}` : ""}
              </div>
            );
          case "result":
            return (
              <div key={i} className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-3 text-sm">
                <div className="whitespace-pre-wrap leading-relaxed">{event.result}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {typeof event.elapsed === "number" ? `${event.elapsed}s` : ""}
                  {typeof event.cost === "number" ? ` · $${event.cost.toFixed(4)}` : ""}
                </div>
              </div>
            );
          case "error":
            return (
              <div key={i} className="rounded-md bg-red-500/15 px-2 py-1 text-sm text-red-300">
                ⚠️ {event.message}
              </div>
            );
          case "stopped":
            return (
              <div key={i} className="text-xs text-zinc-500">
                ■ stopped
              </div>
            );
          case "permission":
            return (
              <PermissionCard
                key={i}
                ev={event}
                active={!!onRespond && pendingIds.has(event.request_id)}
                resolved={permResolved.get(event.request_id)}
                onRespond={onRespond}
              />
            );
          case "question":
            return (
              <QuestionCard
                key={i}
                ev={event}
                active={!!onRespond && pendingIds.has(event.request_id)}
                answered={qAnswered.get(event.request_id)}
                onRespond={onRespond}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

export function Transcript({
  turns,
  activeId,
  onRespond,
}: {
  turns: Turn[];
  activeId: string | null;
  onRespond: Respond;
}) {
  if (!turns.length) {
    return <div className="p-8 text-center text-sm text-zinc-500">No messages in this session yet.</div>;
  }
  return (
    <div className="space-y-5">
      {turns.map((turn) => {
        const isActive = turn.id === activeId;
        const pendingIds = new Set((turn.pending as PendingRequest[]).map((p) => p.request_id));
        const working = isActive && turn.status === "running" && turn.pending.length === 0;
        return (
          <div key={turn.id} className="space-y-2">
            <div className="flex justify-end">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-sm text-white">
                {turn.prompt}
              </div>
            </div>
            {(turn.events.length > 0 || turn.status === "running") && (
              <Events events={turn.events} pendingIds={pendingIds} onRespond={isActive ? onRespond : undefined} />
            )}
            {working && <div className="text-xs text-zinc-500">Working…</div>}
          </div>
        );
      })}
    </div>
  );
}
