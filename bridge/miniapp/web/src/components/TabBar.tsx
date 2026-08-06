import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, MessagesSquare, Zap, GitBranch, Settings } from "lucide-react";
import { api } from "../lib/api";

/* The five places this app goes, one tap apart. CHAT is the conversation, CHATS
   every session on the machine, WORK everything you could feed Claude next,
   REPO the files, SYSTEM the knobs. Badges carry the only two numbers worth
   interrupting you for: chats waiting on an answer, prompts still queued. */

const TABS = [
  { to: "/", label: "CHAT", icon: MessageSquare },
  { to: "/chats", label: "CHATS", icon: MessagesSquare },
  { to: "/work", label: "WORK", icon: Zap },
  { to: "/repo", label: "REPO", icon: GitBranch },
  { to: "/system", label: "SYSTEM", icon: Settings },
] as const;

export function TabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: running } = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  const { data: queues } = useQuery({
    queryKey: ["queues"],
    queryFn: () => api.getQueues(),
    refetchInterval: 5000,
  });

  const waiting = Object.values(running?.status ?? {}).filter(
    (s) => s.state === "awaiting",
  ).length;
  const queued = (queues?.queues ?? []).reduce(
    (n, q) => n + q.items.filter((i) => i.status === "queued").length,
    0,
  );

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 mx-auto flex max-w-screen-sm border-t border-border bg-[var(--tg-bg)]/97 px-2 pt-1.5"
      style={{ height: "var(--tabbar-h)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {TABS.map((t) => {
        const on = pathname === t.to;
        const Icon = t.icon;
        const badge = t.to === "/chats" ? waiting : t.to === "/work" ? queued : 0;
        return (
          <Link
            key={t.to}
            to={t.to}
            aria-label={t.label}
            aria-current={on ? "page" : undefined}
            className={`relative flex flex-1 flex-col items-center gap-[3px] pt-0.5 active:opacity-70 ${
              on ? "text-[var(--brand-soft)]" : "text-[var(--tg-hint)]"
            }`}
          >
            {on && (
              <span className="absolute -top-1.5 h-0.5 w-6 bg-[var(--brand-soft)] shadow-[0_0_8px_var(--brand-glow)]" />
            )}
            {badge > 0 && (
              <span
                className={`absolute right-1/2 top-0.5 -mr-[22px] flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold text-[var(--tg-bg)] ${
                  t.to === "/chats" ? "bg-amber-400" : "bg-[var(--brand-soft)]"
                }`}
              >
                {badge}
              </span>
            )}
            <Icon size={19} aria-hidden />
            <span className={`text-[9px] tracking-[1.5px] ${on ? "glow" : ""}`}>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
