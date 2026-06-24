import { useEffect, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rootRoute } from "./root";
import { api, ApiError } from "../lib/api";
import { Button, Card, Banner, StatusDot } from "../components/ui";

function ServerPage() {
  const queryClient = useQueryClient();
  const logRef = useRef<HTMLPreElement>(null);

  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 3000,
  });
  const project = state.data?.project?.rel ?? null;

  // Per-project run settings (package.json scripts + saved command). Keyed by
  // project so switching repos reloads; no polling, so it won't clobber edits.
  const settings = useQuery({
    queryKey: ["project-settings", project],
    queryFn: () => api.getProjectSettings(),
    enabled: project !== null,
  });

  const [cmd, setCmd] = useState("");
  useEffect(() => {
    if (settings.data) setCmd(settings.data.run_cmd ?? settings.data.default_cmd);
  }, [settings.data]);

  const logs = useQuery({
    queryKey: ["logs"],
    queryFn: () => api.logs(200),
    refetchInterval: 2000,
  });

  const save = useMutation({
    mutationFn: (c: string) => api.setProjectSettings(c),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["project-settings", project] }),
  });

  const action = useMutation({
    mutationFn: (vars: { action: "start" | "stop" }) =>
      api.server(vars.action, vars.action === "start" ? cmd : undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  function start() {
    save.mutate(cmd); // persist this project's run command
    action.mutate({ action: "start" });
  }

  // Auto-scroll the log pane to the bottom when new lines arrive.
  const lines = logs.data?.lines ?? [];
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const server = state.data?.server;
  const scripts = settings.data?.scripts ?? {};
  const scriptNames = Object.keys(scripts);
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

        {scriptNames.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] text-[var(--tg-hint)]">
              package.json scripts
            </div>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) setCmd(`npm run ${e.target.value}`);
              }}
              className="w-full rounded-lg bg-[var(--tg-bg)] px-3 py-2 text-sm outline-none"
            >
              <option value="">Choose a script…</option>
              {scriptNames.map((n) => (
                <option key={n} value={n}>
                  {n} — {scripts[n]}
                </option>
              ))}
            </select>
          </div>
        )}

        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder={settings.data?.default_cmd ?? "npm run dev"}
          className="w-full rounded-lg bg-[var(--tg-bg)] px-3 py-2 font-mono text-sm outline-none"
        />

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={action.isPending}
            onClick={start}
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

        <div className="text-[11px] text-[var(--tg-hint)]">
          Saved per project. Logs also written to{" "}
          <span className="font-mono">{settings.data?.log_path ?? ".mystical/dev.log"}</span>{" "}
          so the Claude session can read them.
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
