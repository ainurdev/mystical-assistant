import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Sparkles, SquarePen, X } from "lucide-react";
import { api, needsYou, type SessionState } from "../lib/api";
import { useChat } from "../lib/chat";
import { FolderNavigator } from "./FolderNavigator";
import { SurfaceBadge } from "./SurfaceBadge";

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

// The states you can act on sort first — blocked mid-turn, then ended on a
// question — and only then what is running.
const ORDER: Record<SessionState, number> = {
  awaiting: 0, asking: 1, working: 2, checking: 3, live: 4, idle: 5,
};
const DOT: Record<SessionState, string> = {
  awaiting: "bg-amber-400", asking: "bg-amber-400/60", working: "bg-emerald-400",
  checking: "bg-emerald-400/60", live: "bg-sky-400", idle: "bg-[var(--tg-hint)]/40",
};

interface Row {
  id: string;
  title: string;
  label: string | null;
  state: SessionState;
  project: string | null; // set only for chats living in another project
  origin: string | null;
  when: number | null;
}

function Dot({ state }: { state: SessionState }) {
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0">
      {state === "working" || state === "awaiting" ? (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${DOT[state]}`} />
      ) : null}
      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${DOT[state]}`} />
    </span>
  );
}

/** The whole header identity control: which project, which chat, and every chat
 *  you could switch to — one button, one sheet.
 *
 *  The sheet groups by what you can do about a chat: the ones waiting on an
 *  answer first (they are the only ones blocked on you), then what is running,
 *  then everything else. */
export function ChatSwitcher() {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState(false);
  const { sessions, sessionId, selectSession, openSessionInProject, newChat } = useChat();
  // Both queries share the header's caches — no extra polling.
  const { data } = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  const { data: state } = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 5000,
  });
  const project = state?.project?.rel ?? null;
  const projectName = state?.project?.name ?? null;
  const status = data?.status ?? {};

  const rows: Row[] = sessions.map((s) => ({
    id: s.id,
    title: s.title || "New chat",
    label: status[s.id]?.label ?? null,
    state: status[s.id]?.state ?? "idle",
    project: null,
    origin: s.origin ?? null,
    when: s.updated,
  }));
  // Live chats in other projects: the status map is machine-wide, the session
  // list isn't. Jobs carry the detail (title, project, start) that makes them
  // readable. Native (VS Code/terminal) sessions stay out — you can't switch to
  // one, so it would be noise in a switcher.
  const jobBy = new Map(
    (data?.jobs ?? []).flatMap((j) => (j.session_id ? [[j.session_id, j] as const] : [])),
  );
  for (const [id, st] of Object.entries(status)) {
    if (st.source !== "bridge" || st.state === "idle") continue;
    if (rows.some((r) => r.id === id)) continue;
    const job = jobBy.get(id);
    rows.push({
      id,
      title: job?.title || "New chat",
      label: st.label || st.state,
      state: st.state,
      project: job?.project ?? null,
      origin: null,
      when: job?.started ?? null,
    });
  }
  rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.when ?? 0) - (a.when ?? 0));

  const current = rows.find((r) => r.id === sessionId);
  // The checkout this chat runs in — a worktree session is not on the repo's
  // current branch, and that difference is worth a word in the header.
  const branch = sessions.find((s) => s.id === sessionId)?.branch ?? "";
  const waiting = rows.filter((r) => needsYou(r.state));
  const running = rows.filter((r) => r.state === "working" || r.state === "checking" || r.state === "live");
  const recent = rows.filter((r) => r.state === "idle");

  function openRow(row: Row) {
    setOpen(false);
    if (row.id === sessionId) return;
    if (row.project && row.project !== project)
      void openSessionInProject(row.project, row.id);
    else selectSession(row.id);
  }

  function Section({ label, tone, rows: list }: { label: string; tone?: "warn"; rows: Row[] }) {
    if (!list.length) return null;
    return (
      <>
        <div
          className={`px-0.5 pb-0.5 pt-2 text-[9.5px] tracking-[2px] ${
            tone === "warn" ? "text-amber-400" : "text-[var(--tg-hint)]"
          }`}
        >
          {label}
        </div>
        {list.map((r) => {
          const isWaiting = needsYou(r.state);
          const isLive = r.state !== "idle" && !isWaiting;
          return (
            <button
              key={r.id}
              onClick={() => openRow(r)}
              className={`flex w-full items-center gap-2.5 border px-3 py-2.5 text-left active:opacity-70 ${
                isWaiting
                  ? "panel border-amber-400/45 bg-[var(--card)]"
                  : isLive
                    ? "border-border-bright bg-[var(--ac-06)]"
                    : "border-border bg-[var(--tg-secondary-bg)]"
              } ${r.id === sessionId ? "ring-1 ring-[var(--brand-soft)]" : ""}`}
            >
              <Dot state={r.state} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{r.title}</div>
                <div className="truncate text-[11px] text-[var(--tg-hint)]">
                  {r.label ?? ago(r.when)}
                  {r.project && r.project !== project ? ` · ${r.project}` : ""}
                </div>
              </div>
              <SurfaceBadge origin={r.origin} />
              {isWaiting && (
                <span className="shrink-0 border border-amber-400/50 px-2 py-1 text-[9px] tracking-[1.5px] text-amber-400">
                  ANSWER →
                </span>
              )}
              {isLive && !isWaiting && (
                <span className="shrink-0 text-[9px] tracking-wider text-[var(--brand-soft)]">
                  OPEN
                </span>
              )}
            </button>
          );
        })}
      </>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Project and chats"
        className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left active:opacity-70"
      >
        <Dot state={current?.state ?? "idle"} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-semibold text-foreground-bright">
            {current?.title ?? "New chat"}
          </span>
          <span className="truncate text-[10px] tracking-wider text-[var(--tg-hint)]">
            {(projectName ?? "NO PROJECT").toUpperCase()}
            {branch ? ` · ${branch.toUpperCase()}` : ""}
            {running.length > 0 ? ` · ${running.length} LIVE` : ""}
            {waiting.length > 0 ? ` · ${waiting.length} WAITING` : ""}
          </span>
        </span>
        <ChevronDown size={13} className="shrink-0 text-[var(--tg-hint)]" aria-hidden />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[var(--tg-bg)]">
          {/* The project lives here too — switching repo and switching chat are
              the same decision, so they share one sheet instead of two rows. */}
          <div className="flex items-center gap-2 border-b border-border p-3">
            <button
              onClick={() => setFolders((v) => !v)}
              aria-expanded={folders}
              className="flex min-w-0 flex-1 items-center gap-2 text-left active:opacity-70"
            >
              <Sparkles size={14} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold">
                  {projectName ?? "No project"}
                </span>
                <span className="truncate text-[10px] tracking-wider text-[var(--tg-hint)]">
                  {project ?? "~"} · CHANGE
                </span>
              </span>
              {folders ? (
                <ChevronUp size={13} className="shrink-0 text-[var(--tg-hint)]" aria-hidden />
              ) : (
                <ChevronDown size={13} className="shrink-0 text-[var(--tg-hint)]" aria-hidden />
              )}
            </button>
            <button onClick={() => setOpen(false)} aria-label="Close">
              <X size={18} />
            </button>
          </div>
          {folders && (
            <div className="border-b border-border px-3 py-2">
              <FolderNavigator
                onSelected={() => {
                  setFolders(false);
                  setOpen(false);
                }}
              />
            </div>
          )}
          <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
            <Section label={`NEEDS YOU · ${waiting.length}`} tone="warn" rows={waiting} />
            <Section label={`RUNNING · ${running.length}`} rows={running} />
            <Section label="RECENT" rows={recent} />
          </div>
          <button
            onClick={() => {
              setOpen(false);
              void newChat();
            }}
            className="m-3 flex items-center justify-center gap-2 border border-border-bright py-3 text-[11px] tracking-[2px] text-[var(--brand-soft)] active:opacity-70"
          >
            <SquarePen size={14} aria-hidden />
            NEW CHAT
          </button>
        </div>
      )}
    </>
  );
}
