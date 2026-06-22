import { useEffect, useMemo, useState } from "react";
import { api, type EnrichedSession } from "../api";

type Sort = "recent" | "cost";

function ago(sec: number): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Full-width per-repo history: every session grouped by repo with aggregates.
 *  Clicking a session resumes it (onOpen switches the active project first). */
export function HistoryView({ onOpen }: { onOpen: (s: EnrichedSession) => void }) {
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const h = await api.history(showArchived);
        if (live) setSessions(h.sessions);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [showArchived]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running();
        if (live) setRunning(new Set(r.bridge_running));
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = sessions.filter(
      (s) =>
        !q ||
        (s.title ?? "").toLowerCase().includes(q) ||
        s.project.toLowerCase().includes(q),
    );
    const byRepo = new Map<string, EnrichedSession[]>();
    for (const s of filtered) {
      const a = byRepo.get(s.project) ?? [];
      a.push(s);
      byRepo.set(s.project, a);
    }
    const within =
      sort === "cost"
        ? (a: EnrichedSession, b: EnrichedSession) => b.total_cost - a.total_cost
        : (a: EnrichedSession, b: EnrichedSession) => b.last_activity - a.last_activity;
    return [...byRepo.entries()]
      .map(([repo, ss]) => {
        ss.sort(within);
        return {
          repo,
          ss,
          cost: ss.reduce((n, s) => n + s.total_cost, 0),
          last: Math.max(...ss.map((s) => s.last_activity)),
        };
      })
      .sort((a, b) => b.last - a.last);
  }, [sessions, filter, sort]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter repos & chats…"
          className="w-64 rounded bg-zinc-800 px-2 py-1 outline-none placeholder:text-zinc-500"
        />
        {(["recent", "cost"] as Sort[]).map((s) => (
          <button
            key={s}
            onClick={() => setSort(s)}
            className={`rounded px-2 py-1 ${
              sort === s ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {s === "recent" ? "Recent" : "Cost"}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-zinc-400">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Archived
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {groups.length === 0 && (
          <div className="p-8 text-center text-sm text-zinc-500">No chats yet.</div>
        )}
        {groups.map((g) => (
          <div key={g.repo} className="mb-5">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold" title={g.repo}>
                {g.repo}
              </span>
              <span className="shrink-0 text-xs text-zinc-500">
                {g.ss.length} {g.ss.length === 1 ? "chat" : "chats"} · $
                {g.cost.toFixed(2)} · {ago(g.last)}
              </span>
            </div>
            <div className="space-y-1">
              {g.ss.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onOpen(s)}
                  className="flex w-full flex-col gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-left hover:bg-zinc-800/60"
                >
                  <div className="flex items-center gap-2">
                    {running.has(s.id) && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {s.title || "New chat"}
                      {s.archived ? " (archived)" : ""}
                    </span>
                  </div>
                  <div className="text-xs text-zinc-500">
                    {s.turn_count} {s.turn_count === 1 ? "turn" : "turns"} · $
                    {s.total_cost.toFixed(2)}
                    {s.models.length ? ` · ${s.models.join(", ")}` : ""} ·{" "}
                    {ago(s.last_activity)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
