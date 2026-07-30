import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronUp, Code2, TerminalSquare } from "lucide-react";
import { api, type RunningSource, type SessionState } from "../lib/api";
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

function SourceIcon({ source }: { source: RunningSource | null }) {
  const cls = "shrink-0 text-[var(--tg-hint)]";
  if (source === "vscode") return <Code2 size={13} className={cls} aria-hidden />;
  return <TerminalSquare size={13} className={cls} aria-hidden />;
}

// Awaiting you sorts first — it's the only state you can act on — then working,
// then merely-live native sessions.
const ORDER: Record<SessionState, number> = { awaiting: 0, working: 1, live: 2, idle: 3 };

interface Row {
  sessionId: string;
  title: string;
  label: string;
  state: SessionState;
  source: "bridge" | "native";
  project: string | null;
  started: number | null;
  extSource: RunningSource | null;
}

const rowClass =
  "flex w-full items-center gap-2 rounded-lg bg-[var(--tg-bg)] px-2 py-1.5 text-left text-xs";

/** Every session on this machine that isn't idle, from the backend's unified
 *  status map: your bridge chats that are working or awaiting you (any project,
 *  not just the open one) plus VS Code/terminal sessions that are working or
 *  live. Bridge rows tap through to that chat; native ones are read-only.
 *
 *  Sticky and collapsed by default: the transcript auto-scrolls to the bottom,
 *  so a plain block at the top of the page is unreachable in an active chat. */
export function ActiveSessions() {
  const [expanded, setExpanded] = useState(false);
  const { sessions, sessionId, selectSession, openSessionInProject } = useChat();
  const { data } = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  // Shared ["state"] cache with the header — tells us whether opening a row also
  // has to switch project.
  const { data: state } = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 5000,
  });
  const project = state?.project?.rel ?? null;

  // The status map has the state; jobs/external carry the detail (title, project,
  // start time) that makes a row readable.
  const jobBy = new Map(
    (data?.jobs ?? []).flatMap((j) => (j.session_id ? [[j.session_id, j] as const] : [])),
  );
  const extBy = new Map((data?.external ?? []).map((e) => [e.session_id, e] as const));
  const titleBy = new Map(sessions.map((s) => [s.id, s.title] as const));

  const rows: Row[] = Object.entries(data?.status ?? {})
    .filter(([, st]) => st.state !== "idle")
    .map(([id, st]) => {
      // A bridge session with no live job exists briefly after a restart, before
      // recovery resumes it — fall back to the open project's session list.
      const job = jobBy.get(id);
      const ext = extBy.get(id);
      return {
        sessionId: id,
        title: job?.title || titleBy.get(id) || ext?.project || "New chat",
        label: st.label || st.state,
        state: st.state,
        source: st.source,
        project: job?.project ?? ext?.project ?? null,
        started: job?.started ?? ext?.started ?? null,
        extSource: ext?.source ?? null,
      };
    })
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.started ?? 0) - (a.started ?? 0));

  if (rows.length === 0) return null;
  const waiting = rows.filter((r) => r.state === "awaiting").length;

  function openRow(row: Row) {
    if (row.sessionId === sessionId) return;
    if (row.project && row.project !== project)
      void openSessionInProject(row.project, row.sessionId);
    else selectSession(row.sessionId);
  }

  return (
    <div className="sticky top-0 z-[5] -mx-4 -mt-4 bg-[var(--tg-bg)] px-4 pb-2 pt-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--tg-secondary-bg)] p-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-1.5 px-1 text-[11px] font-medium text-[var(--tg-hint)] active:opacity-70"
        >
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          <span>
            {rows.length} active
            {waiting > 0 && <span className="text-amber-400"> · {waiting} waiting</span>}
          </span>
          <span className="flex-1" />
          {expanded ? (
            <ChevronUp size={13} aria-hidden />
          ) : (
            <ChevronDown size={13} aria-hidden />
          )}
        </button>

        {expanded && (
          <div className="mt-1.5 space-y-1">
            {rows.map((r) => {
              const right =
                r.state === "awaiting" ? (
                  <span className="shrink-0 text-[10px] text-amber-400">waiting</span>
                ) : (
                  <span className="shrink-0 text-[10px] text-[var(--tg-hint)]">
                    {ago(r.started)}
                  </span>
                );
              if (r.source === "native")
                return (
                  <div key={r.sessionId} className={rowClass} title={r.project ?? undefined}>
                    <SourceIcon source={r.extSource} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{r.title}</div>
                      <div className="truncate text-[10px] text-[var(--tg-hint)]">{r.label}</div>
                    </div>
                    {r.extSource && (
                      <span className="shrink-0 rounded bg-[var(--tg-secondary-bg)] px-1.5 py-0.5 text-[10px] text-[var(--tg-hint)]">
                        {r.extSource}
                      </span>
                    )}
                    {right}
                  </div>
                );
              return (
                <button
                  key={r.sessionId}
                  onClick={() => openRow(r)}
                  className={`${rowClass} active:opacity-70 ${
                    r.sessionId === sessionId ? "ring-1 ring-[var(--brand-soft)]" : ""
                  }`}
                >
                  <Bot size={13} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{r.title}</div>
                    <div className="truncate text-[10px] text-[var(--tg-hint)]">{r.label}</div>
                  </div>
                  {right}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
