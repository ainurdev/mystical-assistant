// Which failures in a turn still matter. A failed test run that passes two steps
// later is the work going normally: counting it as a failure teaches you to ignore
// the count. So a failure followed by a success of the same kind stays quiet, and only
// what never recovered is shown, by the receipt, with its error.
//
// "The same kind" is as narrow as it can be while still catching a retry: tests with
// tests and builds with builds (a different flag is the same attempt), edits to the
// same file, otherwise the same tool or the same command. A failed read of one file is
// not answered by reading another. Pure.

import { bashHead, bashKind } from "./bashkind.ts";

export type Ev = {
  type: string; name?: string; id?: string; summary?: string; detail?: string;
  output?: string; is_error?: boolean; stat?: string;
  command?: string; ok?: boolean; code?: number; new?: string[]; tail?: string;
};

export type Failure = { at: number; key: string; label: string; error: string };
export type FailureState = {
  /** Indices of the `tool` events whose failure was later made good. */
  resolved: Set<number>;
  /** What's still broken, in the order it happened. A repeat counts once: the latest. */
  open: Failure[];
};

const WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READS = new Set(["Read", "NotebookRead"]);

/** Not a failure of the work: you said no, or stopped it. */
const YOURS = /interrupted by user|user declined|doesn't want to proceed|user doesn't want/i;

const EXIT = /^(?:Error: )?Exit code (\d+)\n?/;
const ERR_MAX = 1200;

function keyOf(e: Ev, command: string): string {
  if (e.name === "Bash") {
    const k = bashKind(command);
    return k === "other" || k === "run" ? `bash:${k}:${bashHead(command)}` : `bash:${k}`;
  }
  if (e.name && WRITES.has(e.name)) return `write:${e.summary ?? ""}`;
  if (e.name && READS.has(e.name)) return `read:${e.summary ?? ""}`;
  return `tool:${e.name ?? ""}`;
}

/** What a failed command said. The end of the output: that's where a runner puts its
 *  reason, and the start is usually the command echoing what it's about to do. */
function errorOf(output: string | undefined, stat: string | undefined): string {
  const raw = (output ?? "").replace(EXIT, "").trim();
  const text = raw || (stat ?? "").trim() || (output ?? "").trim();
  return text.length > ERR_MAX ? `…${text.slice(-ERR_MAX)}` : text;
}

export function failureState(events: Ev[]): FailureState {
  const done = new Map<string, Ev>();
  for (const e of events) if (e.type === "tool_done" && e.id) done.set(e.id, e);

  // Newest first, so "is there a later success" is what's been seen so far.
  const fine = new Set<string>();
  const resolved = new Set<number>();
  const open: Failure[] = [];
  const seen = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "checks") {
      const key = "bash:tests";
      if (e.ok) { fine.add(key); continue; }
      if (fine.has(key) || seen.has(key)) continue;
      seen.add(key);
      const named = e.new?.length ? e.new.join("\n") : "";
      open.push({ at: i, key, label: e.command ?? "checks",
                  error: named || errorOf(e.tail, e.code != null ? `exit code ${e.code}` : undefined) });
      continue;
    }
    if (e.type !== "tool" || !e.id) continue;
    const d = done.get(e.id);
    if (!d) continue;                 // still out: neither yet
    const command = e.detail ?? e.summary ?? "";
    const key = keyOf(e, command);
    if (!d.is_error) { fine.add(key); continue; }
    if (YOURS.test(`${d.stat ?? ""}\n${d.output ?? ""}`)) { resolved.add(i); continue; }
    // A search that found nothing exits 1. That's an answer.
    if (key === "bash:search" && !(d.output ?? "").replace(EXIT, "").trim()) { resolved.add(i); continue; }
    if (fine.has(key)) { resolved.add(i); continue; }
    if (seen.has(key)) { resolved.add(i); continue; }   // the newer try speaks for it
    seen.add(key);
    open.push({ at: i, key, label: e.name === "Bash" ? command : [e.name, e.summary].filter(Boolean).join(" "),
                error: errorOf(d.output, d.stat) });
  }
  open.reverse();
  return { resolved, open };
}
