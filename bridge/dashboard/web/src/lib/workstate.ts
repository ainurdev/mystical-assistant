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

/** The verb cmdAbstract's words start on, said as what is happening now. The
 *  set is closed — cmdAbstract only ever writes these — and a phrase opening on
 *  anything else (`gh pr view`, `mystical status`) is said whole, after "Running". */
const GERUND: Record<string, string> = {
  run: "Running", read: "Reading", edit: "Editing", count: "Counting", list: "Listing", enter: "Entering",
  create: "Creating", delete: "Deleting", move: "Moving", copy: "Copying", set: "Setting", stage: "Staging",
  commit: "Committing", check: "Checking", diff: "Diffing", push: "Pushing", pull: "Pulling", fetch: "Fetching",
  switch: "Switching", merge: "Merging", stash: "Stashing", search: "Searching", find: "Finding",
  install: "Installing", build: "Building", typecheck: "Typechecking", look: "Looking", kill: "Killing",
  start: "Starting", stop: "Stopping", restart: "Restarting", enable: "Enabling", disable: "Disabling",
};

/** A path's last two parts: enough to tell RunStream.tsx in components from one elsewhere. */
const tail = (p: string) => {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
};

/** What a running tool is doing, as the live WORK plate's line says it: a verb,
 *  what it is on in words, and the code it is on (a command, a path), which the
 *  line sets in the mono face. */
export type Now = { verb: string; what: string; code: string };

export function nowOf(e: Ev): Now {
  const s = (e.summary ?? "").trim();
  const name = e.name ?? "";
  switch (toolKind(name)) {
    case "bash": {
      const said = cmdAbstract(s);
      const [w = "", ...rest] = said.split(" ");
      // a leading `cd <dir> &&` says where it runs, not what
      const code = s.replace(/^cd\s+\S+\s*&&\s*/, "");
      return GERUND[w] ? { verb: GERUND[w], what: rest.join(" "), code } : { verb: "Running", what: said, code };
    }
    case "read": return { verb: "Reading", what: "", code: tail(s) };
    case "write": return { verb: name === "Write" ? "Writing" : "Editing", what: "", code: tail(s) };
    case "search": return { verb: name === "Glob" ? "Finding" : name === "LS" ? "Listing" : "Searching", what: "", code: tail(s) };
    case "web": return name === "WebSearch" ? { verb: "Searching the web for", what: s, code: "" } : { verb: "Fetching", what: hostOf(s) || s, code: "" };
    case "agent":
      return name === "Skill" ? { verb: "Using", what: e.agent?.type || s, code: "" }
        : { verb: "Asking", what: [e.agent?.type, e.agent?.title].filter(Boolean).join(" · ") || s, code: "" };
    case "mcp": { const p = mcpParts(name); return { verb: "Calling", what: `${p.server} · ${p.tool}`, code: "" }; }
    case "plan": return { verb: "Planning", what: "", code: "" };
    default: return { verb: "Using", what: name, code: "" };
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
