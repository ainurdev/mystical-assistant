// Which of a turn's failed tools still matter. An agent trying an Edit, reading the
// file and trying again is how work goes; red on every such row teaches you to ignore
// red. A failure followed by a later success of the same kind is recovered and reads
// as ordinary work; one nothing ever made good is a line by the receipt.
//
// "Same kind" is deliberately narrower than the tool: a failed Edit of a.py isn't made
// good by an Edit of b.py, and a failed test run isn't by an `ls`. A wrong call here
// costs little either way (the row stays in the work), but the false "recovered" is the
// worse of the two, so what can't be matched by purpose is matched by its first word.

import { bashKind, bashSegments } from "./bashkind.ts";
import { toolKind } from "./tools.ts";

type Ev = { type: string; name?: string; summary?: string; detail?: string; id?: string;
  is_error?: boolean; output?: string; stat?: string };

export type Failure = {
  /** Index of the tool event in the events it was given. */
  i: number;
  id: string;
  name: string;
  /** What it was trying: the command or the path. */
  what: string;
  /** The error, without the shell's status line. "" when none was recorded. */
  text: string;
};

/** What a later success has to match. */
export function failureKind(name: string, summary = "", detail?: string): string {
  if (name === "Bash") {
    const cmd = detail ?? summary;
    const k = bashKind(cmd);
    return k === "other" ? `bash:other:${bashSegments(cmd)[0]?.[0] ?? ""}` : `bash:${k}`;
  }
  const kind = toolKind(name);
  if (kind === "read" || kind === "write") return `${kind}:${summary}`;
  return `tool:${name}`;
}

const EXIT = /^(?:Error: )?Exit code \d+\n?/;

function errorText(d: Ev): string {
  const raw = (d.output ?? "").trimEnd().replace(EXIT, "") || (d.stat ?? "");
  const t = raw.trim();
  return t.length > 400 ? `${t.slice(0, 399)}…` : t;
}

export function analyzeFailures(events: Ev[]): { unresolved: Failure[]; recovered: Set<string> } {
  const done = new Map<string, Ev>();
  for (const e of events) if (e.type === "tool_done" && e.id) done.set(e.id, e);
  // Newest first: a kind is good from the moment one of its calls last succeeded.
  const goodAfter = new Set<string>();
  const unresolved: Failure[] = [];
  const recovered = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "tool" || !e.id || !e.name) continue;
    const d = done.get(e.id);
    if (!d) continue;
    const kind = failureKind(e.name, e.summary, e.detail);
    if (!d.is_error) { goodAfter.add(kind); continue; }
    if (goodAfter.has(kind)) recovered.add(e.id);
    else unresolved.unshift({ i, id: e.id, name: e.name, what: e.detail ?? e.summary ?? "", text: errorText(d) });
  }
  return { unresolved, recovered };
}
