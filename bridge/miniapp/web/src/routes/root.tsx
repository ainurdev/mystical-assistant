import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { SquarePen } from "lucide-react";
import { ChatProvider, useChat } from "../lib/chat";
import { ChatSwitcher } from "../components/ChatSwitcher";
import { CheckpointsButton } from "../components/CheckpointsSheet";
import { SpendButton } from "../components/SpendSheet";
import { TabBar } from "../components/TabBar";

/** The chat's own header: who you're talking to (ChatSwitcher), the marks in
 *  this conversation (checkpoints), and a fresh start. The other tabs title
 *  themselves — a shared bar would just repeat what the tab already says. */
function ChatHeader() {
  const { newChat, isRunning, sessionId } = useChat();
  return (
    // z-30 beats the fixed composer's z-10: the chat sheet renders inside this
    // header, so its own z-50 is scoped to whatever this row wins.
    <header className="sticky top-0 z-30 border-b border-border bg-[var(--tg-bg)] px-3 py-1.5">
      <div className="flex items-center gap-1">
        <ChatSwitcher />
        <CheckpointsButton />
        <SpendButton sessionId={sessionId} running={isRunning} />
        <button
          onClick={() => void newChat()}
          disabled={isRunning}
          aria-label="New chat"
          className="shrink-0 p-2 text-[var(--tg-hint)] active:opacity-70 disabled:opacity-40"
        >
          <SquarePen size={16} aria-hidden />
        </button>
      </div>
    </header>
  );
}

function Layout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <ChatProvider>
      <div className="crt" />
      <div className="mx-auto flex h-full max-w-screen-sm flex-col">
        {pathname === "/" && <ChatHeader />}
        <main
          className="flex-1 overflow-y-auto px-3 py-3"
          style={{ paddingBottom: "calc(var(--tabbar-h) + 0.75rem)" }}
        >
          <Outlet />
        </main>
        <TabBar />
      </div>
    </ChatProvider>
  );
}

export const rootRoute = createRootRoute({ component: Layout });
