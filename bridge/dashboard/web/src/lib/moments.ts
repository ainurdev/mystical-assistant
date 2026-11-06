import type { AnswerSelection } from "../api";
import type { Turn } from "../chat";
import { chosen, steerKey, type TurnRow } from "./checkpoints.ts";

/* The TURNS tab's moments (spec right-rail-reimagine, Turns · MOMENTS): the
   lines under a turn that say what it did that mattered — asked you, you
   steered it, committed, merged, pushed, opened a PR, ran the tests. How it
   ended is its header's (red stopped / error), not a line. Read off the events
   the chat holds, so a turn behind a tailed load's cut (summary only) has none
   rather than half of them.

   Bash is read off its command and its output (Bash-only, head-capped at 2000
   chars, no exit code — only is_error). Why not trust is_error alone: a pipe
   into tail hides a refused push, a conflicted merge or a hook that stopped a
   commit, and a grep that found nothing fails too — so each needs its output
   clean of failures, and a test run needs its result line. And why not the
   "[branch sha] subject" line alone: most commits here are `git commit -qm`,
   which prints nothing; their subject is their -m. */

export type Moment = {
  kind: "ask" | "steer" | "commit" | "merge" | "push" | "pr" | "tests";
  text: string;
  at: number | null;
  tone: "ask" | "acc" | "ok" | "err";
  // The turn in the chain that holds it, and the anchor inside it (an ask's
  // card, a steer): what the line hands onJump. A key alone can't say which
  // turn — steer keys are per-turn indexes.
  jump: string;
  key?: string;
};

type Did = Pick<Moment, "kind" | "text" | "tone">;

// git commit/merge/push and gh pr create, run at the head of a command — an
// echo, a grep or a sed pattern that only names one runs nothing. One scan,
// and only of a command that says git at all: a session's Bash calls carry
// megabytes of heredocs.
const RUNS = /(?:^|[;&|(\n]|\bthen|\bdo)\s*(?:git(?:\s+-C\s+\S+)?\s+(commit|merge|push)|gh\s+pr\s+(create))(?![\w-])/g;
const argsAt = (cmd: string, at: number) => /^[^;&|\n]*/.exec(cmd.slice(at))![0];
// What a pipe into tail hides from is_error: git refusing, a conflicted merge, a hook that stopped it.
const FAILED = /^(?:fatal|error):|^CONFLICT \(|Automatic merge failed|\bhook\b[^\n]*\b(?:exited|failed)/m;
// A test runner in a command of its own — python -m pytest, npx vitest, pnpm
// test, a wrapper's php artisan test — not in one that reads a log back.
const RUNNER = /\b(?:pytest|vitest|jest|node\s+--test|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check)|artisan\s+test)\b/;
const READS = /^[\s(]*(?:\w+=\S*\s+)*(?:tail|head|cat|less|grep|egrep|rg|sed|awk|echo|printf|wc|ls|jq|sort|cut|tee)\b/;
const ranTests = (cmd: string) => /test|jest|check/.test(cmd) && cmd.split(/[;&|\n]+/).some((c) => RUNNER.test(c) && !READS.test(c));
const count = (s: string | undefined) => Number((s ?? "0").replace(/,/g, ""));
const big = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ",");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// A shell word ("…", '…' or bare): its first line, a heredoc's (-m "$(cat <<'EOF' …), or with "…" when
// its quote never shut — a command cut at its 120-char summary, recorded before tool events kept `detail`.
const WORD = `("(?:[^"\\\\]|\\\\.)*"?|'[^']*'?|[^\\s;&|]+)`;
function firstLine(word: string | undefined): string | null {
  const q = /^["']/.exec(word ?? "")?.[0] ?? "";
  const shut = !!q && word!.length > 1 && word!.endsWith(q);
  const lines = (word ?? "").slice(q ? 1 : 0, shut ? -1 : undefined).replace(/\\(["\\$`])/g, "$1")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines[0]?.startsWith("$(cat <<") ? lines[1] : lines[0];
  return line ? `${line}${q && !shut ? "…" : ""}` : null;
}

/** A commit run's subject, off its -m — or off the msg=… the command set when that's -m "$msg". */
function subject(cmd: string, at: number): string | null {
  const s = firstLine(new RegExp(`^[^;&|\\n]*?\\s(?:-[a-zA-Z]*m|--message[=\\s])\\s*${WORD}`).exec(cmd.slice(at))?.[1]);
  const v = s && /^\$\{?(\w+)\}?$/.exec(s);
  return v ? firstLine(new RegExp(`(?:^|\\s)${v[1]}=${WORD}`).exec(cmd)?.[1]) : s;
}

/** A test run's result: its last "N passed / N failed" line (pytest, jest, vitest, artisan), else node --test's "pass N". */
function tally(out: string): { pass: number; fail: number } | null {
  const line = out.split("\n").reverse().find((l) => /\b\d[\d,]* (?:passed|failed)\b/.test(l));
  if (line) return { pass: count(/(\d[\d,]*) passed/.exec(line)?.[1]), fail: count(/(\d[\d,]*) failed/.exec(line)?.[1]) + count(/(\d[\d,]*) errors?\b/.exec(line)?.[1]) };
  const pass = /^[#ℹ ]*pass (\d+)/m.exec(out);
  return pass ? { pass: count(pass[1]), fail: count(/^[#ℹ ]*fail (\d+)/m.exec(out)?.[1]) } : null;
}

/** What one finished Bash call did, in the order a session does them. */
function bash(cmd: string, out: string, err: boolean): Did[] {
  const did: Did[] = [];
  const r = ranTests(cmd) ? tally(out) : null;
  if (r) did.push({ kind: "tests", tone: r.fail ? "err" : "ok",
    text: r.fail ? `${big(r.fail)} failed${r.pass ? `, ${big(r.pass)} passed` : ""}` : `${big(r.pass)} passed` });
  const found = /git|gh /.test(cmd) ? [...cmd.matchAll(RUNS)] : [];
  // where each run's arguments start
  const runs = (verb: string) => found.filter((m) => (m[1] ?? m[2]) === verb).map((m) => m.index + m[0].length);
  const tried = runs("commit"), merges = runs("merge"), pushes = runs("push");
  // An amend rewrites a commit rather than adding one; its [branch sha] line can't be told from another run's.
  const commits = tried.filter((at) => !/\s--amend\b/.test(argsAt(cmd, at)));
  if (commits.length) {
    const said = commits.length === tried.length ? [...out.matchAll(/^\[[^\]\n]+ [0-9a-f]{7,40}\] (.+)$/gm)].map((m) => m[1]) : [];
    const subjects = said.length ? said
      : err || FAILED.test(out) || /nothing (?:added )?to commit|no changes added to commit/.test(out) ? []
      : commits.map((at) => subject(cmd, at)).filter((s) => s != null);
    for (const s of subjects) {
      const merge = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(s);
      did.push(merge ? { kind: "merge", text: merge[1], tone: "acc" } : { kind: "commit", text: s, tone: "acc" });
    }
  }
  if (merges.length && !err && !FAILED.test(out) && !/Already up.to.date/i.test(out))
    for (const at of merges) {
      // drop the flags that take a value (-m msg, -s ort, -X subtree=…) with it, so the first word left is the branch
      const args = argsAt(cmd, at).replace(/\s(?:-[msXF]|--(?:message|strategy|strategy-option|file))(?:=|\s*)("[^"]*"|'[^']*'|\S+)/g, " ");
      if (/\s--(?:abort|continue|quit|skip)\b/.test(args)) continue;
      const branch = args.split(/\s+/).find((a) => a && !a.startsWith("-") && !/^\d*[<>]/.test(a));
      if (branch) did.push({ kind: "merge", text: branch, tone: "acc" });
    }
  // a delete, a dry run (-n) or a refusal sends no work
  if (pushes.some((at) => !/\s(?:--delete|-d|--dry-run|-n)\b|\s:\S/.test(argsAt(cmd, at)))
      && !err && !FAILED.test(out) && !/\[(?:remote )?rejected\]|failed to push|Everything up-to-date/.test(out))
    did.push({ kind: "push", tone: "acc",
      text: /^\s*[*+]?\s*(?:\[new (?:branch|tag)\]|[0-9a-f]{7,}\.\.\.?[0-9a-f]{7,})\s+\S+\s+->\s+(\S+)/m.exec(out)?.[1] ?? "" });
  const pr = runs("create").length && !err && !/already exists/.test(out) ? /\/pull\/(\d+)/.exec(out) : null;
  if (pr) did.push({ kind: "pr", text: `#${pr[1]}`, tone: "acc" });
  return did;
}

/** A row's moments, newest first: every turn of its chain (row.ids), a Bash
 *  call paired with its result by id across them. */
export function moments(row: TurnRow, turns: Turn[]): Moment[] {
  const chain = turns.filter((t) => row.ids.includes(t.id) && t.events.length);
  const out: Moment[] = [];
  const calls = new Map<string, { cmd: string; at: number | null; turn: string }>();
  const answers = new Map<string, AnswerSelection[]>();
  for (const t of chain) for (const e of t.events) if (e.type === "question_answered") answers.set(e.request_id, e.answers);
  for (const t of chain)
    // Indexed as RunStream indexes its anchors (and checkpoints' outline its
    // subs): without AskUserQuestion's own tool row, which its card stands in for.
    t.events.filter((e) => !(e.type === "tool" && e.name === "AskUserQuestion")).forEach((e, i) => {
      const at = e.at ?? null;
      if (e.type === "tool" && e.name === "Bash" && e.id) calls.set(e.id, { cmd: e.detail ?? e.summary, at, turn: t.id });
      else if (e.type === "tool_done" && e.id && calls.has(e.id)) {
        const c = calls.get(e.id)!;
        for (const d of bash(c.cmd, e.output ?? "", !!e.is_error)) out.push({ ...d, at: at ?? c.at, jump: c.turn });
      } else if (e.type === "question") {
        // A line per question, its answer paired as AskDock pairs it (in place, else by header).
        // Pushed last-first: the list turns newest-first below, which leaves them in the card's order.
        const given = answers.get(e.request_id), open = t.pending.some((p) => p.request_id === e.request_id);
        for (let qi = e.questions.length - 1; qi >= 0; qi--) {
          const q = e.questions[qi];
          const a = given?.[qi]?.header === q.header ? given[qi] : given?.find((x) => x.header === q.header);
          const pick = a?.labels.length ? a.labels.map(chosen).join(", ") : a?.notes ? `“${oneLine(a.notes)}”` : "";
          out.push({ kind: "ask", text: oneLine(q.question || q.header) + (pick ? ` → ${pick}` : ""),
                     at, tone: open ? "ask" : "acc", jump: t.id, key: e.request_id });
        }
      } else if (e.type === "steer")
        out.push({ kind: "steer", text: oneLine(e.text), at, tone: "acc", jump: t.id, key: steerKey(i) });
    });
  return out.reverse();
}
