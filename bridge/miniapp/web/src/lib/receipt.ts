// A turn's receipt: what it left behind, read off its events and nothing else.
//
// The answer is the agent's account of what it did; this is the record. It's built
// from what the tools returned, so a figure it can't read is left out rather than
// guessed, and a turn with nothing to say draws no row. PR links come only from
// commands that made or pushed one: an answer that mentions a link isn't a receipt
// for it. A change a shell command made (sed -i, a generator) isn't listed under
// files, since no event says which files it touched. Pure.

import { bashKind, parseTests, testWords, type TestCounts } from "./bashkind.ts";

type Ev = {
  type: string; name?: string; id?: string; summary?: string; detail?: string;
  output?: string; is_error?: boolean; patch?: string[]; elapsed?: number;
  command?: string; ok?: boolean; code?: number; ms?: number;
  passed?: number | null; failed?: number | null; skipped?: number | null;
  new?: string[]; known?: string[]; log?: string;
};

export type ReceiptFile = { path: string; add: number; del: number; patched: boolean };
export type ReceiptCheck = {
  command: string; ok: boolean; counts: TestCounts | null;
  fresh: string[]; known: string[]; log?: string;
};
export type Receipt = {
  files: ReceiptFile[];
  checks: ReceiptCheck[];
  commits: { sha: string; subject: string; branch: string }[];
  prs: { url: string; label: string }[];
  elapsed?: number;
  tokens?: number;
  agent?: string;
  /** Epoch seconds the answer landed. */
  at?: number;
};

const WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// `[main abc1234] subject`, `[main (root-commit) abc1234] subject`.
const COMMIT = /^\[([^\]\s]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$/gm;
const PR = /https:\/\/[\w.-]+\/[\w.~/-]+?\/(?:pull|merge_requests)\/(\d+)\b/g;

const countsOf = (e: Ev): TestCounts | null => {
  const c: TestCounts = {};
  if (e.passed != null) c.passed = e.passed;
  if (e.failed != null) c.failed = e.failed;
  if (e.skipped != null) c.skipped = e.skipped;
  return Object.keys(c).length ? c : null;
};

export function receiptOf(
  events: Ev[],
  ctx: { tokens?: number | null; agent?: string; started?: number } = {},
): Receipt {
  const done = new Map<string, Ev>();
  for (const e of events) if (e.type === "tool_done" && e.id) done.set(e.id, e);

  const files = new Map<string, ReceiptFile>();
  const checks: ReceiptCheck[] = [];
  const commits: Receipt["commits"] = [];
  const prs = new Map<string, string>();
  let elapsed: number | undefined;

  for (const e of events) {
    if (e.type === "result" && e.elapsed) elapsed = e.elapsed;
    if (e.type === "checks") {
      checks.push({ command: e.command ?? "checks", ok: !!e.ok, counts: countsOf(e),
                    fresh: e.new ?? [], known: e.known ?? [], log: e.log || undefined });
      continue;
    }
    if (e.type !== "tool" || !e.id) continue;
    const d = done.get(e.id);
    if (!d) continue;
    if (e.name && WRITES.has(e.name) && e.summary && !d.is_error) {
      const f = files.get(e.summary) ?? { path: e.summary, add: 0, del: 0, patched: false };
      for (const l of d.patch ?? []) {
        if (l.startsWith("+")) f.add++;
        else if (l.startsWith("-")) f.del++;
      }
      if (d.patch) f.patched = true;
      files.set(e.summary, f);
    }
    if (e.name !== "Bash") continue;
    const command = e.detail ?? e.summary ?? "";
    const output = d.output ?? "";
    if (bashKind(command) === "tests") {
      checks.push({ command, ok: !d.is_error, counts: parseTests(output), fresh: [], known: [] });
    }
    if (/\bgit\s+(?:-\S+\s+\S+\s+)*commit\b/.test(command) && !d.is_error) {
      for (const m of output.matchAll(COMMIT)) commits.push({ branch: m[1], sha: m[2], subject: m[3] });
    }
    if (/\bgh\s+pr\s+create\b|\bgit\s+(?:-\S+\s+\S+\s+)*push\b/.test(command)) {
      for (const m of output.matchAll(PR)) prs.set(m[0], `PR #${m[1]}`);
    }
  }

  const r: Receipt = {
    files: [...files.values()],
    checks: settled(checks),
    commits,
    prs: [...prs].map(([url, label]) => ({ url, label })),
  };
  if (elapsed) r.elapsed = elapsed;
  if (ctx.tokens) r.tokens = ctx.tokens;
  if (ctx.agent) r.agent = ctx.agent;
  if (ctx.started && elapsed) r.at = ctx.started + elapsed;
  return r;
}

/** Each command once, as it last came out; and a failed run that a later one made
 *  good is gone, the same quiet lib/failures keeps. */
function settled(all: ReceiptCheck[]): ReceiptCheck[] {
  const latest = new Map<string, ReceiptCheck>();
  for (const c of all) { latest.delete(c.command); latest.set(c.command, c); }
  const list = [...latest.values()];
  return list.filter((c, i) => c.ok || !list.slice(i + 1).some((later) => later.ok));
}

export const receiptEmpty = (r: Receipt): boolean =>
  !r.files.length && !r.checks.length && !r.commits.length && !r.prs.length
  && !r.elapsed && !r.tokens;

/** "1m 32s", "48s", "3.2s". */
export function shortTime(s: number): string {
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function shortTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function checksWord(c: ReceiptCheck[]): string {
  if (!c.length) return "";
  if (c.length === 1) {
    const one = c[0];
    if (one.counts) return testWords(one.counts);
    return one.ok ? "checks passed" : "checks failed";
  }
  const bad = c.filter((x) => !x.ok).length;
  return bad ? `${bad} of ${c.length} checks failed` : `${c.length} checks passed`;
}

export const receiptChecksOk = (c: ReceiptCheck[]): boolean => c.every((x) => x.ok);

/** The row's parts, in the order they read. Unknowns aren't in it, and PRs draw as
 *  links beside it. */
export function receiptLine(r: Receipt): string[] {
  const add = r.files.reduce((t, f) => t + f.add, 0);
  const del = r.files.reduce((t, f) => t + f.del, 0);
  const bits: string[] = [];
  if (r.files.length) {
    const changed = add || del ? ` +${add} −${del}` : "";
    bits.push(`${r.files.length} file${r.files.length === 1 ? "" : "s"}${changed}`);
  }
  const checks = checksWord(r.checks);
  if (checks) bits.push(checks);
  if (r.commits.length) bits.push(r.commits.length === 1 ? r.commits[0].sha.slice(0, 7) : `${r.commits.length} commits`);
  if (r.elapsed) bits.push(shortTime(r.elapsed));
  if (r.tokens) bits.push(`${shortTokens(r.tokens)} tok`);
  return bits;
}
