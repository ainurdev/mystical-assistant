import { useQuery } from "@tanstack/react-query";
import { Bot, Code2, TerminalSquare } from "lucide-react";
import { api, type RunningSource } from "../lib/api";
import { useChat } from "../lib/chat";

function ago(sec: number | null): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function SourceIcon({ source }: { source: RunningSource }) {
  const cls = "shrink-0 text-[var(--tg-hint)]";
  if (source === "vscode") return <Code2 size={13} className={cls} aria-hidden />;
  if (source === "sdk" || source === "bridge")
    return <Bot size={13} className={cls} aria-hidden />;
  return <TerminalSquare size={13} className={cls} aria-hidden />;
}

const rowClass =
  "flex w-full items-center gap-2 rounded-lg bg-[var(--tg-bg)] px-2 py-1.5 text-left text-xs";

/** Compact machine-wide "Running now" monitor: this chat's live bridge jobs
 *  with what each is doing (tappable), followed by read-only external sessions
 *  (VS Code / terminal). */
export function RunningNow() {
  const { selectSession } = useChat();
  const { data } = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  const external = data?.external ?? [];
  const jobs = data?.jobs ?? [];
  if (external.length === 0 && jobs.length === 0) return null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--tg-secondary-bg)] p-2">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium text-[var(--tg-hint)]">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </span>
        Running now · this machine
      </div>
      <div className="space-y-1">
        {jobs.map((j) => {
          const awaiting = j.activity.state === "awaiting";
          return (
            <button
              key={j.job_id}
              onClick={() => j.session_id && selectSession(j.session_id)}
              className={`${rowClass} active:opacity-70`}
            >
              <Bot size={13} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate">{j.title || "New chat"}</div>
                <div className="truncate text-[10px] text-[var(--tg-hint)]">
                  {j.activity.label}
                </div>
              </div>
              {awaiting ? (
                <span className="shrink-0 text-[10px] text-amber-400">waiting</span>
              ) : (
                <span className="shrink-0 text-[10px] text-[var(--tg-hint)]">{ago(j.started)}</span>
              )}
            </button>
          );
        })}
        {external.map((r) => (
          <div key={r.session_id} className={rowClass} title={r.cwd}>
            <SourceIcon source={r.source} />
            <span className="min-w-0 flex-1 truncate">{r.project}</span>
            <span className="shrink-0 rounded bg-[var(--tg-secondary-bg)] px-1.5 py-0.5 text-[10px] text-[var(--tg-hint)]">
              {r.source}
            </span>
            {r.status === "waiting" ? (
              <span className="shrink-0 text-[10px] text-amber-400">waiting</span>
            ) : (
              <span className="shrink-0 text-[10px] text-[var(--tg-hint)]">
                {ago(r.started)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
