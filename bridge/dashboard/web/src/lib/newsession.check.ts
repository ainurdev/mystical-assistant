// Run: node --experimental-strip-types src/lib/newsession.check.ts  (from web/)
//
// NEW SESSION's list order and start routing. A wrong order buries the project
// you use most; a wrong route starts the session in the wrong worktree.
import { rankProjects, startCall } from "./newsession.ts";
import { JOBS_REL } from "./jobs.ts";
import { SHARED_REL } from "./team.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const same = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} (got ${JSON.stringify(got)})`);

const groups = [{ rel: "/a" }, { rel: "/b" }, { rel: "/c" }, { rel: JOBS_REL }, { rel: SHARED_REL }];
const s = (project: string, created: number, origin = "dashboard") => ({ project, origin, created, updated: created });
const sessions = [s("/a", 10), s("/b", 30), s("/c", 20), s("/a", 99, "rivendell:mahziyar"), s("/c", 50, "team:fd495085")];

const r = rankProjects(groups, sessions, null);
same(r.list.map((g) => g.rel), ["/b", "/c", "/a"], "newest of your own starts first; jobs and shares neither count nor list");
same(r.started.get("/a"), 10, "a job run in /a doesn't make /a recent");
same(rankProjects(groups, sessions, "/a").list.map((g) => g.rel), ["/a", "/b", "/c"], "the project you're in leads");
same(rankProjects(groups, [], null).list.map((g) => g.rel), ["/a", "/b", "/c"], "no sessions keeps the groups' order");

same(startCall("master", "master", false), { worktree: false }, "the checkout's branch is a plain session");
same(startCall("feat/x", "master", false), { worktree: true, branch: "feat/x", create: false }, "another branch gets its worktree");
same(startCall("fix/y", "master", true, "feat/x"), { worktree: true, branch: "fix/y", create: true, parent: "feat/x" }, "a new branch makes one from its parent");
same(startCall("fix/y", "master", true, ""), { worktree: true, branch: "fix/y", create: true, parent: undefined }, "an empty parent is git's default");
same(startCall("feat/x", undefined, false), { worktree: false }, "an unknown checkout never guesses a worktree");
