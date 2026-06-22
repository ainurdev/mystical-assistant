import {
  createRootRoute,
  Outlet,
  Link,
  useRouterState,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

const tabs = [
  { to: "/", label: "Run", icon: "▶️" },
  { to: "/server", label: "Server", icon: "🖥️" },
  { to: "/preview", label: "Preview", icon: "🌐" },
] as const;

function ProjectChip() {
  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 5000,
  });
  const project = state.data?.project;
  return (
    <div className="flex items-center gap-2 truncate">
      <span className="text-base" aria-hidden>
        ⚡
      </span>
      <span className="truncate text-sm font-semibold">
        {project ? project.name : "No project"}
      </span>
      {state.data?.busy && (
        <span className="rounded-full bg-[var(--tg-button)] px-2 py-0.5 text-[10px] text-[var(--tg-button-text)]">
          busy
        </span>
      )}
    </div>
  );
}

function Layout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="mx-auto flex h-full max-w-screen-sm flex-col">
      <header className="sticky top-0 z-10 border-b border-white/5 bg-[var(--tg-bg)] px-4 py-3">
        <ProjectChip />
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4 pb-24">
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 mx-auto flex max-w-screen-sm border-t border-white/5 bg-[var(--tg-bg)]">
        {tabs.map((tab) => {
          const active = pathname === tab.to;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`flex flex-1 flex-col items-center gap-0.5 py-3 text-xs ${
                active ? "text-[var(--tg-button)]" : "text-[var(--tg-hint)]"
              }`}
            >
              <span className="text-lg" aria-hidden>
                {tab.icon}
              </span>
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export const rootRoute = createRootRoute({ component: Layout });
