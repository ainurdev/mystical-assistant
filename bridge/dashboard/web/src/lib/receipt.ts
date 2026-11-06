// A turn's receipt: what it actually did, built only from its events, in one row by
// the answer. An answer says what the agent thinks it did; this is what the tools
// recorded. Everything it can't know is absent rather than zero, so an empty row isn't
// drawn at all. Pure; components/TurnReceipt draws it.

import { bashKind, bashSegments, testLine, testResult } from "./bashkind.ts";
import { analyzeFailures, type Failure } from "./failures.ts";
import { toolKind } from "./tools.ts";

type Ev = { type: string; name?: string; summary?: string; detail?: string; id?: string; at?: number; text?: string;
  is_error?: boolean; output?: string; stat?: string; patch?: string[]; elapsed?: number;
  command?: string; ok?: boolean; code?: number; ms?: number; passed?: number | null; failed?: number | null;
  skipped?: number | null; new?: string[]; known?: string[] };

export type ReceiptFile = { path: string; edits: number; add: number; del: number; patch: string[] };
export type ReceiptCheck = { command: string; ok: boolean; line: string; fresh: string[]; known: number; from: "checks" | "command" };
export type ReceiptCommit = { sha?: string; subject?: string; branch?: string };
export type ReceiptPr = { url: string; n?: number };

export type Receipt = {
  files: ReceiptFile[];
  /** Every run, oldest first; the last is the one that counts. */
  checks: ReceiptCheck[];
  commits: ReceiptCommit[];
  pushed: string[];
  prs: ReceiptPr[];
  secs: number | null;
  tokens: number | null;
  runtime: string | null;
  unresolved: Failure[];
};

/** A `checks` event as words: the numbers, and how they stand against the known
 *  failures. */
export function checksLine(c: { ok?: boolean; code?: number; passed?: number | null; failed?: number | null; skipped?: number | null; new?: string[]; known?: string[] }): string {
  const nums = testLine({ passed: c.passed ?? undefined, failed: c.failed ?? undefined, skipped: c.skipped ?? undefined });
  const fresh = c.new?.length ?? 0, known = c.known?.length ?? 0;
  const said = fresh ? `${fresh} new` : known ? `${known === 1 ? "the 1" : `all ${known}`} known, none new` : "";
  const head = nums || (c.ok ? "passed" : `exit ${c.code ?? "?"}`);
  return said ? `${head} · ${said}` : head;
}

/** A commit from its command and what git printed. */
function commitsIn(words: string[], output: string): ReceiptCommit[] {
  const said = [...output.matchAll(/^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{6,})\] (.*)$/gm)];
  if (said.length) return said.map((m) => ({ branch: m[1], sha: m[2], subject: m[3] }));
  const m = words.findIndex((w) => /^-[a-zA-Z]*m$/.test(w) || w === "--message");
  if (m >= 0 && words[m + 1]) return [{ subject: words[m + 1].split("\n")[0] }];
  const inline = words.find((w) => /^-[a-zA-Z]*m./.test(w) && !w.startsWith("--"));
  return inline ? [{ subject: inline.replace(/^-[a-zA-Z]*m/, "").split("\n")[0] }] : [{}];
}

/** The git verb, past the flags and `-C dir` in front of it. */
function gitVerb(words: string[]): { verb: string; rest: string[] } {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree") { i++; continue; }
    if (w.startsWith("-")) continue;
    return { verb: w, rest: words.slice(i + 1) };
  }
  return { verb: "", rest: [] };
}

const PR_URL = /https?:\/\/[^\s"'<>)]+\/(?:pull|merge_requests)\/(\d+)\b/g;

export function receiptOf(events: Ev[], meta: { elapsed?: number | null; tokens?: number | null; runtime?: string | null; started?: number } = {}): Receipt {
  const done = new Map<string, Ev>();
  for (const e of events) if (e.type === "tool_done" && e.id) done.set(e.id, e);
  const files = new Map<string, ReceiptFile>();
  const fromChecks: ReceiptCheck[] = [], fromCommands = new Map<string, ReceiptCheck>();
  const commits: ReceiptCommit[] = [], pushed: string[] = [];
  const prs = new Map<string, ReceiptPr>();
  let resultSecs: number | null = null, first: number | null = null, last: number | null = null;

  for (const e of events) {
    if (e.at != null) { first ??= e.at; last = e.at; }
    if (e.type === "result" && typeof e.elapsed === "number" && e.elapsed > 0) resultSecs = e.elapsed;
    if (e.type === "checks") {
      fromChecks.push({ command: e.command ?? "", ok: !!e.ok, line: checksLine(e), fresh: e.new ?? [], known: e.known?.length ?? 0, from: "checks" });
      continue;
    }
    if (e.type !== "tool" || !e.name) continue;
    const d = e.id ? done.get(e.id) : undefined;
    if (!d) continue;
    // What changed: a call that came back with a patch, or an Edit/Write that worked.
    if ((d.patch || toolKind(e.name) === "write" || /patch/i.test(e.name)) && !d.is_error && e.summary) {
      const f = files.get(e.summary) ?? { path: e.summary, edits: 0, add: 0, del: 0, patch: [] };
      f.edits += 1;
      for (const l of d.patch ?? []) {
        f.patch.push(l);
        if (l.startsWith("+")) f.add += 1;
        else if (l.startsWith("-")) f.del += 1;
      }
      files.set(e.summary, f);
    }
    if (e.name !== "Bash") continue;
    const cmd = e.detail ?? e.summary ?? "";
    const output = d.output ?? "";
    if (bashKind(cmd) === "tests") {
      const r = testResult(output);
      // Each command's last run: an earlier red that the same command later cleared
      // isn't this turn's result. Delete first, so the newest stays last in the list.
      fromCommands.delete(cmd);
      fromCommands.set(cmd, { command: cmd, ok: !d.is_error && !r?.failed, line: testLine(r) || (d.is_error ? "failed" : "passed"), fresh: [], known: 0, from: "command" });
    }
    if (d.is_error) continue;
    for (const words of bashSegments(cmd)) {
      const i = words.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w));
      const seg = i > 0 ? words.slice(i) : words;
      const head = seg[0]?.split("/").pop();
      if (head === "git") {
        const { verb, rest } = gitVerb(seg);
        if (verb === "commit" && !rest.includes("--dry-run")) commits.push(...commitsIn(rest, output));
        if (verb === "push" && !rest.includes("--dry-run") && !/Everything up-to-date/.test(output)) {
          const m = /(?:\[new branch\]\s+|[0-9a-f]+\.\.+[0-9a-f]+\s+)(\S+)\s+->\s+(\S+)/.exec(output);
          const positional = rest.filter((w) => !w.startsWith("-"));
          const branch = m?.[2] ?? positional[1]?.split(":").pop() ?? "";
          if (!pushed.includes(branch)) pushed.push(branch);
        }
      }
      if (head === "gh" && seg[1] === "pr" && seg[2] === "create") {
        for (const m of output.matchAll(PR_URL)) prs.set(m[0], { url: m[0], n: parseInt(m[1], 10) });
      }
    }
  }
  const secs = meta.elapsed && meta.elapsed > 0 ? meta.elapsed
    : resultSecs ?? (meta.started != null && last != null && last > meta.started ? last - meta.started
      : first != null && last != null && last > first ? last - first : null);
  return {
    files: [...files.values()],
    checks: fromChecks.length ? fromChecks : [...fromCommands.values()],
    commits,
    pushed,
    prs: [...prs.values()],
    secs,
    tokens: typeof meta.tokens === "number" && meta.tokens > 0 ? meta.tokens : null,
    runtime: meta.runtime || null,
    unresolved: analyzeFailures(events).unresolved,
  };
}

/** Nothing worth a row. */
export function receiptEmpty(r: Receipt): boolean {
  return !r.files.length && !r.checks.length && !r.commits.length && !r.pushed.length && !r.prs.length
    && r.secs == null && r.tokens == null && !r.runtime && !r.unresolved.length;
}
