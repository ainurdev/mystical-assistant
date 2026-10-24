import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { api, needsYou, type SessionState } from "../lib/api";
import { useChat } from "../lib/chat";

const DOT: Record<SessionState, string> = {
  awaiting: "bg-amber-400", asking: "bg-amber-400/60", working: "bg-emerald-400",
  checking: "bg-emerald-400/60", waiting: "bg-fuchsia-300/70", parked: "bg-sky-400/60", live: "bg-sky-400",
  idle: "bg-[var(--tg-hint)]/40",
};

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

/** The header's identity control: which project, which chat, its branch, and
 *  how many chats are live or waiting machine-wide. A tap opens CHATS — the
 *  dashboard's sidebar as a screen (routes/chats) — and back comes here. */
export function ChatSwitcher() {
  const navigate = useNavigate();
  const { sessions, sessionId } = useChat();
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
  const projectName = state?.project?.name ?? null;
  const status = data?.status ?? {};

  const current = sessions.find((s) => s.id === sessionId);
  const curState: SessionState = (sessionId && status[sessionId]?.state) || "idle";
  // The checkout this chat runs in — a worktree session is not on the repo's
  // current branch, and that difference is worth a word in the header.
  const branch = current?.branch ?? "";
  // Two worktrees can sit on one branch, so the branch alone doesn't say which
  // tree this chat is committing into. The name only shows for a linked one —
  // and only when it differs from the branch, or it just repeats it.
  const worktree = current?.worktree && current.worktree !== branch ? current.worktree : "";
  const waitingN = Object.values(status).filter((st) => needsYou(st.state)).length;
  const liveN = Object.values(status).filter((st) => st.state === "working" || st.state === "checking").length;

  return (
    <>
      <button
        onClick={() => void navigate({ to: "/chats" })}
        aria-label="Project and chats"
        className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left active:opacity-70"
      >
        <Dot state={curState} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="chead-title truncate text-[13px] font-semibold text-foreground-bright">
            {current?.title || "New chat"}
          </span>
          <span className="truncate text-[10px] tracking-wider text-[var(--tg-hint)]">
            {(projectName ?? "NO PROJECT").toUpperCase()}
            {branch ? ` · ${branch.toUpperCase()}` : ""}
            {worktree ? ` ⧉${worktree.toUpperCase()}` : ""}
            {liveN > 0 ? ` · ${liveN} LIVE` : ""}
            {waitingN > 0 ? ` · ${waitingN} WAITING` : ""}
          </span>
        </span>
        <ChevronDown size={13} className="shrink-0 text-[var(--tg-hint)]" aria-hidden />
      </button>

    </>
  );
}
