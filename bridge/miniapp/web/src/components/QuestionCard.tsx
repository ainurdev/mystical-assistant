import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button, Card, Spinner } from "./ui";
import type { AnswerSelection, Question } from "../lib/api";
import { clearDraft, readDraft, saveDraft } from "../lib/questionDraft";

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
  // The free-text fold per question. A restored note opens it by default (or the
  // draft reads as lost); your own toggling overrides that — `restored` is static.
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // The answer travels to the bridge and only comes back on the next transcript
  // poll, so without this the card sits there looking untouched — the click
  // reads as dropped and people press it again.
  const [sending, setSending] = useState(false);

  // Hold the draft while the question is still open, so leaving the session (or
  // closing the webview) doesn't cost the answers already picked. Cleared on
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
          <div className="text-xs text-amber-400">Never answered — the run ended.</div>
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

  // An open question is the one thing in the transcript that is blocking you —
  // it wears the amber corner-tick frame so it reads as such at a glance.
  return (
    <div className="panel space-y-3 border border-amber-400/45 bg-[var(--card)] p-3.5">
      <div className="text-[9.5px] tracking-[2px] text-amber-400">? QUESTION // NEEDS YOU</div>
      {questions.map((q) => {
        const open = openNotes[q.header] ?? (restored.notes[q.header] ?? "") !== "";
        // Typed text counts as the answer (see `ready`), so the frame says so.
        const frame = (notes[q.header] ?? "").trim() ? "border-[var(--brand-soft)]" : "border-border";
        return (
        <div key={q.header} className="space-y-1.5">
          <div className="text-sm font-medium text-foreground-bright">{q.question}</div>
          <div className="flex flex-col gap-1.5">
            {q.options.map((o, i) => {
              const picked = (sel[q.header] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  onClick={() => toggle(q, o.label)}
                  disabled={sending}
                  className={`border px-3 py-2.5 text-left text-sm active:opacity-70 ${
                    picked
                      ? "border-[var(--brand-soft)] bg-[var(--ac-12)] text-foreground-bright"
                      : "border-border bg-[var(--tg-bg)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`shrink-0 text-[10px] tracking-wider ${
                        picked ? "text-[var(--brand-soft)]" : "text-[var(--tg-hint)]"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className="font-medium">{o.label}</span>
                  </div>
                  {o.description && (
                    <div className={`pl-[17px] text-xs ${picked ? "opacity-80" : "text-[var(--tg-hint)]"}`}>
                      {o.description}
                    </div>
                  )}
                </button>
              );
            })}
            {/* The free-text escape hatch rides *inside* the option list at option
                weight, on the numbered gutter: as a footnote it got scrolled past.
                Not a <details>: its content is display:none while closed, so it can
                only snap open. A 0fr→1fr grid row transitions everywhere, and a
                button's click handler can focus the textarea synchronously — which is
                what lets phones raise the keyboard on that same tap. */}
            <div className={`overflow-hidden border border-dashed ${frame}`}>
              <button
                type="button"
                aria-expanded={open}
                disabled={sending}
                onClick={() => {
                  // flushSync: the textarea is inert while closed, so the open render
                  // has to commit before focus() — and focus has to stay inside this
                  // tap's task or iOS won't raise the keyboard.
                  flushSync(() => setOpenNotes((prev) => ({ ...prev, [q.header]: !open })));
                  if (!open) noteRefs.current[q.header]?.focus({ preventScroll: true });
                }}
                className="w-full px-3 py-2.5 text-left text-sm active:opacity-70"
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`shrink-0 text-[10px] tracking-wider text-[var(--tg-hint)] transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                  >
                    ▶
                  </span>
                  <span className="font-medium">None of these</span>
                </span>
                <span className="block pl-[17px] text-xs text-[var(--tg-hint)]">
                  Answer in your own words
                </span>
              </button>
              <div
                className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
                  open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                }`}
              >
                <div className="min-h-0 overflow-hidden" inert={!open}>
                  <textarea
                    ref={(el) => { noteRefs.current[q.header] = el; }}
                    rows={2}
                    value={notes[q.header] ?? ""}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [q.header]: e.target.value }))}
                    // Enter sends (same as the composer); shift+Enter for a newline.
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && ready && !sending) { e.preventDefault(); void submit(); } }}
                    placeholder="Your own answer, or extra context for this question"
                    className={`block w-full resize-y border-t border-dashed bg-[var(--tg-bg)] px-3 py-2 text-sm outline-none ${frame}`}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        );
      })}
      <Button
        className="w-full shadow-[0_0_18px_var(--brand-glow)]"
        disabled={!ready || sending}
        onClick={() => void submit()}
      >
        {sending ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="h-3 w-3 border" /> Sending…
          </span>
        ) : multi ? "Submit" : "Send answer"}
      </Button>
    </div>
  );
}
