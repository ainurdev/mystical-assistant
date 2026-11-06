// Opening an agent from wherever it's listed: a helper is a session, so it goes
// down the app's normal open-session path; a Claude subagent lives in the AGENTS
// modal of the session that ran it (App's hud:open-subagent, then lib/subagents).
import { openSession } from "./devicerun";
import { canOpen, type AgentRow } from "./multi";

export const OPEN_SUBAGENT = "hud:open-subagent";
export type OpenSubagent = { session: string; agent: string };

export function openAgentRow(row: AgentRow): void {
  if (!canOpen(row)) return;
  if (row.kind === "member") { openSession(row.session_id!); return; }
  // rosterSections' key: a workflow's agent is "<run>::<agent>".
  const agent = row.workflow ? `${row.workflow}::${row.agent_id}` : row.agent_id!;
  window.dispatchEvent(new CustomEvent<OpenSubagent>(OPEN_SUBAGENT, { detail: { session: row.session_id!, agent } }));
}
