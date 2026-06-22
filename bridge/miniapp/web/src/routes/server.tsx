import { useEffect, useRef } from "react";
import { createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rootRoute } from "./root";
import { api, ApiError } from "../lib/api";
import { usePersistentState } from "../lib/persistentState";
import { Button, Card, Banner, StatusDot } from "../components/ui";

function ServerPage() {
  const queryClient = useQueryClient();
  const [cmd, setCmd] = usePersistentState("miniapp:server-cmd:v1", "npm run dev");
  const logRef = useRef<HTMLPreElement>(null);

  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 3000,
  });

  const logs = useQuery({
    queryKey: ["logs"],
    queryFn: () => api.logs(200),
    refetchInterval: 2000,
  });

  const action = useMutation({
    mutationFn: (vars: { action: "start" | "stop" }) =>
      api.server(vars.action, vars.action === "start" ? cmd : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  // Auto-scroll the log pane to the bottom when new lines arrive.
  const lines = logs.data?.lines ?? [];
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const server = state.data?.server;
  const unauthorized =
    (state.error instanceof ApiError && state.error.unauthorized) ||
    (action.error instanceof ApiError && action.error.unauthorized);

  return (
    <div className="space-y-4">
      {unauthorized && <Banner tone="error">Unauthorized</Banner>}

      <Card className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot status={server?.status ?? "not started"} />
          <span className="font-medium capitalize">
            {server?.status ?? "not started"}
          </span>
          {server?.pid != null && (
            <span className="text-[var(--tg-hint)]">pid {server.pid}</span>
          )}
        </div>
        {server?.cmd && (
          <div className="truncate font-mono text-xs text-[var(--tg-hint)]">
            {server.cmd}
          </div>
        )}

        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="npm run dev"
          className="w-full rounded-lg bg-[var(--tg-bg)] px-3 py-2 font-mono text-sm outline-none"
        />

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={action.isPending}
            onClick={() => action.mutate({ action: "start" })}
          >
            Start
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={action.isPending}
            onClick={() => action.mutate({ action: "stop" })}
          >
            Stop
          </Button>
        </div>
      </Card>

      <div>
        <div className="mb-1 text-xs text-[var(--tg-hint)]">Logs</div>
        <pre
          ref={logRef}
          className="h-72 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
        >
          {lines.length > 0 ? lines.join("\n") : "No logs yet."}
        </pre>
      </div>
    </div>
  );
}

export const serverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/server",
  component: ServerPage,
});
