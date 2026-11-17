// Run: node bridge/dashboard/web/src/lib/fixsession.check.ts
// What the UPDATE reader's fixing row says about the session an AI is fixing a
// failed update in: live from /running while it works, then its last turn's end.
import { fixView, finished } from "./fixsession.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const job = (label: string) => ({ session_id: "s1", job_id: "j", project: "p", title: "Fix diverged pull", started: 100,
  activity: { state: "tool" as const, label, tools: 3 } });
const st = (state: string, label: string | null = null) =>
  ({ state, kind: null, source: "bridge", label }) as never;
const turn = (status: "running" | "done" | "error", answer = "", elapsed: number | null = null) =>
  ({ id: "t", status, elapsed, sum: { answer, tools: 1, ended: 400, marks: [] } }) as never;
const tr = (turns: never[]) => ({ session: { title: "Fix diverged pull" } as never, turns });

eq(fixView("s1", { jobs: [job("git merge origin/master")], status: { s1: st("working") } }, null),
  { phase: "running", title: "Fix diverged pull", line: "git merge origin/master", secs: null },
  "a running turn says what it is doing now");

eq(fixView("s1", { jobs: [job("AskUserQuestion")], status: { s1: st("awaiting", "Keep my store.py?") } }, null).phase,
  "ask", "a turn waiting on an answer asks for you");

eq(fixView("s1", { jobs: [], status: { s1: st("asking") } }, null).phase, "ask", "asking is waiting on you too");

eq(fixView("s1", { jobs: [], status: { s1: st("idle") } }, tr([turn("done", "Merged.", 240)])).phase,
  "done", "an idle session is not live");

eq(fixView("s1", { jobs: [], status: {} }, null).phase, "starting", "no transcript yet: starting");

eq(fixView("s1", { jobs: [], status: {} }, tr([])).phase, "starting", "a session before its first turn is starting");

eq(fixView("s1", { jobs: [], status: {} }, tr([turn("running")])).phase, "starting",
  "a turn the transcript still holds running, not yet in /running, is starting");

eq(fixView("s1", { jobs: [], status: {} }, tr([turn("done", "Merged origin/master; your changes kept.", 240)])),
  { phase: "done", title: "Fix diverged pull", line: "Merged origin/master; your changes kept.", secs: 240 },
  "a finished turn reads its first answer line and how long it took");

eq(fixView("s1", { jobs: [], status: {} }, tr([turn("error", "Rate limited")])).phase, "failed",
  "a turn that errored is a failed fix");

eq(fixView("s1", { jobs: [job("x")], status: {} }, null).title, "Fix diverged pull", "a job alone is live");

ok(!finished(null) && !finished(tr([])) && !finished(tr([turn("running")])), "nothing ended: not finished");
ok(finished(tr([turn("done")])) && finished(tr([turn("error")])), "a last turn that ended is finished");
