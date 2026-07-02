import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GraduationCap } from "lucide-react";
import { api, type LearningItem } from "../lib/api";
import { Button, Card } from "./ui";
import { Markdown } from "./Markdown";

type Mode = "explain" | "quiz" | "exercise" | "grade";

export function TeacherView() {
  const { data } = useQuery({
    queryKey: ["learning-items"],
    queryFn: () => api.learningItems(),
    refetchInterval: 5000,
  });
  const items = data?.items ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const open = items.find((i) => i.id === openId) ?? null;

  // group by project
  const groups = new Map<string, LearningItem[]>();
  for (const it of items) {
    const g = groups.get(it.project_path) ?? [];
    g.push(it);
    groups.set(it.project_path, g);
  }

  if (open) return <TeacherDetail item={open} onBack={() => setOpenId(null)} />;

  return (
    <div className="space-y-3 p-2">
      {items.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-[var(--tg-hint)]">
          <GraduationCap size={28} aria-hidden />
          Nothing to review yet. Keep a card after a code turn and it lands here.
        </div>
      )}
      {[...groups.entries()].map(([project, its]) => (
        <div key={project} className="space-y-1.5">
          <div className="font-mono text-xs text-[var(--tg-hint)]">
            {project.split("/").pop()}
          </div>
          {its.map((it) => (
            <button
              key={it.id}
              onClick={() => setOpenId(it.id)}
              className="flex w-full items-center gap-2 rounded-lg bg-[var(--tg-secondary-bg)] px-3 py-2 text-left"
            >
              <span className="flex-1 text-sm">{it.title}</span>
              <span className="text-xs text-[var(--brand-soft)]">
                {"●".repeat(Math.max(0, Math.min(it.mastery, 3))) || "○"}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function TeacherDetail({ item, onBack }: { item: LearningItem; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [answer, setAnswer] = useState("");

  const run = async (mode: Mode, user_answer?: string) => {
    setBusy(true);
    setOutput("");
    try {
      const r = await api.learningTeach({ item_id: item.id, mode, user_answer });
      setOutput(r.text || "Couldn't generate — try again.");
    } catch {
      setOutput("Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-2">
      <button onClick={onBack} className="text-xs text-[var(--tg-hint)]">
        ← back
      </button>
      <Card className="space-y-2">
        <div className="text-sm font-semibold">{item.title}</div>
        {item.why_it_matters && (
          <div className="text-xs text-[var(--tg-hint)]">{item.why_it_matters}</div>
        )}
        {item.code_snippet && (
          <pre className="overflow-x-auto rounded bg-black/20 p-2 font-mono text-xs text-[var(--tg-hint)]">
            {item.code_snippet}
          </pre>
        )}
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => run("explain")}>
          Explain
        </Button>
        <Button disabled={busy} variant="secondary" onClick={() => run("quiz")}>
          Quiz me
        </Button>
        <Button disabled={busy} variant="secondary" onClick={() => run("exercise")}>
          Exercise
        </Button>
      </div>

      <div className="space-y-1.5">
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Explain it back in your own words…"
          className="w-full rounded-lg bg-[var(--tg-secondary-bg)] p-2 text-sm outline-none"
          rows={3}
        />
        <Button
          disabled={busy || !answer.trim()}
          onClick={() => run("grade", answer)}
        >
          Grade my understanding
        </Button>
      </div>

      {busy && <div className="text-xs text-[var(--tg-hint)]">Thinking…</div>}
      {output && (
        <Card>
          <Markdown className="text-sm leading-relaxed">{output}</Markdown>
        </Card>
      )}

      <div className="flex gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            void api.learningItem(item.id, "reviewed");
            onBack();
          }}
        >
          Mark reviewed
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            void api.learningItem(item.id, "archive");
            onBack();
          }}
        >
          Archive
        </Button>
      </div>
    </div>
  );
}
