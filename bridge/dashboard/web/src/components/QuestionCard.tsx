import { useEffect, useState } from "react";
import { Button, Card, Spinner } from "./ui";
import type { AnswerSelection, Question } from "../api";
import { clearDraft, readDraft, saveDraft } from "../lib/questionDraft";

// Mirrors bridge/miniapp/web/src/components/QuestionCard.tsx (shared design):
// full-width option rows with descriptions, not cramped wrapping chips.
export function QuestionCard({
  questions,
  requestId,
  active,
  answered,
  stale,
  onSubmit,
}: {
  questions: Question[];
  requestId: string;
  active: boolean;
  answered?: AnswerSelection[];
  /** Asked, never answered, and the run has since ended (see PermissionCard). */
  stale?: boolean;
  /** Resolves when the answer has reached the bridge; `false` means it didn't. */
  onSubmit: (answers: AnswerSelection[]) => void | Promise<boolean | void>;
}) {
  const [restored] = useState(() => readDraft(requestId));
  const [sel, setSel] = useState<Record<string, string[]>>(restored.sel);
  const [notes, setNotes] = useState<Record<string, string>>(restored.notes);
  // The answer travels to the bridge and only comes back on the next transcript
  // poll, so without this the card sits there looking untouched — the click
  // reads as dropped and people press it again.
  const [sending, setSending] = useState(false);

  // Hold the draft while the question is still open, so leaving the session (or
  // closing the tab) doesn't cost the answers already picked. Cleared on
  // `answered` rather than on `!active`, because a read-only render of the same
  // question — history, another surface — is inactive while the draft is live.
  useEffect(() => {
    if (answered) clearDraft(requestId);
    else if (active) saveDraft(requestId, { sel, notes });
  }, [requestId, active, answered, sel, notes]);

  if (!active) {
    // Resolved / historical: still show the prepared answers as buttons, with the
    // chosen one(s) highlighted (matches Claude Code's answered-question look).
    return (
      <Card className="space-y-3 border border-[var(--tg-button)]/30">
        {questions.map((q) => {
          const given = answered?.find((x) => x.header === q.header);
          const chosen = given?.labels ?? [];
          return (
            <div key={q.header} className="space-y-1.5">
              <div className="text-sm font-medium">{q.question}</div>
              <div className="flex flex-col gap-1.5">
                {q.options.map((o) => {
                  const picked = chosen.includes(o.label);
                  return (
                    <div
                      key={o.label}
                      className={`rounded-lg px-3 py-2 text-left text-sm ${
                        picked
                          ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]"
                          : "bg-[var(--tg-bg)] opacity-60"
                      }`}
                    >
                      <div className="font-medium">{o.label}</div>
                      {o.description && (
                        <div className={`text-xs ${picked ? "opacity-80" : "text-[var(--tg-hint)]"}`}>
                          {o.description}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {given?.notes && (
                <div className="text-xs text-[var(--tg-hint)]">Note: {given.notes}</div>
              )}
            </div>
          );
        })}
        {stale && (
          <div className="text-xs text-[var(--warn)]">
            Never answered — the run ended.
          </div>
        )}
      </Card>
    );
  }

  function toggle(q: Question, label: string) {
    setSel((prev) => {
      const cur = prev[q.header] ?? [];
      if (q.multiSelect) {
        return {
          ...prev,
          [q.header]: cur.includes(label)
            ? cur.filter((l) => l !== label)
            : [...cur, label],
        };
      }
      return { ...prev, [q.header]: [label] };
    });
  }

  // The options are Claude's guesses; when none fits, free text counts as the answer.
  const ready = questions.every(
    (q) => (sel[q.header]?.length ?? 0) > 0 || (notes[q.header] ?? "").trim() !== "",
  );
  const multi = questions.some((q) => q.multiSelect);

  async function submit() {
    if (sending) return;
    setSending(true);
    const ok = await onSubmit(
      questions.map((q) => ({
        header: q.header,
        labels: sel[q.header] ?? [],
        notes: (notes[q.header] ?? "").trim() || undefined,
      })),
    );
    // Delivered: stay disabled until the poll swaps in the answered card. Failed:
    // hand the button back rather than stranding them on a dead spinner.
    if (ok === false) setSending(false);
  }

  return (
    <Card className="space-y-3 border border-[var(--tg-button)]/30">
      {questions.map((q) => (
        <div key={q.header} className="space-y-1.5">
          <div className="text-sm font-medium">{q.question}</div>
          <div className="flex flex-col gap-1.5">
            {q.options.map((o) => {
              const picked = (sel[q.header] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  onClick={() => toggle(q, o.label)}
                  disabled={sending}
                  className={`rounded-lg px-3 py-2 text-left text-sm active:opacity-70 ${
                    picked
                      ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]"
                      : "bg-[var(--tg-bg)]"
                  }`}
                >
                  <div className="font-medium">{o.label}</div>
                  {o.description && (
                    <div
                      className={`text-xs ${picked ? "opacity-80" : "text-[var(--tg-hint)]"}`}
                    >
                      {o.description}
                    </div>
                  )}
                </button>
              );
            })}
            {/* A restored note sits inside this fold; open it or the draft reads as lost.
                `restored` never changes, so it's a default — your own toggling sticks.
                It rides *inside* the option list at option weight: an escape hatch that
                reads as a footnote under the buttons is one people scroll straight past. */}
            <details
              className={`group overflow-hidden rounded-lg border border-dashed ${
                (notes[q.header] ?? "").trim()
                  ? "border-[var(--tg-button)]"
                  : "border-[var(--tg-hint)]/40"
              }`}
              open={(restored.notes[q.header] ?? "") !== ""}
            >
              <summary className="cursor-pointer list-none px-3 py-2 text-left text-sm active:opacity-70 [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2 font-medium">
                  <span className="shrink-0 text-[10px] transition-transform group-open:rotate-90">
                    ▶
                  </span>
                  None of these
                </span>
                <span className="block pl-[18px] text-xs text-[var(--tg-hint)]">
                  Answer in your own words
                </span>
              </summary>
              <textarea
                rows={2}
                value={notes[q.header] ?? ""}
                onChange={(e) => setNotes((prev) => ({ ...prev, [q.header]: e.target.value }))}
                // Enter sends (same as the composer); shift+Enter for a newline.
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && ready && !sending) { e.preventDefault(); void submit(); } }}
                placeholder="Your own answer, or extra context for this question"
                className="w-full resize-y border-t border-dashed border-[inherit] bg-[var(--tg-bg)] px-3 py-2 text-sm outline-none"
              />
            </details>
          </div>
        </div>
      ))}
      <Button className="w-full" disabled={!ready || sending} onClick={() => void submit()}>
        {sending ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="h-3 w-3 border" /> Sending…
          </span>
        ) : multi ? "Submit" : "Send answer"}
      </Button>
    </Card>
  );
}
