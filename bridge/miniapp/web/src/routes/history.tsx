import { useMemo, useState } from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search, CircleHelp } from "lucide-react";
import { rootRoute } from "./root";
import { api, type EnrichedSession } from "../lib/api";
import { useChat } from "../lib/chat";

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

// Where a session started, for the surface badge (null = bridge default / unknown).
function originLabel(o?: string | null): string | null {
  return { vscode: "VS Code", terminal: "Terminal", dashboard: "Desktop",
           miniapp: "Phone", bot: "Bot" }[o ?? ""] ?? null;
}

function HistoryPage() {
  const navigate = useNavigate();
  const { openSessionInProject } = useChat();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [showArchived, setShowArchived] = useState(false);

  const history = useQuery({
    queryKey: ["history", showArchived],
    queryFn: () => api.getHistory(showArchived),
    refetchInterval: 5000,
  });
  const running = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  const runningIds = new Set(running.data?.bridge_running ?? []);
  const awaitingIds = new Set((running.data?.awaiting ?? []).map((a) => a.session_id));

  // Filter, group by repo, sort within + across groups.
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sessions = (history.data?.sessions ?? []).filter(
      (s) =>
        !q ||
        (s.title ?? "").toLowerCase().includes(q) ||
        s.project.toLowerCase().includes(q),
    );
    const byRepo = new Map<string, EnrichedSession[]>();
    for (const s of sessions) {
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
  }, [history.data, filter, sort]);

  async function open(s: EnrichedSession) {
    await openSessionInProject(s.project, s.id);
    void navigate({ to: "/" });
  }

  return (
    <div className="space-y-4 pb-10">
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-lg bg-[var(--tg-secondary-bg)] px-2.5 py-1.5">
          <Search size={14} className="text-[var(--tg-hint)]" aria-hidden />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter repos & chats…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--tg-hint)]"
          />
        </div>
        <div className="flex items-center gap-2 text-xs">
          {(["recent", "cost"] as Sort[]).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={`rounded-lg px-2.5 py-1 ${
                sort === s
                  ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]"
                  : "bg-[var(--tg-secondary-bg)] text-[var(--tg-hint)]"
              }`}
            >
              {s === "recent" ? "Recent" : "Cost"}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-[var(--tg-hint)]">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Archived
          </label>
        </div>
      </div>

      {groups.length === 0 && (
        <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">
          No chats yet.
        </div>
      )}

      {groups.map((g) => (
        <div key={g.repo} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <span className="min-w-0 truncate text-xs font-semibold" title={g.repo}>
              {g.repo}
            </span>
            <span className="shrink-0 text-[10px] text-[var(--tg-hint)]">
              {g.ss.length} · ${g.cost.toFixed(2)} · {ago(g.last)}
            </span>
          </div>
          {g.ss.map((s) => (
            <button
              key={s.id}
              onClick={() => void open(s)}
              className="flex w-full flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--tg-secondary-bg)] px-3 py-2 text-left active:opacity-70"
            >
              <div className="flex items-center gap-2">
                {awaitingIds.has(s.id) ? (
                  <CircleHelp
                    size={13}
                    className="shrink-0 text-amber-400 motion-safe:animate-pulse"
                    aria-label="waiting for your answer"
                  />
                ) : runningIds.has(s.id) ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                ) : null}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {s.title || "New chat"}
                  {s.archived ? " (archived)" : ""}
                </span>
                {originLabel(s.origin) && (
                  <span className="shrink-0 rounded bg-[var(--tg-button)]/15 px-1.5 py-0.5 text-[10px] text-[var(--tg-hint)]">
                    {originLabel(s.origin)}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--tg-hint)]">
                {s.turn_count} {s.turn_count === 1 ? "turn" : "turns"} · $
                {s.total_cost.toFixed(2)}
                {s.models.length ? ` · ${s.models.join(", ")}` : ""} ·{" "}
                {ago(s.last_activity)}
              </div>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: HistoryPage,
});
