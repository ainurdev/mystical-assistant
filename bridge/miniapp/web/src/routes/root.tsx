import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { SquarePen } from "lucide-react";
import { ChatProvider, useChat } from "../lib/chat";
import { ChatSwitcher } from "../components/ChatSwitcher";
import { CheckpointsButton } from "../components/CheckpointsSheet";
import { SpendButton } from "../components/SpendSheet";
import { TabBar } from "../components/TabBar";

/** The chat's own header: who you're talking to (ChatSwitcher), the marks in
 *  this conversation (checkpoints), and a fresh start. The other tabs title
 *  themselves — a shared bar would just repeat what the tab already says.
 *
 *  It floats over the chat's scroller rather than sitting above it, so the
 *  HEADER pick (SYSTEM, index.css · THE CHAT HEADER) can be glass the transcript
 *  blurs through, a fade, or a tucked island. `.chead-fold` is what TUCK folds
 *  away; `.chead-aux` is what FROST and VEIL dim until you touch the bar. */
function ChatHeader() {
  const { newChat, isRunning, sessionId } = useChat();
  return (
    // z-30 beats the fixed composer's z-10: the chat sheet renders inside this
    // header, so its own z-50 is scoped to whatever this row wins.
    <header className="chead px-3 py-1.5">
      <div className="flex items-center gap-1">
        <ChatSwitcher />
        <span className="chead-fold chead-aux flex shrink-0 items-center gap-1">
          <CheckpointsButton />
          <SpendButton sessionId={sessionId} running={isRunning} />
        </span>
        <button
          onClick={() => void newChat()}
          disabled={isRunning}
          aria-label="New chat"
          className="chead-aux shrink-0 p-2 text-[var(--tg-hint)] active:opacity-70 disabled:opacity-40"
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
      <div className="relative mx-auto flex h-full max-w-screen-sm flex-col">
        {pathname === "/" && <ChatHeader />}
        <main
          className="flex-1 overflow-y-auto px-3 py-3"
          style={{
            paddingBottom: "calc(var(--tabbar-h) + 0.75rem)",
            ...(pathname === "/" ? { paddingTop: "calc(var(--chead-h) + 0.75rem)" } : {}),
          }}
        >
          <Outlet />
        </main>
        <TabBar />
      </div>
    </ChatProvider>
  );
}

export const rootRoute = createRootRoute({ component: Layout });
