import type { Turn } from "../chat";

/** Whether the running turn holds the desktop, and what it has done: read off
 *  the turn's own `computer_state` events (bridge/computer.py), so it needs no
 *  poll. Null when it isn't driving. */
export function driving(turns: Turn[]): { apps: string[]; actions: number } | null {
  const t = turns[turns.length - 1];
  if (!t || t.status !== "running") return null;
  let at = -1;
  let apps: string[] = [];
  t.events.forEach((e, i) => {
    if (e.type !== "computer_state") return;
    if (e.state === "driving") { at = i; apps = e.apps ?? []; } else at = -1;
  });
  if (at < 0) return null;
  const actions = t.events.slice(at).filter((e) => e.type === "tool" && e.name.startsWith("mcp__computer__")
    && e.name !== "mcp__computer__request_access" && e.name !== "mcp__computer__list_granted_applications").length;
  return { apps, actions: Math.max(actions, 1) };
}
