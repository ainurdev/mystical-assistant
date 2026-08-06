import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/* The context strip under the chat header: what this session is trying to
   finish (goals.py drives the loop; the model owns the verdict, so the pill is
   read-only) and what a usage limit does to it. */

const POLICIES = ["ask", "auto", "wait"] as const;
const POLICY_ICON: Record<string, string> = { ask: "⛔", auto: "↪", wait: "⏳" };

export function GoalPill({ sessionId }: { sessionId: string | null }) {
  const { data } = useQuery({
    queryKey: ["goal", sessionId],
    queryFn: () => api.getGoal(sessionId as string),
    enabled: sessionId !== null,
    refetchInterval: 15000,
  });
  const goal = data?.goal;
  if (!goal || goal.state !== "active") return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-border-bright bg-[var(--ac-06)] px-3 py-1 text-[11px] text-[var(--brand-soft)]">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-soft)]"
        style={{ animation: "mpulse 2.4s infinite" }}
      />
      <span className="shrink-0">
        goal · {goal.iter}/{data?.max_iter ?? 10}
      </span>
      <span className="truncate text-[var(--tg-hint)]">{goal.objective}</span>
    </span>
  );
}

/** What a usage-limit death does to this chat — tap to cycle ask → auto → wait.
 *  Optimistic: the tapped value shows at once; the session poll confirms it. */
export function PolicyChip({
  sessionId,
  stored,
}: {
  sessionId: string | null;
  stored: string | null;
}) {
  const [local, setLocal] = useState<{ id: string; v: string } | null>(null);
  if (!sessionId) return null;
  const value = (local?.id === sessionId ? local.v : stored) ?? "ask";
  const next = POLICIES[(POLICIES.indexOf(value as (typeof POLICIES)[number]) + 1) % POLICIES.length];
  return (
    <button
      onClick={() => {
        setLocal({ id: sessionId, v: next });
        void api.setPolicy(sessionId, next).catch(() => setLocal(null));
      }}
      title={`On usage limit: ${value}. Tap for ${next}.`}
      aria-label={`On usage limit: ${value}`}
      className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[10px] tracking-wider text-[var(--tg-hint)] active:opacity-70"
    >
      {POLICY_ICON[value]} {value.toUpperCase()}
    </button>
  );
}
