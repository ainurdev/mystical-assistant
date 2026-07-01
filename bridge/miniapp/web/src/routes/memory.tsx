import { useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Pin, PinOff, Trash2 } from "lucide-react";
import { rootRoute } from "./root";
import { api, type Memory } from "../lib/api";
import { Skeleton } from "../components/ui";

const TYPE_LABEL: Record<string, string> = {
  convention: "Convention",
  decision: "Decision",
  preference: "Preference",
  goal: "Goal",
  gotcha: "Gotcha",
};

function groupKey(m: Memory): string {
  return m.scope === "user" ? "Your preferences" : m.project_path ?? "Project";
}

function MemoryPage() {
  const qc = useQueryClient();
  const items = useQuery({
    queryKey: ["memory"],
    queryFn: () => api.memoryItems(),
    refetchInterval: 8000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const rows = items.data?.items ?? [];

  const groups = new Map<string, Memory[]>();
  for (const m of rows) {
    const k = groupKey(m);
    const arr = groups.get(k);
    if (arr) arr.push(m);
    else groups.set(k, [m]);
  }

  async function mutate(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["memory"] });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 pb-10">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Brain size={15} className="text-[var(--brand-soft)]" aria-hidden />
        Project memory
      </div>

      {items.isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">
          Nothing yet. Facts you Keep from your turns show up here.
        </div>
      ) : (
        [...groups.entries()].map(([g, ms]) => (
          <div key={g} className="space-y-1.5">
            <div
              className="truncate text-xs font-medium text-[var(--brand-soft)]"
              title={g}
            >
              {g}
            </div>
            {ms.map((m) => (
              <div
                key={m.id}
                className="flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--tg-secondary-bg)] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-[var(--tg-button)]/15 px-1.5 py-0.5 text-[10px] text-[var(--tg-hint)]">
                      {TYPE_LABEL[m.type] ?? m.type}
                    </span>
                    {m.pinned ? (
                      <Pin size={11} className="text-[var(--brand-soft)]" aria-label="pinned" />
                    ) : null}
                    <span className="min-w-0 truncate text-sm font-semibold">{m.title}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--tg-hint)]">{m.body}</div>
                </div>
                <button
                  disabled={busy === m.id}
                  onClick={() => void mutate(m.id, () => api.memoryPin(m.id, !m.pinned))}
                  className="shrink-0 rounded p-1 text-[var(--tg-hint)] active:opacity-70"
                  aria-label={m.pinned ? "Unpin" : "Pin"}
                >
                  {m.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                </button>
                <button
                  disabled={busy === m.id}
                  onClick={() => void mutate(m.id, () => api.memoryStatus(m.id, "archived"))}
                  className="shrink-0 rounded p-1 text-red-300 active:opacity-70"
                  aria-label="Delete"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

export const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory",
  component: MemoryPage,
});
