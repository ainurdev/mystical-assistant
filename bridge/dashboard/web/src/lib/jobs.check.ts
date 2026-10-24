// Run: node bridge/dashboard/web/src/lib/jobs.check.ts
import { canRunAgain, dayLabel, dayOf, isJob, jobGroup, jobLabel, jobTarget, JOBS_REL, oneShot, parsePaper } from "./jobs.ts";
import { SHARED_REL } from "./team.ts";

console.assert(isJob({ origin: "rivendell:fd495085", project: "/" }), "an instance-tagged origin is a job");
console.assert(isJob({ origin: "rivendell", project: "/x" }), "a bare origin is a job");
console.assert(isJob({ origin: "terminal", project: "/.bridge_uploads/meetings" }), "the meetings folder is Rivendell's");
console.assert(isJob({ origin: null, project: "/.bridge_uploads/video-c4be1518" }), "a video folder is Rivendell's");
console.assert(!isJob({ origin: "dashboard", project: "/ainurhq/rivendell" }), "your own session in the rivendell repo is not");
console.assert(!isJob({ origin: "rivendellx", project: "/" }), "only the rivendell origin, not a prefix of a word");
console.assert(!isJob({ origin: "dashboard", project: "/.bridge_uploads" }), "an attachment folder is not");
console.assert(isJob({ origin: "terminal", project: "/", job: { kind: "news" } }), "a run the bridge filed a job on is one");
console.assert(!isJob({ origin: "terminal", project: "/", job: null }), "a terminal session with none is not");
console.assert(jobGroup({ origin: "rivendell:a", project: "/ainurhq/efas/app" }) === JOBS_REL, "a review files under the group");
console.assert(jobGroup({ origin: "dashboard", project: "/mystical-assistant" }) === "/mystical-assistant", "yours stays in its folder");
console.assert(jobGroup({ origin: "team:prod", project: "/" }) === SHARED_REL, "a session a teammate sent files under Shared");
console.assert(jobGroup({ origin: "device-run:prod", project: "/" }) === "/", "a teammate's device run doesn't");

console.assert(jobLabel({ kind: "news" }) === "NEWSPAPER", "the queue's word");
console.assert(jobLabel({ kind: "project-summary" }) === "SUMMARY", "a project summary reads SUMMARY");
console.assert(jobLabel({ kind: "conflict" }) === "CONFLICTS", "merge conflicts read CONFLICTS");
console.assert(jobTarget({ kind: "conflict", repo: "ainurdev/rivendell", number: 87 }) === "rivendell #87", "conflicts are about a PR, like a review");
console.assert(oneShot({ kind: "conflict" }), "a conflicts job's report is the point: the job bar, not the composer");
console.assert(jobLabel({ kind: "meeting-brief" }) === "BRIEF", "a meeting brief reads BRIEF");
console.assert(jobLabel({ kind: "todolist", step: "recommendations" }) === "RECOMMEND", "step 1 reads as what it is");
console.assert(jobLabel(null) === "RIVENDELL", "no kind on record");
console.assert(oneShot({ kind: "review" }) && oneShot({ kind: "news" }) && oneShot({ kind: "project-summary" }) && oneShot({ kind: "meeting-brief" }), "answers are the point");
console.assert(!oneShot({ kind: "impl" }), "an implementation keeps the composer");
console.assert(!oneShot({}) && !oneShot(null), "no kind, no bar");

console.assert(jobTarget({ kind: "review", repo: "ainurhq/ibgroups_operations", number: 81 }) === "ibgroups_operations #81", "repo and number");
console.assert(jobTarget({ kind: "video", step: "transcribe", language: "en" }) === "transcribe · en", "mode and language");
console.assert(jobTarget({ kind: "todolist", title: "Rivendell" }) === "", "the title already says it");
console.assert(dayOf("2026-10-18") === "Sun 18 Oct", `an edition date reads as a day: ${dayOf("2026-10-18")}`);

const today = new Date(2026, 9, 18, 19, 0);
console.assert(canRunAgain({ kind: "review", pr_id: "p" }, today), "a review with its PR id");
console.assert(!canRunAgain({ kind: "review" }, today), "no PR id, nothing to file");
console.assert(canRunAgain({ kind: "news", date: "2026-10-18" }, today), "today's paper reprints");
console.assert(!canRunAgain({ kind: "news", date: "2026-10-17" }, today), "yesterday's doesn't");
console.assert(!canRunAgain({ kind: "video" }, today) && !canRunAgain({ kind: "changelog", project_id: "p" }, today), "not from here");
console.assert(!canRunAgain({ kind: "project-summary", project_id: "p" }, today), "asked for again on its project's page");
console.assert(!canRunAgain({ kind: "meeting-brief", title: "Weekly sync" }, today), "written again on its brief page");

const now = new Date(2026, 9, 18, 19, 0);
console.assert(dayLabel(new Date(2026, 9, 18, 8, 0).getTime() / 1000, now) === "TODAY", "today");
console.assert(dayLabel(new Date(2026, 9, 17, 23, 0).getTime() / 1000, now) === "YESTERDAY", "yesterday");
console.assert(dayLabel(new Date(2026, 9, 14, 12, 0).getTime() / 1000, now) === "WED 14 OCT", `older: ${dayLabel(new Date(2026, 9, 14, 12, 0).getTime() / 1000, now)}`);

const paper = { ear: "e", lead: { headline: "Patterna opens its shop window", body: ["b"] }, stories: [] };
console.assert(parsePaper(JSON.stringify(paper))?.lead?.headline === "Patterna opens its shop window", "a paper");
console.assert(parsePaper("```json\n" + JSON.stringify(paper) + "\n```")?.ear === "e", "a fenced paper");
console.assert(parsePaper("## Review\nnot json") === null, "markdown is not a paper");
console.assert(parsePaper('{"lead": null}') === null, "no lead, no paper");
console.log("jobs.check: done");
