import { memo, useState } from "react";
import {
  Pencil,
  BookOpen,
  Terminal,
  Search,
  Wrench,
  TriangleAlert,
  CircleStop,
  Copy,
  Check,
} from "lucide-react";
import type { AnswerSelection, PendingRequest, RunEvent } from "../lib/api";
import { Card } from "./ui";
import { foldChips } from "../lib/toolfold";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";

// Map a few common tool names to icons; default to a wrench.
function ToolIcon({ name }: { name: string }) {
  const props = {
    size: 13,
    className: "shrink-0 text-[var(--brand-soft)]",
    "aria-hidden": true,
  } as const;
  switch (name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
      return <Pencil {...props} />;
    case "Read":
      return <BookOpen {...props} />;
    case "Bash":
      return <Terminal {...props} />;
    case "Grep":
    case "Glob":
      return <Search {...props} />;
    default:
      return <Wrench {...props} />;
  }
}

type Done = { ms?: number; output?: string; is_error?: boolean; patch?: string[] };

// Output/diff lines shown before a block folds — a turn can hold dozens.
const OUT_PREVIEW = 6;
const DIFF_PREVIEW = 20;

/** A failed Bash result opens with the shell's status line ("Exit code 2\n…").
 *  It belongs in the header as a badge, not in the body. */
const EXIT_RE = /^(?:Error: )?Exit code (\d+)\n?/;

function dur(ms?: number): string {
  if (!ms) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A Bash call drawn as the terminal it actually is: the command at a prompt, a
 *  live caret while it runs, then its output. Failed commands open themselves. */
function TerminalBlock({
  command,
  done,
}: {
  command: string;
  done?: Done;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const running = !done;
  const failed = !!done?.is_error;
  const raw = (done?.output ?? "").trimEnd();
  const exit = raw.match(EXIT_RE);
  const out = exit ? raw.slice(exit[0].length) : raw;
  const lines = out ? out.split("\n") : [];
  const shown = open || failed ? lines : lines.slice(0, OUT_PREVIEW);
  const hidden = lines.length - shown.length;
  const accent = failed ? "var(--danger)" : running ? "var(--warning)" : "var(--success)";

  return (
    <div
      className="overflow-hidden rounded-lg border bg-black/25"
      style={{
        borderColor: failed ? "color-mix(in srgb, var(--danger) 32%, transparent)" : "var(--border)",
      }}
    >
      <div className="flex w-full items-center gap-2 border-b border-[var(--border)] bg-[var(--ac-03)] px-2.5 py-1.5">
        <span className="flex flex-none gap-[3px]" aria-hidden>
          <i
            className="block h-[5px] w-[5px] rounded-full"
            style={{
              background: accent,
              animation: running ? "caret 1.1s steps(1) infinite" : undefined,
            }}
          />
          <i className="block h-[5px] w-[5px] rounded-full bg-[var(--muted-2)]" />
          <i className="block h-[5px] w-[5px] rounded-full bg-[var(--muted-2)]" />
        </span>
        <span className="flex-none text-[9.5px] tracking-[2px]" style={{ color: accent }}>
          BASH // {running ? "RUNNING" : failed ? "FAILED" : "OK"}
        </span>
        {done?.ms ? (
          <span className="flex-none text-[9.5px] tracking-[1px] text-[var(--muted-2)]">· {dur(done.ms)}</span>
        ) : null}
        {exit && (
          <span className="flex-none text-[9.5px] tracking-[1px]" style={{ color: "var(--danger)" }}>
            · EXIT {exit[1]}
          </span>
        )}
        <span className="ml-auto flex flex-none items-center gap-2.5">
          <button
            type="button"
            title="copy command"
            onClick={() => {
              void navigator.clipboard?.writeText(command).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            className="text-[var(--tg-hint)]"
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          </button>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-[9.5px] tracking-[1px] text-[var(--tg-hint)]"
            >
              +{hidden} LINES ⌄
            </button>
          )}
        </span>
      </div>
      <div className="px-2.5 py-2 font-mono text-xs leading-relaxed">
        <div className="flex gap-1.5">
          <span className="flex-none select-none text-[var(--brand-soft)]">❯</span>
          <span className="min-w-0 break-all whitespace-pre-wrap text-[var(--foreground-bright)]">
            {command}
            {running && (
              <span
                className="ml-px inline-block h-[1em] w-[6px] translate-y-[2px] bg-[var(--brand-soft)] align-middle"
                style={{ animation: "caret 1s steps(1) infinite" }}
              />
            )}
          </span>
        </div>
        {shown.length > 0 && (
          <pre
            className="mt-1.5 break-all whitespace-pre-wrap text-[11px] leading-[1.55]"
            style={{ color: failed ? "var(--danger)" : "var(--tg-hint)" }}
          >
            {shown.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}

function diffColor(line: string): string {
  if (line.startsWith("@@")) return "var(--violet)";
  if (line.startsWith("+")) return "var(--success)";
  if (line.startsWith("-")) return "var(--danger)";
  return "var(--tg-hint)";
}

/** An edit shown as the diff Claude Code already computed for it, so a turn says
 *  what changed instead of just which file was touched. */
function DiffBlock({
  name,
  path,
  patch,
  ms,
}: {
  name: string;
  path: string;
  patch: string[];
  ms?: number;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? patch : patch.slice(0, DIFF_PREVIEW);
  const hidden = patch.length - shown.length;
  const add = patch.filter((l) => l.startsWith("+")).length;
  const del = patch.filter((l) => l.startsWith("-")).length;

  return (
    <div className="overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--success)_24%,transparent)] bg-black/25">
      <div className="flex items-center gap-2 border-b border-[color-mix(in_srgb,var(--success)_16%,transparent)] bg-[var(--ac-03)] px-2.5 py-1.5">
        <span className="flex-none text-[9.5px] tracking-[2px] text-[var(--success)]">
          {name.toUpperCase()} //
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-[var(--foreground-bright)]">{path}</span>
        {ms ? (
          <span className="flex-none text-[9.5px] tracking-[1px] text-[var(--muted-2)]">· {dur(ms)}</span>
        ) : null}
        <span className="ml-auto flex flex-none items-center gap-2.5 text-[9.5px] tracking-[1px]">
          <span>
            <span style={{ color: "var(--success)" }}>+{add}</span>{" "}
            <span style={{ color: "var(--danger)" }}>−{del}</span>
          </span>
          {hidden > 0 && (
            <button type="button" onClick={() => setOpen(true)} className="text-[var(--tg-hint)]">
              +{hidden} ⌄
            </button>
          )}
        </span>
      </div>
      <div className="overflow-x-auto px-2.5 py-1.5 font-mono text-[11px] leading-[1.55]">
        {shown.map((line, i) => (
          <div key={i} className="whitespace-pre" style={{ color: diffColor(line) }}>
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A run of plain lookups collapsed to one line — on a phone the chips are most
 *  of the scroll. */
function FoldedChips({ names, onOpen }: { names: string[]; onOpen: () => void }) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const label = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-1.5 font-mono text-xs text-[var(--tg-hint)]"
    >
      <Wrench size={13} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
      <span className="min-w-0 truncate text-left">
        {names.length} steps — {label}
      </span>
      <span className="ml-auto flex-none">⌄</span>
    </button>
  );
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
      <Markdown className="text-sm leading-relaxed">{result}</Markdown>
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

// Memoized: a long session's past turns keep the same `events`/`pending` arrays
// across polls (see mergeDelta), so only the live turn re-renders.
export const RunStream = memo(function RunStream({
  events,
  pending = [],
  onRespond,
  ended = false,
}: {
  events: RunEvent[];
  pending?: PendingRequest[];
  onRespond?: RespondFn;
  ended?: boolean;
}) {
  const [openFolds, setOpenFolds] = useState<Set<number>>(new Set());
  const pendingIds = new Set(pending.map((p) => p.request_id));
  const permResolved = new Map<string, "allow" | "deny">();
  const qAnswered = new Map<string, AnswerSelection[]>();
  const toolDone = new Map<string, Done>();
  for (const e of events) {
    if (e.type === "permission_resolved") permResolved.set(e.request_id, e.behavior);
    if (e.type === "question_answered") qAnswered.set(e.request_id, e.answers);
    if (e.type === "tool_done" && e.id) toolDone.set(e.id, e);
  }
  // Turns recorded before tool events carried ids can't be paired, so they read
  // as finished commands instead of stuck carets.
  const doneOf = (e: RunEvent): Done | undefined =>
    e.type === "tool" ? (e.id ? toolDone.get(e.id) : {}) : undefined;

  const { folds, headOf } = foldChips(events, (i) => {
    const e = events[i];
    if (e.type !== "tool") return false;
    return e.name === "Bash" || !!doneOf(e)?.patch;
  });

  // The turn's closing text arrives twice — streamed as a text block, then again
  // as the run's result — so only the result card draws it. A native session
  // emits no result event, so its final text keeps rendering as text.
  const resultText = events.find((e) => e.type === "result")?.result?.trim();

  return (
    // vskip-card: off-screen event cards skip layout/paint (see index.css).
    <div className="space-y-2 vskip-card">
      {events.map((event, i) => {
        switch (event.type) {
          case "text":
            if (resultText && event.text.trim() === resultText) return null;
            return (
              <Markdown key={i} className="text-sm leading-relaxed">
                {event.text}
              </Markdown>
            );
          case "tool": {
            const head = headOf.get(i);
            if (head !== undefined && !openFolds.has(head)) return null;
            const fold = folds.get(i);
            if (fold && !openFolds.has(i))
              return (
                <FoldedChips
                  key={i}
                  names={fold.map((j) => (events[j] as { name: string }).name)}
                  onOpen={() => setOpenFolds((s) => new Set(s).add(i))}
                />
              );
            const done = doneOf(event);
            if (event.name === "Bash")
              return <TerminalBlock key={i} command={event.summary} done={done} />;
            if (done?.patch)
              return (
                <DiffBlock key={i} name={event.name} path={event.summary} patch={done.patch} ms={done.ms} />
              );
            return (
              <div
                key={i}
                className="flex items-center gap-1.5 font-mono text-xs text-[var(--tg-hint)]"
              >
                <ToolIcon name={event.name} />
                <span className="min-w-0 break-all">
                  {event.name}
                  {event.summary ? `: ${event.summary}` : ""}
                </span>
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
                // The run this belonged to is gone (restart, Stop, crash), so
                // nothing is listening for an answer any more.
                stale={ended && !permResolved.has(event.request_id)}
                onAllow={() => onRespond?.(event.request_id, { behavior: "allow" })}
                onDeny={() => onRespond?.(event.request_id, { behavior: "deny" })}
              />
            );
          case "question":
            return (
              <QuestionCard
                key={i}
                questions={event.questions}
                requestId={event.request_id}
                active={!!onRespond && pendingIds.has(event.request_id)}
                answered={qAnswered.get(event.request_id)}
                stale={ended && !qAnswered.has(event.request_id)}
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
});
