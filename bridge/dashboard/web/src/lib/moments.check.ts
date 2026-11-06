// Run: node src/lib/moments.check.ts  (from web/)
//
// The TURNS tab's moments: what a turn did that mattered, read off its events —
// commits, merges, pushes, PRs and test results from its Bash calls, its asks
// and steers, and how it ended. Newest first. The commands and outputs below
// are the shapes real sessions record (bridge/transcript_jsonl.tool_done).
import type { TimedEvent } from "../api.ts";
import type { Turn } from "../chat.ts";
import { turnRows } from "./checkpoints.ts";
import { moments, type Moment } from "./moments.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

let seq = 0;
const turn = (id: string, events: TimedEvent[], over: Partial<Turn> = {}): Turn =>
  ({ id, prompt: `prompt ${id}`, events, status: "done", pending: [], started: 1000, ...over });
// A Bash call and its result, as recorded: the command cut to 120 chars, whole in `detail`.
const bash = (command: string, output: string, is_error = false, at = 1100): TimedEvent[] => {
  const id = `b${++seq}`;
  return [{ type: "tool", name: "Bash", id, summary: command.slice(0, 120), ...(command.length > 120 ? { detail: command } : {}), at: at - 5 },
          { type: "tool_done", id, output, is_error, at }];
};
const run = (...ts: Turn[]) => moments(turnRows(ts)[0], ts);
const of = (...events: TimedEvent[]) => run(turn("t1", events));
const brief = (ms: Moment[]) => ms.map((m) => `${m.kind} ${m.text} ${m.tone}`);

// --- commits ------------------------------------------------------------------------
eq(brief(of(...bash('git commit -m "x"', "[feat/skill-paths 1a2b3c4] paths: per-session flow state\n 2 files changed"))),
  ["commit paths: per-session flow state acc"], "a commit reads its subject off git's [branch sha] line");
eq(of(...bash('git commit -m "x"', "On branch master\nnothing to commit, working tree clean")), [], "nothing to commit is no moment");
eq(brief(of(...bash('cd /repo && git add -A && git commit -qm "dashboard: Usage leads with your week" && git log --oneline -1',
  "95fa3aa6 dashboard: Usage leads with your week"))), ["commit dashboard: Usage leads with your week acc"],
  "a quiet commit (-qm, no [branch sha] line) reads its subject off its -m");
eq(brief(of(...bash(`git add -A && git commit -q -m "$(cat <<'EOF'\nrunner: load the bundled skill pack\n\nWhy it moved.\nEOF\n)"`, ""))),
  ["commit runner: load the bundled skill pack acc"], "a heredoc message's first line is the subject");
eq(of(...bash('git add -A && git commit -qm "x"', "Exit code 1\nOn branch master\nnothing to commit", true)), [], "a commit that failed is no moment");
eq(of(...bash("T=$(git write-tree) && C=$(git commit-tree $T -p HEAD -m wip) && echo $C", "2ddf6db2")), [], "git commit-tree is not a commit");
eq(of(...bash('echo "then run git commit -m later"', "then run git commit -m later")), [], "a command that only names git commit runs none");
eq(brief(of(...bash(`cd ${"/Users/someone/Projects/.worktrees/a-very-long-project-name/feat-something-long".repeat(2)} && git commit -qm "far past the summary cut"`, ""))),
  ["commit far past the summary cut acc"], "a command longer than its summary is read whole");
eq(brief(of({ type: "tool", name: "Bash", id: "old", summary: 'cd ~/p/nr-kantoor-wt-a && git add docs/screenshots/pr-34 && git commit -q -m "Scr' },
  { type: "tool_done", id: "old", output: "", is_error: false })), ["commit Scr… acc"], "a command cut at its summary, recorded before `detail`, says so");
eq(brief(of(...bash('msg="transcript: paths are file links" && echo "${#msg} chars" && git commit -q -m "$msg"', "38 chars"))),
  ["commit transcript: paths are file links acc"], 'a -m "$msg" reads the msg= the command set');

// --- merges -------------------------------------------------------------------------
eq(brief(of(...bash("git merge feat/skill-paths", "Updating 1a2b3c4..5d6e7f8\nFast-forward\n bridge/paths.py | 4 ++--"))),
  ["merge feat/skill-paths acc"], "a merge names its branch");
eq(of(...bash("git merge feat/skill-paths", "CONFLICT (content): Merge conflict in bridge/paths.py", true)), [], "a merge that failed is no moment");
eq(brief(of(...bash("git merge --no-edit master 2>&1 | tail -2", " create mode 100644 docs/a.md"))), ["merge master acc"],
  "flags and redirects are not the branch");
eq(brief(of(...bash('git merge -X subtree=apps/dashboard -m "take it" nr/main', "Merge made by the 'ort' strategy."))), ["merge nr/main acc"],
  "a flag's value is not the branch");
eq(of(...bash("git merge feat/x", "Already up to date.")), [], "a merge with nothing to bring is no moment");
eq(of(...bash("git merge --abort", "")), [], "an aborted merge is no moment");
eq(of(...bash("git merge-base --is-ancestor 92b6dace master && echo in", "in")), [], "git merge-base is not a merge");
eq(brief(of(...bash("git commit --no-edit", "[feat/skill-paths 57ae984] Merge branch 'master' into feat/skill-paths"))),
  ["merge master acc"], "a merge commit reads as the merge it concludes");

// --- pushes and PRs -------------------------------------------------------------------
eq(brief(of(...bash("git push origin HEAD:main 2>&1 | tail -4", "To github.com:ainurdev/osanwe.git\n   dafb2e9..6a87309  HEAD -> main"))),
  ["push main acc"], "a push names where it landed");
eq(brief(of(...bash("git push", ""))), ["push  acc"], "a push that printed nothing still pushed");
eq(of(...bash("git push -u origin feat/x", "PreToolUse:Bash hook error: Held once", true)), [], "a push a hook held is no moment");
eq(of(...bash("git push 2>&1 | tail -2", " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'o/r'")), [],
  "a rejected push is no moment, even when a pipe hid its exit code");
eq(of(...bash("git push", "Everything up-to-date")), [], "a push with nothing to send is no moment");
eq(of(...bash("git push origin --delete feat/x", " - [deleted]         feat/x")), [], "deleting a remote branch is not a push of work");
eq(brief(of(...bash('gh pr create --title "x" --body-file b.md', "https://github.com/o/r/pull/112"))), ["pr #112 acc"], "a PR is its number");
eq(of(...bash("gh pr create --fill 2>&1 | tail -2", 'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/o/r/pull/12')), [],
  "a PR that already existed was not opened");
eq(brief(of(...bash("cat > b.md <<'EOF'\n## Summary\nEOF\ngit push -u origin feat/EFA-300 && gh pr create --body-file b.md",
  " * [new branch]        feat/EFA-300 -> feat/EFA-300\nbranch 'feat/EFA-300' set up to track 'origin/feat/EFA-300'.\nhttps://github.com/efasone/app/pull/213"))),
  ["pr #213 acc", "push feat/EFA-300 acc"], "one call that pushed then opened a PR: both, newest first");

// --- tests ----------------------------------------------------------------------------
eq(brief(of(...bash("python3 -m pytest tests/ -q", "........ [100%]\n3564 passed in 19.1s"))), ["tests 3,564 passed ok"], "pytest passed");
eq(brief(of(...bash("python3 -m pytest tests/ -q", "FAILED tests/test_x.py::test_y - assert 1 == 2\n2 failed, 10 passed in 3.2s", true))),
  ["tests 2 failed, 10 passed err"], "pytest failed");
eq(of(...bash("python3 -m pytest tests/ -q", "........................\n…")), [], "a run cut before its result line is no moment");
eq(of(...bash('grep -rn "pytest" src', "Exit code 1", true)), [], "a failed call with no result line is no test result (a grep that found nothing)");
eq(brief(of(...bash("npx vitest run", " Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 12 passed (13)"))),
  ["tests 1 failed, 12 passed err"], "vitest: its Tests line, not its Test Files line");
eq(brief(of(...bash("pnpm test", "Test Suites: 3 passed, 3 total\nTests:       3 skipped, 5247 passed, 5250 total"))),
  ["tests 5,247 passed ok"], "jest");
eq(brief(of(...bash("node --test src/", "ℹ tests 12\nℹ suites 0\nℹ pass 12\nℹ fail 0"))), ["tests 12 passed ok"], "node --test");

// --- asks and steers ------------------------------------------------------------------
const ask = (): TimedEvent => ({ type: "question", request_id: "q1", at: 1200,
  questions: [{ question: "Keep the skill-paths worktree after the merge?", header: "Worktree", options: [] }] });
{
  const t = turn("t1", [{ type: "text", text: "merging" }, ask()],
    { status: "running", pending: [{ request_id: "q1", kind: "question", tool_name: "AskUserQuestion" }] });
  const [m] = run(t);
  eq([m.kind, m.text, m.tone, m.at, m.jump, m.key], ["ask", "Worktree", "ask", 1200, "t1", "q1"], "an open question waits on you, and jumps to its card");
}
eq(brief(of(ask(), { type: "question_answered", request_id: "q1", answers: [{ header: "Worktree", labels: ["Keep it (Recommended)"] }] })),
  ["ask Worktree → Keep it acc"], "an answered one says what you picked, out of the ask colour");
{
  const t = turn("t1", [{ type: "text", text: "on it" }, { type: "steer", text: "use the  merge\ncommit", at: 1300 }]);
  const steer = turnRows([t])[0].subs.find((s) => s.kind === "steer");
  const [m] = run(t);
  eq([m.kind, m.text, m.key], ["steer", "use the merge commit", steer?.kind === "steer" ? steer.key : null],
    "a steer jumps to the anchor the transcript draws it at");
}

// --- how it ended, and what has none ---------------------------------------------------
{
  const [m] = of({ type: "text", text: "working" }, { type: "stopped", at: 1500 });
  eq([m.kind, m.text, m.tone, m.jump], ["end", "stopped", "err", "t1"], "a stopped turn ends on a red moment");
}
eq(brief(run(turn("t1", [{ type: "error", message: "limit" }], { status: "error", outcome: { code: "limit", label: "USAGE LIMIT", detail: "" } }))),
  ["end errored · usage limit err"], "an errored turn says why");
eq(run(turn("t1", [], { status: "error", sum: { answer: "", tools: 3, ended: 1200, marks: [{ kind: "question", id: "q1", label: "x", pick: "y", note: null }] } })), [],
  "a turn behind the tail cut (summary only) has no moments");

// --- order, and a chain of turns ---------------------------------------------------------
eq(brief(of(...bash('git commit -qm "a"', "", false, 1100), ...bash("pytest -q", "3 passed in 1s", false, 1200), ask())),
  ["ask Worktree acc", "tests 3 passed ok", "commit a acc"], "newest first");
{
  const LIMIT = "⏮ Your previous turn was cut off because the Claude usage limit was reached — not by the user. It has been resumed on another account. Review your recent transcript and continue exactly where you left off; finish the task you were doing. Don't start over.";
  const [call, done] = bash("git merge feat/x", "Fast-forward");
  const ms = run(turn("t1", [...bash('git commit -qm "first"', ""), call]), turn("t2", [done], { prompt: LIMIT }));
  eq(ms.map((m) => `${m.kind}@${m.jump}`), ["merge@t1", "commit@t1"], "a resume's moments fold into the turn it carried on, a call paired across them");
}
