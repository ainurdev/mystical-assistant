import { useState } from "react";
import { Button, Card } from "./ui";
import type { AnswerSelection, Question } from "../api";

// Mirrors bridge/miniapp/web/src/components/QuestionCard.tsx (shared design):
// full-width option rows with descriptions, not cramped wrapping chips.
export function QuestionCard({
  questions,
  active,
  answered,
  onSubmit,
}: {
  questions: Question[];
  active: boolean;
  answered?: AnswerSelection[];
  onSubmit: (answers: AnswerSelection[]) => void;
}) {
  const [sel, setSel] = useState<Record<string, string[]>>({});

  if (!active) {
    return (
      <Card className="space-y-1 border border-[var(--tg-button)]/30">
        {questions.map((q) => {
          const a = answered?.find((x) => x.header === q.header);
          return (
            <div key={q.header} className="text-sm">
              <span className="text-[var(--tg-hint)]">{q.question} </span>
              <span className="font-medium">{a ? a.labels.join(", ") : "—"}</span>
            </div>
          );
        })}
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

  const ready = questions.every((q) => (sel[q.header]?.length ?? 0) > 0);
  const multi = questions.some((q) => q.multiSelect);

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
          </div>
        </div>
      ))}
      <Button
        className="w-full"
        disabled={!ready}
        onClick={() =>
          onSubmit(questions.map((q) => ({ header: q.header, labels: sel[q.header] ?? [] })))
        }
      >
        {multi ? "Submit" : "Send answer"}
      </Button>
    </Card>
  );
}
