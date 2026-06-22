import { useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { rootRoute } from "./root";
import { api, ApiError } from "../lib/api";
import type { RunEvent } from "../lib/api";
import { Button, Card, Banner } from "../components/ui";
import { FolderNavigator } from "../components/FolderNavigator";
import { RunStream } from "../components/RunStream";

interface Attachment {
  id: string;
  name: string;
  dataUrl: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function FinalResult({
  result,
  elapsed,
  cost,
}: {
  result: string;
  elapsed?: number;
  cost?: number;
}) {
  return (
    <Card className="space-y-2 border border-[var(--tg-button)]/30">
      <div className="whitespace-pre-wrap text-sm leading-relaxed">
        {result}
      </div>
      {(elapsed !== undefined || cost !== undefined) && (
        <div className="text-xs text-[var(--tg-hint)]">
          {elapsed !== undefined ? `${elapsed.toFixed(1)}s` : ""}
          {elapsed !== undefined && cost !== undefined ? " · " : ""}
          {cost !== undefined ? `$${cost.toFixed(4)}` : ""}
        </div>
      )}
    </Card>
  );
}

function RunPage() {
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const state = useQuery({ queryKey: ["state"], queryFn: () => api.getState() });

  // Poll the running job; append events and advance the cursor each tick.
  const job = useQuery({
    queryKey: ["run", jobId, cursor],
    queryFn: async () => {
      const res = await api.runStatus(jobId as string, cursor);
      if (res.events.length > 0) {
        setEvents((prev) => [...prev, ...res.events]);
      }
      if (res.next_cursor !== cursor) setCursor(res.next_cursor);
      return res;
    },
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1500 : false,
  });

  const isRunning = jobId !== null && job.data?.status === "running";

  const runMutation = useMutation({
    mutationFn: () =>
      api.run(
        prompt,
        attachments.map((a) => a.dataUrl),
        state.data?.project?.rel,
      ),
    onSuccess: (res) => {
      setEvents([]);
      setCursor(0);
      setJobId(res.job_id);
    },
  });

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    const added: Attachment[] = [];
    for (const file of Array.from(files)) {
      const dataUrl = await readAsDataUrl(file);
      added.push({
        id: `${file.name}-${crypto.randomUUID()}`,
        name: file.name,
        dataUrl,
      });
    }
    setAttachments((prev) => [...prev, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  const runError = runMutation.error;
  const busyConflict = runError instanceof ApiError && runError.busy;
  const unauthorized = runError instanceof ApiError && runError.unauthorized;
  const sendDisabled =
    runMutation.isPending || isRunning || prompt.trim().length === 0;

  return (
    <div className="space-y-4">
      <FolderNavigator />

      <div className="space-y-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask Claude to do something…"
          rows={4}
          className="w-full resize-y rounded-xl bg-[var(--tg-secondary-bg)] p-3 text-sm outline-none placeholder:text-[var(--tg-hint)]"
        />

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div key={a.id} className="relative">
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className="h-16 w-16 rounded-lg object-cover"
                />
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs text-white"
                  aria-label={`Remove ${a.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach images"
          >
            📎
          </Button>
          <Button
            className="flex-1"
            disabled={sendDisabled}
            onClick={() => runMutation.mutate()}
          >
            {runMutation.isPending || isRunning ? "Running…" : "Send"}
          </Button>
        </div>

        {busyConflict && (
          <Banner tone="error">Claude is busy with another task.</Banner>
        )}
        {unauthorized && <Banner tone="error">Unauthorized</Banner>}
        {runError && !busyConflict && !unauthorized && (
          <Banner tone="error">Failed to start run.</Banner>
        )}
      </div>

      {(events.length > 0 || job.data) && (
        <Card className="space-y-3">
          <RunStream events={events} />
          {job.data?.status === "running" && (
            <div className="text-xs text-[var(--tg-hint)]">Working…</div>
          )}
          {job.data?.status === "done" && job.data.result !== undefined && (
            <FinalResult
              result={job.data.result}
              elapsed={job.data.elapsed}
              cost={job.data.cost}
            />
          )}
          {job.data?.status === "error" && (
            <Banner tone="error">Run failed.</Banner>
          )}
        </Card>
      )}
    </div>
  );
}

export const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RunPage,
});
