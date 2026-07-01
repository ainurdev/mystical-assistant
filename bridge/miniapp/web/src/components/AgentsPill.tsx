import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { api } from "../lib/api";
import { AgentsModal } from "./AgentsModal";

export function AgentsPill({
  sessionId,
  running,
}: {
  sessionId: string | null;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["agents", sessionId],
    enabled: sessionId !== null,
    queryFn: () => api.agents(sessionId as string),
    refetchInterval: running ? 1500 : false,
  });
  if (!sessionId || !data || data.total === 0) return null;
  const label =
    data.running > 0 ? `${data.running} agents working` : `${data.total} agents ran`;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 self-start rounded-full bg-[var(--tg-secondary-bg)] px-3 py-1 text-xs font-medium text-[var(--brand-soft)]"
      >
        <Zap size={13} aria-hidden />
        {label}
      </button>
      {open && (
        <AgentsModal
          sessionId={sessionId}
          agents={data.agents}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
