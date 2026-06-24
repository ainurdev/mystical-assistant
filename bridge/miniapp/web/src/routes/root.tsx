import { useState } from "react";
import {
  createRootRoute,
  Outlet,
  Link,
  useRouterState,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Sparkles,
  ChevronUp,
  ChevronDown,
  SquarePen,
  MessagesSquare,
  TerminalSquare,
  SquareChevronRight,
  MonitorPlay,
  History,
  CircleDot,
} from "lucide-react";
import { api } from "../lib/api";
import { ChatProvider, useChat } from "../lib/chat";
import { FolderNavigator } from "../components/FolderNavigator";

const tabs = [
  { to: "/", label: "Run", icon: MessagesSquare },
  { to: "/issues", label: "Issues", icon: CircleDot },
  { to: "/history", label: "History", icon: History },
  { to: "/server", label: "Server", icon: TerminalSquare },
  { to: "/shell", label: "Shell", icon: SquareChevronRight },
  { to: "/preview", label: "Preview", icon: MonitorPlay },
] as const;

function HeaderBar({
  pickerOpen,
  onTogglePicker,
}: {
  pickerOpen: boolean;
  onTogglePicker: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 5000,
  });
  const project = state.data?.project;
  const running = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  const status = running.data?.status ?? {};
  const { newChat, isRunning, sessions, sessionId, selectSession } = useChat();

  return (
    <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--tg-bg)] px-3 pb-2 pt-2">
      <div className="flex items-center gap-2">
        <button
          onClick={onTogglePicker}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left active:opacity-70"
        >
          <Sparkles
            size={16}
            className="shrink-0 text-[var(--brand-soft)]"
            aria-hidden
          />
          <span className="truncate text-sm font-semibold">
            {project ? project.name : "No project"}
          </span>
          {state.data?.busy && (
            <span className="rounded-full bg-[var(--tg-button)] px-2 py-0.5 text-[10px] text-[var(--tg-button-text)]">
              busy
            </span>
          )}
          {pickerOpen ? (
            <ChevronUp size={14} className="text-[var(--tg-hint)]" aria-hidden />
          ) : (
            <ChevronDown
              size={14}
              className="text-[var(--tg-hint)]"
              aria-hidden
            />
          )}
        </button>
        {pathname === "/" && (
          <div className="flex shrink-0 items-center gap-1.5">
            {sessions.length > 0 && (
              <select
                value={sessionId ?? ""}
                onChange={(e) => selectSession(e.target.value)}
                disabled={isRunning}
                className="max-w-[38vw] truncate rounded-lg bg-[var(--tg-secondary-bg)] px-2 py-1.5 text-xs outline-none disabled:opacity-40"
                aria-label="Chat session"
              >
                {sessions.map((s) => {
                  const st = status[s.id]?.state;
                  return (
                    <option key={s.id} value={s.id}>
                      {(st === "awaiting" ? "❓ " : st === "working" ? "● " : "") +
                        (s.title || "New chat")}
                    </option>
                  );
                })}
              </select>
            )}
            <button
              onClick={() => void newChat()}
              disabled={isRunning}
              className="flex items-center gap-1 rounded-lg bg-[var(--tg-secondary-bg)] px-3 py-1.5 text-xs disabled:opacity-40"
            >
              <SquarePen size={14} aria-hidden />
              New
            </button>
          </div>
        )}
      </div>

      <nav className="mt-2 flex gap-1 rounded-xl bg-[var(--tg-secondary-bg)] p-1">
        {tabs.map((tab) => {
          const active = pathname === tab.to;
          const Icon = tab.icon;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-center text-sm font-medium active:opacity-70 ${
                active
                  ? "bg-[var(--tg-button)] text-[var(--tg-button-text)] shadow-[0_0_16px_var(--brand-glow)]"
                  : "text-[var(--tg-hint)]"
              }`}
            >
              <Icon size={14} aria-hidden />
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function Layout() {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <ChatProvider>
      <div className="crt" />
      <div className="mx-auto flex h-full max-w-screen-sm flex-col">
        <HeaderBar
          pickerOpen={pickerOpen}
          onTogglePicker={() => setPickerOpen((v) => !v)}
        />
        {pickerOpen && (
          <div className="border-b border-white/5 bg-[var(--tg-bg)] px-3 py-2">
            <FolderNavigator onSelected={() => setPickerOpen(false)} />
          </div>
        )}
        <main className="flex-1 overflow-y-auto px-4 py-4">
          <Outlet />
        </main>
      </div>
    </ChatProvider>
  );
}

export const rootRoute = createRootRoute({ component: Layout });
