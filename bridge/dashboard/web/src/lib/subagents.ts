// Claude's own sub-agents (bridge/agents.py; lib/agents.ts is the ACP agents):
// the AGENTS modal's roster, and the open session's roster as AgentsPill last
// polled it, keyed by the Agent call that launched each one. The transcript's
// AGENT plates read that: a background agent's own tool_result is only its
// launch receipt ("6 lines"), so what it did, and whether it is still at it,
// lives here. openAgent() asks the pill to open the modal on one of them.

import { useSyncExternalStore } from "react";
import type { AgentInfo, AgentsInfo, WorkflowAgentInfo, WorkflowInfo } from "../api";

export type Sub = AgentInfo | WorkflowAgentInfo;
/** A roster row. `key` is the agent id, or "<run>::<agent>" for a workflow's
 *  (agent_activity reads that one from the run's dir). */
export type Item = { key: string; a: Sub; run?: string };
export type Section = { name: string; items: Item[]; total: number };

/** WORKING in the order they started, then DONE newest first — a long roster's
 *  finished agents are history — then each workflow's agents under their run.
 *  A filter keeps what matches its title or type; `total` is what it kept them
 *  from, and an empty section is not drawn. */
export function rosterSections(agents: AgentInfo[], workflows: WorkflowInfo[], filter: string): Section[] {
  const q = filter.trim().toLowerCase();
  const hit = (a: Sub) => !q || `${a.description} ${a.agent_type}`.toLowerCase().includes(q);
  const item = (a: Sub, run?: string): Item => ({ key: run ? `${run}::${a.agent_id}` : a.agent_id, a, run });
  const live = agents.filter((a) => a.status === "running").sort((x, y) => x.started_at - y.started_at);
  const done = agents.filter((a) => a.status !== "running").sort((x, y) => y.started_at - x.started_at);
  const all: Section[] = [
    { name: "Working", items: live.map((a) => item(a)), total: live.length },
    { name: "Done", items: done.map((a) => item(a)), total: done.length },
    ...workflows.map((w) => ({ name: `Workflow · ${w.name}`, items: w.agents.map((a) => item(a, w.run_id)),
                               total: w.agents.length })),
  ];
  return all.map((s) => ({ ...s, items: s.items.filter((i) => hit(i.a)) })).filter((s) => s.items.length);
}

/** A row's second line: the type (general-purpose is the default, so left
 *  off), the model, the tool calls — whichever are known yet. */
export function agentMeta(a: Sub): string {
  const type = a.agent_type === "general-purpose" ? "" : a.agent_type.split(":").pop();
  return [type, modelName(a.model), a.tools ? `${a.tools} tools` : ""].filter(Boolean).join(" · ");
}

/** Seconds as a roster span: 42s, 14m, 1h 12m. */
export function fmtSpan(s: number): string {
  s = Math.max(0, Math.round(s));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

/** A running agent's clock: 7:08. */
export function fmtClock(s: number): string {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "sonnet" → "Sonnet". */
export const modelName = (m: string | null | undefined) => (m ? m[0].toUpperCase() + m.slice(1) : "");

let byCall = new Map<string, AgentInfo>();
const subs = new Set<() => void>();

export function setRoster(d: AgentsInfo | null): void {
  byCall = new Map((d?.agents ?? []).filter((a) => a.tool_use_id).map((a) => [a.tool_use_id, a]));
  subs.forEach((fn) => fn());
}

/** The agent an Agent/Task call launched, once the roster knows it. */
export function useAgentFor(callId?: string): AgentInfo | undefined {
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    () => (callId ? byCall.get(callId) : undefined),
  );
}

export const OPEN_AGENT = "hud:agent";
/** Open the AGENTS modal on one agent (AgentsPill listens). */
export const openAgent = (agentId: string) =>
  window.dispatchEvent(new CustomEvent(OPEN_AGENT, { detail: agentId }));
