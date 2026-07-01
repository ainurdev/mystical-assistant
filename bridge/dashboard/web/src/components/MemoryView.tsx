import { useEffect, useState } from "react";
import { Pin, PinOff, Trash2 } from "lucide-react";
import { api, type Memory } from "../api";
import { Skeleton } from "./ui";

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

/** Full-width project-memory manager: kept facts grouped by scope/project, with
 *  pin (controls injection priority) and delete (archive). */
export function MemoryView() {
  const [items, setItems] = useState<Memory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.memoryItems();
      setItems(r.items);
      setLoaded(true);
    } catch {
      /* ignore */
    }
  };

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
  }, []);

  async function mutate(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
      await load();
    } finally {
      setBusy(null);
    }
  }

  const groups = new Map<string, Memory[]>();
  for (const m of items) {
    const k = groupKey(m);
    const arr = groups.get(k);
    if (arr) arr.push(m);
    else groups.set(k, [m]);
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      {!loaded ? (
        [0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5 rounded-md border border-border bg-card px-3 py-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))
      ) : items.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          Nothing yet. Facts you Keep from your turns show up here.
        </div>
      ) : (
        [...groups.entries()].map(([g, ms]) => (
          <div key={g} className="space-y-1">
            <div
              className="truncate text-xs font-medium text-[var(--brand-soft)]"
              title={g}
            >
              {g}
            </div>
            {ms.map((m) => (
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
            ))}
          </div>
        ))
      )}
    </div>
  );
}
