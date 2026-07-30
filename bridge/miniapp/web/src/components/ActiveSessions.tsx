import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import { api, type SessionState } from "../lib/api";
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

// Awaiting you sorts first — it's the only state you can act on — then working.
const ORDER: Record<SessionState, number> = { awaiting: 0, working: 1, live: 2, idle: 3 };

interface Row {
  sessionId: string;
  title: string;
  label: string;
  state: SessionState;
  project: string | null;
  started: number | null;
}

const rowClass =
  "flex w-full items-center gap-2 rounded-lg bg-[var(--tg-bg)] px-2 py-1.5 text-left text-xs";

/** Your live chats, from the backend's unified status map: every bridge session
 *  that is working or awaiting you, in any project — not just the open one. Tap
 *  one to switch to it. VS Code/terminal sessions are deliberately left out;
 *  you can't switch to those, so they'd be noise in a switcher.
 *
 *  Lives under the header (see routes/root.tsx), not in the transcript, so it
 *  stays put while the chat scrolls. Collapsed by default. */
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

  // The status map has the state; jobs carry the detail (title, project, start
  // time) that makes a row readable.
  const jobBy = new Map(
    (data?.jobs ?? []).flatMap((j) => (j.session_id ? [[j.session_id, j] as const] : [])),
  );
  const titleBy = new Map(sessions.map((s) => [s.id, s.title] as const));

  const rows: Row[] = Object.entries(data?.status ?? {})
    .filter(([, st]) => st.source === "bridge" && st.state !== "idle")
    .map(([id, st]) => {
      // A bridge session with no live job exists briefly after a restart, before
      // recovery resumes it — fall back to the open project's session list.
      const job = jobBy.get(id);
      return {
        sessionId: id,
        title: job?.title || titleBy.get(id) || "New chat",
        label: st.label || st.state,
        state: st.state,
        project: job?.project ?? null,
        started: job?.started ?? null,
      };
    })
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.started ?? 0) - (a.started ?? 0));

  if (rows.length === 0) return null;
  const waiting = rows.filter((r) => r.state === "awaiting").length;

  function openRow(row: Row) {
    setExpanded(false);                     // you picked — get out of the way
    if (row.sessionId === sessionId) return;
    if (row.project && row.project !== project)
      void openSessionInProject(row.project, row.sessionId);
    else selectSession(row.sessionId);
  }

  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--tg-bg)] px-3 py-2">
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
          <div className="mt-1.5 max-h-[45vh] space-y-1 overflow-y-auto">
            {rows.map((r) => (
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
                {r.state === "awaiting" ? (
                  <span className="shrink-0 text-[10px] text-amber-400">waiting</span>
                ) : (
                  <span className="shrink-0 text-[10px] text-[var(--tg-hint)]">
                    {ago(r.started)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
