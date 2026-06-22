import { useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rootRoute } from "./root";
import { api, ApiError } from "../lib/api";
import { usePersistentState } from "../lib/persistentState";
import { Button, Card, Banner } from "../components/ui";

function PreviewPage() {
  const queryClient = useQueryClient();
  const [port, setPort] = usePersistentState("miniapp:preview-port:v1", 3000);
  const [copied, setCopied] = useState(false);

  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 5000,
  });

  const action = useMutation({
    mutationFn: (vars: { action: "start" | "stop" }) =>
      api.preview(vars.action, vars.action === "start" ? port : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  // Prefer the freshest preview info: mutation response, then state.
  const preview = action.data?.preview ?? state.data?.preview ?? null;
  const url = preview?.url ?? null;
  const message = action.data?.message;
  const unauthorized =
    (state.error instanceof ApiError && state.error.unauthorized) ||
    (action.error instanceof ApiError && action.error.unauthorized);

  async function copyUrl() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; silently ignore.
    }
  }

  return (
    <div className="space-y-4">
      {unauthorized && <Banner tone="error">Unauthorized</Banner>}

      <Card className="space-y-3">
        <label className="block text-xs text-[var(--tg-hint)]">Port</label>
        <input
          type="number"
          value={port}
          onChange={(e) => setPort(Number(e.target.value))}
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

      {url && (
        <Card className="space-y-2">
          <div className="truncate font-mono text-sm text-[var(--tg-link)]">
            {url}
          </div>
          <div className="flex gap-2">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex-1 rounded-lg bg-[var(--tg-button)] px-4 py-2.5 text-center text-sm font-medium text-[var(--tg-button-text)] active:opacity-70"
            >
              Open
            </a>
            <Button variant="secondary" className="flex-1" onClick={copyUrl}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
        </Card>
      )}

      {message && <Banner tone="info">{message}</Banner>}
    </div>
  );
}

export const previewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/preview",
  component: PreviewPage,
});
