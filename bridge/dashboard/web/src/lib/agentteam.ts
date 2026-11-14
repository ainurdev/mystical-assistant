// (Not lib/team.ts, which is the Rivendell team's.) The Agents view's data and the pure parts of it (components/AgentsView; bridge/agent_team.py).

export type Status = "running" | "waiting" | "done" | "failed";
export type TeamAgent = {
  id: string; name: string; type?: string; parent: string; depth: number; status: Status; started: number; updated: number;
  model: string | null; tools: number; now: string; background?: boolean;
};
export type TeamMessage = { at: number; kind: "brief" | "message" | "report" | "problem" | "you"; from: string; to: string; text: string; title?: string };
export type Team = {
  agents: TeamAgent[]; messages: TeamMessage[]; counts: Partial<Record<Status, number>>; depth?: number;
  main: (Omit<TeamAgent, "parent" | "depth" | "status"> & { status: "running" | "done" }) | null; names?: Record<string, string>;
};
export type DiffLine = { k: "a" | "r" | "c"; t: string };
export type Step = {
  at: number; kind: "say" | "edit" | "run" | "read" | "agent" | "message"; text: string; detail?: string;
  diff?: { path: string; added: number; removed: number; lines: DiffLine[]; more: number; new: boolean };
};
export type AgentDetail = { id: string; brief: string; steps: Step[]; earlier: number; report: string; tools: number; started: number; updated: number; model: string | null };

export const MAIN = "main";
export const STATUS_WORD: Record<Status, string> = { running: "Working", waiting: "Waiting", done: "Done", failed: "Failed" };
export const KIND_WORD: Record<TeamMessage["kind"], string> = { brief: "Brief", message: "Message", report: "Report", problem: "Problem", you: "From you" };

export type Row =
  | { kind: "agent"; agent: TeamAgent; depth: number; kids: number; working: number; open: boolean }
  | { kind: "fold"; id: string; depth: number; count: number; label: string };

const live = (s: Status) => s === "running" || s === "waiting";

/** The tree as rows to draw. Under each agent, the ones still going first, then its finished ones folded
 *  into one "N done" row unless that fold is open: 84 finished agents shouldn't bury 14 working ones. */
export function treeRows(agents: TeamAgent[], shut: Set<string>, openFolds: Set<string>, show: (a: TeamAgent) => boolean): Row[] {
  const kids = new Map<string, TeamAgent[]>();
  for (const a of agents) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
  const working = (id: string): number => (kids.get(id) ?? []).reduce((n, k) => n + (live(k.status) ? 1 : 0) + working(k.id), 0);
  const shown = (a: TeamAgent): boolean => show(a) || (kids.get(a.id) ?? []).some(shown);
  const out: Row[] = [];
  const walk = (parent: string, depth: number) => {
    const all = (kids.get(parent) ?? []).filter(shown);
    const going = all.filter((a) => a.status !== "done" || working(a.id) > 0);
    const done = all.filter((a) => !going.includes(a));
    const put = (a: TeamAgent) => {
      const open = !shut.has(a.id);
      out.push({ kind: "agent", agent: a, depth, kids: (kids.get(a.id) ?? []).length, working: working(a.id), open });
      if (open) walk(a.id, depth + 1);
    };
    going.forEach(put);
    if (done.length > 2 && going.length && !openFolds.has(parent)) out.push({ kind: "fold", id: parent, depth, count: done.length, label: `${done.length} done` });
    else done.forEach(put);
  };
  walk(MAIN, 1);
  return out;
}

export function ago(sec: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - sec));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m ago`;
}

export function span(from: number, to: number): string {
  const s = Math.max(0, Math.round(to - from));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** What the main agent is asked, in words: Mystical can't reach one of Claude's sub-agents itself. */
export function sayTo(target: { id: string; name: string; group?: boolean } | null, text: string): string {
  if (!target || target.id === MAIN) return text;
  const who = `the agent "${target.name}" (id ${target.id.replace(/^agent-/, "")})`;
  return target.group
    ? `Pass this on, word for word, with SendMessage, to ${who} and to every agent it started that is still working:\n\n${text}`
    : `Pass this on, word for word, with SendMessage, to ${who}, and to nobody else:\n\n${text}`;
}

export function stopAsk(target: { id: string; name: string; group?: boolean }): string {
  const who = `the agent "${target.name}" (id ${target.id.replace(/^agent-/, "")})`;
  return target.group
    ? `Stop ${who} and every agent it started, with TaskStop. Leave all the other agents working. Then tell me which ones you stopped.`
    : `Stop ${who} with TaskStop. Leave all the other agents working. Then tell me it has stopped.`;
}
