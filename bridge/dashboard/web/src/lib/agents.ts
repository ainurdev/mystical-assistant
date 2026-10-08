// Non-Claude agents in the UI (bridge/acp_agents.py runs them over ACP). Two
// things worth keeping pure: how a turn's runtime tag reads, and what the
// pickers offer an agent session. An agent's model/mode/effort ids are its own
// (every agent invents them), so its pickers come from the options it last
// advertised, never from Claude's lists — a Claude model on an agent session is
// refused by the bridge (spec rule 4).
import type { AcpAgentsInfo, AcpOption } from "../api";

export type Row = { id: string; label: string };
export const AGENT_DEFAULT: Row = { id: "", label: "AGENT DEFAULT" };
// What runPicks falls back to on an agent session instead of this device's
// Claude picks: nothing, so the agent's own default runs.
export const NO_PICKS = { model: "", perm: "", effort: "" };

// Preset id -> label, filled by App once /local/acp/agents lands. Module-level
// so the transcript badge needn't thread it down every turn.
// ponytail: a badge drawn before the first load shows the upper-cased id ("CODEX"); it is right on the next render.
let known: Record<string, string> = {};
export function setAgentLabels(presets: { id: string; label: string }[]) {
  known = Object.fromEntries(presets.map((p) => [p.id, p.label]));
}

/** "codex" -> "CODEX": the preset's label, else the id, upper-cased. */
export function agentLabel(id: string, labels: Record<string, string> = known): string {
  return (labels[id] ?? id).toUpperCase();
}

/** A turn's runtime tag as its transcript badge. "acp:<id>" is another agent;
 *  "claude:<slot>" another Claude login. */
export function runtimeBadge(runtime: string, labels: Record<string, string> = known):
  { text: string; agent: boolean; title: string } {
  const [kind, arg = ""] = runtime.split(":", 2);
  if (kind === "acp") {
    const name = agentLabel(arg, labels);
    return { text: `◇ ${name}`, agent: true, title: `Ran on ${name} — another agent, not Claude` };
  }
  return { text: `⇄ ACCOUNT ${arg}`, agent: false, title: "Ran on another Claude account after a usage limit" };
}

/** One picker's rows, AGENT DEFAULT first; null when the agent advertised none
 *  (that picker hides). */
export function optionRows(list?: AcpOption[]): Row[] | null {
  return list?.length ? [AGENT_DEFAULT, ...list.map((o) => ({ id: o.value, label: o.name }))] : null;
}

export interface AgentPickers { agent: string; label: string; model: Row[] | null; mode: Row[] | null; effort: Row[] | null }

/** What the composer offers the open session: null for a Claude one (its own
 *  lists apply), else the agent's cached options for that account. */
export function agentPickers(agent: string | undefined, account: string | undefined,
                             info: AcpAgentsInfo | null): AgentPickers | null {
  if (!agent || agent === "claude") return null;
  const o = info?.options[`${agent}|${account ?? ""}`];
  return { agent, label: agentLabel(agent), model: optionRows(o?.model), mode: optionRows(o?.mode),
           effort: optionRows(o?.effort) };
}
