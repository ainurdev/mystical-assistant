import { useCallback, useEffect, useState } from "react";
import { Brain, Pin, PinOff, Trash2 } from "lucide-react";
import { api, type Memory, type ProjectSettings } from "../../api";
import { MemoryCandidateCard } from "../MemoryCandidateCard";

const TYPE_LABEL: Record<string, string> = {
  convention: "Convention",
  decision: "Decision",
  preference: "Preference",
  goal: "Goal",
  gotcha: "Gotcha",
};
const MODES = ["ask", "auto", "off"] as const;
const MODE_HINT: Record<string, string> = {
  ask: "Proposed facts wait for your Keep/Skip.",
  auto: "Proposed facts are kept automatically.",
  off: "No facts are recorded or injected for this project.",
};

/** Project-scoped memory manager (AnalyzeModal MEMORY tab): posture control +
 *  pending Keep/Skip candidates + kept facts with pin / delete. */
export function MemoryTab({ project }: { project: string }) {
  const [active, setActive] = useState<Memory[]>([]);
  const [candidates, setCandidates] = useState<Memory[]>([]);
  const [mode, setMode] = useState<string>("ask");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, c, s] = await Promise.all([
        api.memoryItems(project, "active"),
        api.memoryItems(project, "candidate"),
        api.projectSettings({ project }),
      ]);
      setActive(a.items);
      setCandidates(c.items);
      setMode((s as ProjectSettings).memory_mode || "ask");
      setLoaded(true);
    } catch {
      /* ignore */
    }
  }, [project]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (live) await load();
    };
    void tick();
    const id = setInterval(tick, 8000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [load]);

  async function pickMode(m: string) {
    setMode(m);
    try {
      await api.setProjectSettings({ project }, { memory_mode: m });
    } catch {
      /* ignore */
    }
    void load();
  }

  async function mutate(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
      await load();
    } finally {
      setBusy(null);
    }
  }

  const off = mode === "off";

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Brain size={15} className="text-[var(--brand-soft)]" aria-hidden />
          <span>Project memory</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {active.length} kept · {candidates.length} pending
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          Facts kept here are injected into every session in this project, so Claude
          knows its conventions, decisions, and goal without re-deriving them.
        </div>
        <div className="flex gap-1">
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => void pickMode(m)}
              className={
                "rounded px-2.5 py-1 text-xs capitalize " +
                (mode === m
                  ? "bg-primary/20 text-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {m}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground">{MODE_HINT[mode]}</div>
      </div>

      {off ? null : (
        <>
          {candidates.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-[var(--brand-soft)]">Pending</div>
              {candidates.map((m) => (
                <MemoryCandidateCard
                  key={m.id}
                  itemId={m.id}
                  memType={m.type}
                  scope={m.scope}
                  title={m.title}
                  body={m.body}
                />
              ))}
            </div>
          )}

          {loaded && active.length === 0 && candidates.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Nothing yet. Facts Claude learns in this project show up here.
            </div>
          ) : (
            active.map((m) => (
              <div
                key={m.id}
                className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {TYPE_LABEL[m.type] ?? m.type}
                    </span>
                    {m.pinned ? (
                      <Pin size={11} className="text-[var(--brand-soft)]" aria-label="pinned" />
                    ) : null}
                    <span className="min-w-0 truncate text-sm font-semibold">{m.title}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{m.body}</div>
                </div>
                <button
                  disabled={busy === m.id}
                  onClick={() => void mutate(m.id, () => api.memoryPin(m.id, !m.pinned))}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
                  aria-label={m.pinned ? "Unpin" : "Pin"}
                >
                  {m.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                </button>
                <button
                  disabled={busy === m.id}
                  onClick={() => void mutate(m.id, () => api.memoryStatus(m.id, "archived"))}
                  className="shrink-0 rounded p-1 text-red-300 hover:text-red-200"
                  aria-label="Delete"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
