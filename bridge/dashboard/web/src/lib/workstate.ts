// What a live turn is doing right now, for the STATUS working indicator. Pure —
// the indicator draws the line, this only reads it off the turn's events.
//
// The other indicators cycle a list of phrases (READING CONTEXT, SYNTHESIZING…)
// that say nothing about the turn. Everything here is already on the stream: a
// `tool` with no `tool_done` yet is running, and with nothing running the model
// is thinking.

import { cmdAbstract, hostOf, mcpParts, toolKind, toolTag } from "./tools.ts";

/** Only what the read needs off a run event. */
type Ev = {
  type: string;
  id?: string;
  name?: string;
  summary?: string;
  at?: number;
  agent?: { type?: string; title?: string };
};

/** `tag` is the state (`BASH`, `THINKING`, the boot text), `detail` what it is
 *  on, `more` how many other tools are in flight, and `since` when the state
 *  began, in epoch seconds. `since` is undefined when the store hasn't
 *  stamped the event yet. */
export type WorkState = { tag: string; detail: string; more: number; since?: number };

/** What a running tool is on, in the fewest words the transcript already has
 *  for it. */
function detailOf(e: Ev): string {
  const s = e.summary ?? "";
  switch (toolKind(e.name ?? "")) {
    case "bash": return cmdAbstract(s) || s;
    case "read": case "write": return s.split("/").pop() ?? s;
    case "agent": return [e.agent?.type, e.agent?.title].filter(Boolean).join(" · ") || s;
    case "mcp": return mcpParts(e.name ?? "").tool;
    case "web": return hostOf(s) || s;
    default: return s;
  }
}

// ponytail: tools pair with their result by `id`. An id-less tool (turns
// recorded before ids landed) never reads as open, but those turns can't be live.
export function workState(events: Ev[], boot?: string | null, started?: number): WorkState {
  if (boot) return { tag: boot, detail: "", more: 0, since: started };
  const open = new Map<string, Ev>();
  for (const e of events) {
    if (e.type === "tool" && e.id) open.set(e.id, e);
    else if (e.type === "tool_done" && e.id) open.delete(e.id);
  }
  const running = [...open.values()];
  const last = running[running.length - 1];
  if (last) return { tag: toolTag(last.name ?? ""), detail: detailOf(last), more: running.length - 1, since: last.at };
  return { tag: "THINKING", detail: "", more: 0, since: events.length ? events[events.length - 1].at : started };
}
