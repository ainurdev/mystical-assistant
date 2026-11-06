// Multi-agent chats on the phone: is the switch on, and what's under this chat.
// One query each, shared through react-query's cache, so every component asks freely.

import { useQuery } from "@tanstack/react-query";
import { api, type AgentCaps, type MemberInfo, type Profile, type SessionBrief } from "./api";

/** The EXPERIMENTAL switch. It lives on the dashboard; here it's only read. A bridge
 *  older than the route 404s, an error reads as off, and the app stays as it was. */
export function useExperimental(): boolean {
  const { data } = useQuery({
    queryKey: ["experimental"],
    queryFn: () => api.experimental(),
    retry: false,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  return data?.enabled === true;
}

/** What's under the open chat. The channel route answers for a helper too (`chat` is
 *  its parent), and carries rows + messages + limits, so it's the only poll needed.
 *  Slower behind the transcript, where it only decides whether the switch shows. */
export function useChannel(sessionId: string | null, on: boolean, watching = false) {
  return useQuery({
    queryKey: ["channel", sessionId],
    queryFn: () => api.channel(sessionId as string),
    enabled: on && sessionId !== null,
    retry: false,
    refetchInterval: watching ? 3000 : 6000,
  });
}

export const providerName = (agent: string | undefined) =>
  !agent || agent === "claude" ? "Claude" : agent.charAt(0).toUpperCase() + agent.slice(1);

// Hand-kept copy of bridge/agent_caps.py's two rows, for a helper only: it is opened
// from its transcript row, which carries no brief, and the lists leave helpers out.
// ponytail: delete this and withHelperFields once a route returns a helper's
// brief; a preset the table overrides differently reads wrong until then.
const CLAUDE_CAPS: AgentCaps = { steer: "native", ask: "native", block: true, system_prompt: true,
  subagents: "detailed", usage: true, compact: true, tools_switch: true, goals: true, duplicate: true,
  skills_prefix: "/" };
const AGENT_CAPS: AgentCaps = { steer: "soft", ask: "gateway", block: false, system_prompt: false,
  subagents: "opaque", usage: false, compact: false, tools_switch: false, goals: true, duplicate: false,
  skills_prefix: "/" };

function capsOf(agent: string): AgentCaps {
  if (agent === "claude") return CLAUDE_CAPS;
  return agent === "kimi" ? { ...AGENT_CAPS, skills_prefix: "/skill:" } : AGENT_CAPS;
}

function memberOf(raw: unknown): MemberInfo | null {
  if (raw && typeof raw === "object") return raw as MemberInfo;
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw) as MemberInfo; } catch { return null; }
}

/** A helper's transcript row as a brief: who runs it comes from its profile (a helper
 *  always has its profile on its row, or runs on Claude). Anything else passes through. */
export function withHelperFields<T extends SessionBrief>(row: T, profile: Profile | null): T {
  if (!row.parent_session || row.caps) return row;
  const agent = row.agent ?? profile?.agent ?? "claude";
  return { ...row, agent, caps: capsOf(agent), member: memberOf(row.member) };
}
