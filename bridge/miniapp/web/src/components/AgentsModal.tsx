import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, type AgentInfo } from "../lib/api";
import { Markdown } from "./Markdown";

export function AgentsModal({
  sessionId,
  agents,
  onClose,
}: {
  sessionId: string;
  agents: AgentInfo[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(agents[0]?.agent_id ?? null);
  const cursorRef = useRef(0);
  const [events, setEvents] = useState<AgentActivityRow[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cursorRef.current = 0;
    setEvents([]);
  }, [selected]);

  const { data } = useQuery({
    queryKey: ["agent-activity", sessionId, selected, "poll"],
    enabled: selected !== null,
    queryFn: async () => {
      const a = await api.agentActivity(sessionId, selected as string, cursorRef.current);
      if (a.events.length) {
        setEvents((prev) => [...prev, ...a.events]);
        cursorRef.current = a.next_cursor;
      }
      return a;
    },
    refetchInterval: (q) =>
      (q.state.data?.status ?? "running") === "running" ? 1000 : false,
  });

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--tg-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--tg-button)]/20 p-3">
        <span className="text-sm font-semibold">Agents</span>
        <span className="flex-1" />
        <button onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-2/5 overflow-y-auto border-r border-[var(--tg-button)]/20">
          {agents.map((a) => (
            <button
              key={a.agent_id}
              onClick={() => setSelected(a.agent_id)}
              className={`block w-full px-3 py-2 text-left text-xs ${
                a.agent_id === selected ? "bg-[var(--tg-secondary-bg)]" : ""
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    a.status === "running" ? "bg-green-400" : "bg-[var(--tg-hint)]"
                  }`}
                />
                <span className="truncate">{a.description || a.agent_id}</span>
              </div>
              <div className="mt-0.5 text-[10px] text-[var(--tg-hint)]">
                {a.agent_type}
                {a.spawn_depth > 1 ? ` · depth ${a.spawn_depth}` : ""}
              </div>
            </button>
          ))}
        </div>
        <div ref={feedRef} className="min-w-0 flex-1 space-y-2 overflow-y-auto p-3">
          {events.length === 0 && (
            <div className="text-xs text-[var(--tg-hint)]">No activity yet.</div>
          )}
          {events.map((e, i) =>
            e.type === "text" ? (
              <Markdown key={i} className="text-sm leading-relaxed">
                {e.text}
              </Markdown>
            ) : (
              <div
                key={i}
                className="flex items-center gap-1.5 font-mono text-xs text-[var(--tg-hint)]"
              >
                <span className="font-semibold">{e.name}</span>
                <span className="min-w-0 break-all">{e.summary}</span>
              </div>
            ),
          )}
          {data?.status === "running" && (
            <div className="text-xs text-[var(--tg-hint)]">Working…</div>
          )}
        </div>
      </div>
    </div>
  );
}

type AgentActivityRow =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string };
