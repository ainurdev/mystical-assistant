// Run: node bridge/dashboard/web/src/lib/prchip.check.ts
import type { PrInfo } from "../api.ts";
import {
  chipLabel, commentsMessage, duration, failureMessage, freshPings, pingText, popPlace, reviewItems, stateLine,
} from "./prchip.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const base: PrInfo = {
  number: 131, title: "Inbox: group action items by client", url: "https://github.com/acme/r/pull/131",
  state: "OPEN", base: "main", head: "feat/inbox-grouping", sha: "abc", additions: 412, deletions: 88,
  created: "2026-10-06T12:00:00Z", merged_at: "", checks: [], passed: 0, failed: 0, running: 0, total: 0,
  decision: "", requested: [], reviews: [], review: null, status: "ready", draft: false,
};
const pr = (o: Partial<PrInfo>): PrInfo => ({ ...base, ...o });

// --- sheet C ------------------------------------------------------------------
ok(chipLabel(pr({ status: "running", passed: 2, total: 5 })).text === "2/5" && chipLabel(pr({ status: "running" })).spin, "RUNNING: finished out of total, with the ring");
ok(chipLabel(pr({ status: "failing", failed: 1 })).text === "✕ 1 FAILING", "FAILING counts the red checks");
ok(chipLabel(pr({ status: "review", passed: 5, total: 5 })).text === "✓ 5/5 · REVIEW", "GREEN/REVIEW");
ok(chipLabel(pr({ status: "review" })).text === "REVIEW", "no CI: REVIEW without a 0/0");
ok(chipLabel(pr({ status: "review", draft: true, passed: 5, total: 5 })).text === "✓ 5/5 · DRAFT" && stateLine(pr({ status: "review", draft: true })) === "DRAFT", "a draft says DRAFT, never READY");
const changes = pr({
  status: "changes",
  review: { by: "mahdi", at: "2026-10-06T12:30:00Z", body: "", comments: [
    { path: "backend/src/group.service.ts", line: 45, body: "sort by client name — the order jumps between loads" },
    { path: "frontend/inbox.tsx", line: 88, body: "show the client's name here, not the id" }] },
});
ok(chipLabel(changes).text === "◆ 2 COMMENTS", "CHANGES REQUESTED counts the comments");
ok(chipLabel(pr({ status: "changes", review: { by: "m", at: "", body: "", comments: [] } })).text === "◆ CHANGES", "a bare changes-requested still says so");
ok(chipLabel(pr({ status: "ready" })).text === "✓ READY" && chipLabel(pr({ status: "merged" })).text === "MERGED", "READY and MERGED");
ok(stateLine(pr({ state: "MERGED", status: "merged" })) === "MERGED INTO MAIN" && stateLine(changes) === "CHANGES REQUESTED" && stateLine(pr({ status: "failing" })) === "OPEN", "popover state words");

// --- durations (sheet B) ------------------------------------------------------
ok(duration("2026-10-06T12:00:00Z", "2026-10-06T12:02:14Z", 0) === "2m 14s", "2m 14s");
ok(duration("2026-10-06T12:00:00Z", "2026-10-06T12:00:48Z", 0) === "48s", "48s");
ok(duration("2026-10-06T12:00:00Z", "2026-10-06T12:01:02Z", 0) === "1m 02s", "seconds pad under a minute count");
ok(duration("2026-10-06T12:00:00Z", "", Date.parse("2026-10-06T12:03:05Z")) === "3m 05s…", "a running check ticks with …");
ok(duration("", "", 0) === "", "a commit status has no duration");

// --- what the buttons send ----------------------------------------------------
const red = pr({
  status: "failing", failed: 1,
  checks: [{ name: "backend", workflow: "CI", state: "fail", url: "https://github.com/acme/r/actions/runs/9/job/7", started: "", completed: "", log: "FAIL x.spec.ts\n##[error]Process completed with exit code 1." },
           { name: "lint", workflow: "CI", state: "pass", url: "", started: "", completed: "" }],
});
ok(failureMessage(red) === [
  "Checks failed on PR #131 · ⎇ feat/inbox-grouping (1): https://github.com/acme/r/pull/131",
  "",
  "backend — https://github.com/acme/r/actions/runs/9/job/7",
  "```",
  "FAIL x.spec.ts",
  "##[error]Process completed with exit code 1.",
  "```",
].join("\n"), "SEND FAILURE: the PR, the failing check and its log, nothing about the green ones");
ok(failureMessage(pr({ checks: [{ name: "vercel", workflow: "", state: "fail", url: "", started: "", completed: "" }] })).endsWith("vercel\n(no log here, open the link)"), "a check with no log says so");
ok(commentsMessage(changes) === [
  "Changes requested by mahdi on PR #131 · ⎇ feat/inbox-grouping (2): https://github.com/acme/r/pull/131",
  "backend/src/group.service.ts:45",
  "  sort by client name — the order jumps between loads",
  "frontend/inbox.tsx:88",
  "  show the client's name here, not the id",
].join("\n"), "SEND 2 COMMENTS: one message, sheet A's shape");
const withBody = pr({ review: { by: "m", at: "", body: "two things", comments: [{ path: "a.ts", line: null, body: "x" }] } });
ok(reviewItems(withBody).length === 2 && commentsMessage(withBody).includes("\n  two things\na.ts\n  x"), "the review's own words lead, and an outdated comment cites no line");

// --- bell ---------------------------------------------------------------------
ok(pingText(red, "failing:abc") === "PR #131 · 1 check failing — backend", "the bell names the red check");
ok(pingText(changes, "changes:mahdi:t") === "PR #131 · changes requested by mahdi", "and who asked for changes");
ok(freshPings(["failing:a"], ["failing:a", "changes:m:t"]).join() === "changes:m:t", "only alerts this browser hasn't shown ring the bell");
ok(freshPings(["failing:a"], []).length === 0, "an alert that cleared rings nothing");

// --- where the popover opens --------------------------------------------------
const below = popPlace({ top: 32, bottom: 44 }, 700);
ok(below.top === 52 && below.bottom === undefined && below.maxHeight === 632, "a chip in the header opens the popover under it, down to the window's edge");
const above = popPlace({ top: 597, bottom: 609 }, 700);
ok(above.bottom === 111 && above.top === undefined && above.maxHeight === 581, "COMPACT's chip, down in the composer, opens it over the chip instead of into the strip below");

console.log("\nall prchip checks passed");
