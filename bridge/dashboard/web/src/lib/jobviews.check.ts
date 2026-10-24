// Run: node bridge/dashboard/web/src/lib/jobviews.check.ts
import { branchesOf, clockMs, clockOf, otherSide, parseBrief, parseChangelog, parseConflict, parseImpl, parseNotes, parseReview, parseSummary,
  parseTaskDesc, parseVideo, questionOf, withTimecodes } from "./jobviews.ts";

const eq = (a: unknown, b: unknown, msg: string) => console.assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)}`);

eq(clockMs("4:05"), 245000, "m:ss"); eq(clockMs("1:02:03"), 3723000, "h:mm:ss"); console.assert(Number.isNaN(clockMs("soon")), "not a clock");
eq(clockOf(755000), "12:35", "back to m:ss"); eq(clockOf(3725000), "1:02:05", "back to h:mm:ss");

// BRIEF — brief-page.test.tsx's stored shape, as the model writes it.
const brief = parseBrief('{"lead": "A good week for sign-in.", "sections": [' +
  '{"kind": "progress", "items": [{"text": "The consent step waits for wording.", "who": "Mahdi", "refs": ["[HHP-36]"]}]},' +
  '{"kind": "done", "items": [{"text": "Staff sign in.", "who": "null", "refs": ["HHP-31", "#58"]}, {"text": "", "who": null}]},' +
  '{"kind": "gossip", "items": [{"text": "x"}]}, {"kind": "ask", "items": []}], "projects": []}');
console.assert(brief !== null, "a brief parses");
eq(brief?.sections.map((s) => s.kind), ["done", "progress"], "Rivendell's order; unknown and empty sections dropped");
eq(brief?.sections[0].items, [{ text: "Staff sign in.", who: null, refs: ["HHP-31", "#58"] }], "who 'null' is nobody; an empty item is dropped");
eq(brief?.sections[1].items[0].refs, ["HHP-36"], "a ref loses its brackets");
console.assert(parseBrief('{"sections": []}') === null, "no lead, no brief");
console.assert(parseBrief("Here is the brief: …") === null, "prose is not a brief");
eq(parseBrief('```json\n{"lead": "L", "projects": [{"name": "Patterna", "items": [{"text": "Live."}]}, {"name": "Quiet", "items": []}]}\n```')?.projects,
  [{ name: "Patterna", items: [{ text: "Live.", who: null, refs: [] }] }], "fenced; several projects; an empty block dropped");
eq(otherSide('"ask" (questions and decisions for Harbor Health, each one a short question or request)'), "Harbor Health", "the client");
eq(otherSide('"ask" (questions and decisions for the others in the meeting, each one a short question)'), "them", "no client: them");

// SUMMARY
const sum = parseSummary("- Mahdi merged the device work.\n- Fixed the checkout crash.\n- The 23:09 deploys are waiting for approval.\n- Sentry flagged a new error.",
  "The period is this week: Mon 13 Oct to Mon 20 Oct (Asia/Dubai).");
eq(sum?.forward.length, 2, "a fix is progress even though it says crash");
eq(sum?.attention, ["The 23:09 deploys are waiting for approval.", "Sentry flagged a new error."], "trouble after the split");
eq(sum?.period, { label: "this week", from: "Mon 13 Oct", to: "Mon 20 Oct" }, "the period from the prompt");
eq(parseSummary("- Shipped the feed\n- Fixed the ribbon")?.attention, [], "all good: one list");
console.assert(parseSummary("Nothing happened this week.") === null, "one plain line stays markdown");
console.assert(parseSummary("Summary:\n- a\n- b") === null, "a preamble breaks the contract: markdown");

// MEETING NOTES — meeting-notes-result.spec.ts
const notes = parseNotes('{"notes": "## Summary\\nWe agreed the plan.\\n\\n## Budget\\n- Cap at 10k.\\n\\n## Decisions\\n- Start in December.\\n- Rates later.",' +
  ' "actionItems": [{"title": "Send the plan", "description": "By Friday.", "ownerName": "Sara Ahmadi", "ownerEmail": "s@x.io"}, {"title": ""}]}');
eq(notes?.summary, "We agreed the plan.", "the summary");
eq(notes?.topics, [{ title: "Budget", body: "- Cap at 10k." }], "topics are the other sections");
eq(notes?.decisions, ["Start in December.", "Rates later."], "decisions as bullets");
eq(notes?.actions, [{ title: "Send the plan", description: "By Friday.", owner: "Sara Ahmadi" }], "an untitled item is dropped");
console.assert(parseNotes('{"actionItems": []}') === null, "no notes, no view");

// VIDEO — video-result.spec.ts's answer, with the bridge's SCREENS list in the prompt
const prompt = "File: Contract.mov (13:40). Spoken language: nl.\n\nScreens:\n1. 0:41 — /u/.bridge_uploads/videos/r1/screens/1.jpg\n2. 12:00 — /u/.bridge_uploads/videos/r1/screens/2.jpg\n";
const vid = parseVideo('{"summary": "Furkan walks through the student card.", "chapters": [{"timeMs": 25000, "title": "Searching"}, {"timeMs": 0, "title": "Intro"}, {"timeMs": "x", "title": "bad"}],' +
  ' "keyPoints": ["Every student has three ids.", ""], "screens": [{"index": 1, "caption": "Home"}, {"index": 2, "caption": null}, {"index": 1.5}]}', prompt);
eq(vid?.chapters, [{ ms: 0, title: "Intro" }, { ms: 25000, title: "Searching" }], "sorted, bad ones dropped");
eq(vid?.keyPoints, ["Every student has three ids."], "empty points dropped");
eq(vid?.screens, [{ index: 1, caption: "Home", ms: 41000, path: "/u/.bridge_uploads/videos/r1/screens/1.jpg" },
  { index: 2, caption: "", ms: 720000, path: "/u/.bridge_uploads/videos/r1/screens/2.jpg" }], "screens get their moment and picture");
eq(vid?.length, 820000, "the length from the File line");
eq(parseVideo('{"summary": "s"}', "File: a.mov (length unknown). Spoken language: English.\n\nTranscript (m:ss  text):\n0:00  Hi.\n12:41  Bye.\n")?.length,
  761000, "no length said: the last transcript line");
console.assert(parseVideo('{"keyPoints": ["x"]}') === null, "no summary and no chapters: markdown");
eq(questionOf("Screens:\n(none)\n\nQuestion:\nWhich fields matter?\nAnd why?\n\nAnswer in markdown. Refer to moments as m:ss."), "Which fields matter?\nAnd why?", "the question");
eq(withTimecodes("At 2:20 and 1:02:03, not `4:05` or [7:59](http://x) or 10:30am or v1:2"),
  "At [2:20](#t=140) and [1:02:03](#t=3723), not `4:05` or [7:59](http://x) or 10:30am or v1:2", "moments become chips; code and links don't");

// REVIEW — the shape of a real one (7ac309f9)
const review = parseReview(`# Review: Cursistkaart on the record page standard (#3)

**Verdict: approve with changes.** The structure is good.

I checked out \`pr3\` and ran \`npm test\`.

## Correctness

1. **Logging any "done" call closes someone else's open call.** \`src/routes/contacts.$id.tsx:195-204\` and \`src/data/api.ts\` \`logCall\`
   - \`closes\` is set for every outcome.
   - **Fix:** only close a picked call.

2. **The "Volgende termijn" fact is wrong.** \`contacts.$id.tsx:300-305\`
   - It also matches open terms.

## Nits

The help text repeats itself.`);
eq(review?.verdict, { text: "approve with changes", tone: "warn" }, "the stated verdict");
eq(review?.intro, "The structure is good.\n\nI checked out `pr3` and ran `npm test`.", "the intro keeps the verdict line's rest");
eq(review?.groups.map((g) => [g.title, g.findings.length, g.body]), [["Correctness", 2, ""], ["Nits", 0, "The help text repeats itself."]], "sections");
eq(review?.groups[0].findings[0], { n: 1, title: 'Logging any "done" call closes someone else\'s open call',
  refs: ["src/routes/contacts.$id.tsx:195-204", "src/data/api.ts", "logCall"], body: "- `closes` is set for every outcome.", fix: "only close a picked call." }, "a finding");
eq(parseReview("**Verdict:** request changes. Bad.\n\n1. **Leak.** `a.ts:3`")?.verdict, { text: "request changes", tone: "err" }, "the other verdict spelling");
const prose = parseReview("1. **Raw key.** In `api.ts` `updateStudent`, the line breaks.\n2. **Overwrite.** `details.tsx:574`: the form saves it.\n3. **Gate.** `access.ts:13` defines it.");
eq(prose?.groups[0].findings.map((f) => [f.refs, f.body]), [[[], "In `api.ts` `updateStudent`, the line breaks."], [["details.tsx:574"], "the form saves it."],
  [[], "`access.ts:13` defines it."]], "a sentence after the title is kept; only refs that open the line become chips");
console.assert(parseReview("Looks good to me. Ship it.") === null, "no numbered finding: markdown");
eq(parseReview("1. **Only one.** `x.ts`")?.verdict, null, "no verdict, no stamp");

// IMPLEMENT — a batch summary, and the real single-task one's shape (bad9479f)
const batch = parseImpl(`Branch \`batch/review-auto\`, PR https://github.com/ainurhq/rivendell/pull/72.

- [TW-50776561] Create the webhook — done
- TW-50776570 Retry a failed review: skipped (needs the queue change first)

Webhooks now save PRs at once.

**Open questions:**
- Never tried with a real delivery.
- Two reviews could race.

That's all.`, "ainurhq/rivendell");
eq(batch?.pr, { url: "https://github.com/ainurhq/rivendell/pull/72", repo: "ainurhq/rivendell", number: 72 }, "the PR");
eq(batch?.branch, "batch/review-auto", "the branch");
eq(batch?.tasks, [{ key: "TW-50776561", name: "Create the webhook", done: true, why: "" },
  { key: "TW-50776570", name: "Retry a failed review", done: false, why: "needs the queue change first" }], "task lines");
eq(batch?.open, ["Never tried with a real delivery.", "Two reviews could race."], "open questions");
console.assert(batch?.body.includes("Webhooks now save PRs at once.") && batch.body.includes("That's all.") && !batch.body.includes("TW-50776570"), "the rest stays the body");
const single = parseImpl("- **Branch:** `batch/unorganized` (pushed)\n- **Pull request:** https://github.com/ainurhq/rivendell/pull/72, open\n- **Commit:** `64ea6b6 [TW-50776561] Create webhook`", "ainurhq/rivendell");
eq([single?.branch, single?.tasks.length], ["batch/unorganized", 0], "a commit line naming a task isn't a task line");
console.assert(parseImpl("I couldn't finish: the tests fail.") === null, "no PR and no tasks: markdown");

// TASK DESCRIPTION
const td = parseTaskDesc("## Context\nThe gate is shut.\n\n## Goal\nOpen it.\n\n## Scope\n- Add a switch.\n\n## Acceptance criteria\n- [ ] It opens.\n- [ ] It stays open.\n\n## Open questions\n- Who holds the key?");
eq([td?.context, td?.goal, td?.scope, td?.criteria, td?.out, td?.questions], ["The gate is shut.", "Open it.", ["Add a switch."], ["It opens.", "It stays open."], [], ["Who holds the key?"]], "the sections");
console.assert(parseTaskDesc("## Goal\nOpen it.") === null, "one section isn't the template");

// CHANGELOG — Elvou 1.4 (docs/screenshots/changelog-generator)
const cl = parseChangelog(`## 1.4 — 2026-09-27

Elvou 1.4 introduces Elvou Breathe.

### Added
- Premium members can open Elvou Breathe. ([#1](https://g/1), [\`b4e97f9\`](https://g/c), [Breathing tool](https://tw/9))
- The app has memory support. (#10)

### Changed
- Lists load faster (two at most).
- **Breaking:** Sign-in needs app 1.3. ([#8](https://g/8))`);
eq([cl?.version, cl?.date, cl?.summary], ["1.4", "2026-09-27", "Elvou 1.4 introduces Elvou Breathe."], "the head");
eq(cl?.groups[0].entries[0], { text: "Premium members can open Elvou Breathe.", breaking: false,
  refs: [{ label: "#1", url: "https://g/1" }, { label: "b4e97f9", url: "https://g/c" }, { label: "Breathing tool", url: "https://tw/9" }] }, "refs off the end");
eq(cl?.groups[0].entries[1].refs, [{ label: "#10" }], "a bare PR number");
eq(cl?.groups[1].entries.map((e) => [e.breaking, e.text]), [[true, "Sign-in needs app 1.3."], [false, "Lists load faster (two at most)."]], "breaking leads; prose in parentheses stays");
eq(parseChangelog("## Unreleased\n\n### Fixed\n- A thing.")?.version, "Unreleased", "no date");
console.assert(parseChangelog("Here are the notes.") === null, "no version line: markdown");
console.log("jobviews checks ran");

// CONFLICTS — the report the conflicts prompt asks for: a few sentences, then a ```json block.
const cf = parseConflict('Merged main in; two files conflicted over the date helpers.\n```json\n{"outcome": "resolved", "files": [{"path": "a.ts", "how": "kept both"}, {"path": "", "how": "x"}], "tests": {"command": "pnpm test", "passed": true, "summary": "1211 passed"}, "commit": "1a2b3c4d5e", "notes": ""}\n```');
eq(cf?.outcome, "resolved", "a resolved report parses");
eq(cf?.summary, "Merged main in; two files conflicted over the date helpers.", "the prose before the block is the summary");
eq(cf?.files, [{ path: "a.ts", how: "kept both" }], "a file with no path is dropped");
eq(cf?.tests, { command: "pnpm test", passed: true, summary: "1211 passed" }, "the tests line");
eq(cf?.commit, "1a2b3c4d5e", "the pushed commit");
eq(parseConflict('```json\n{"outcome": "stopped", "files": [], "tests": null, "commit": null, "notes": "Both sides rewrote formatDay."}\n```'),
  { summary: "", outcome: "stopped", files: [], tests: null, commit: null, notes: "Both sides rewrote formatDay." }, "stopped: why, no tests, no commit");
console.assert(parseConflict("I merged it, all good.") === null, "prose alone is no report");
console.assert(parseConflict('{"outcome": "maybe"}') === null, "an outcome Rivendell doesn't know is no report");
eq(branchesOf("Repository: a/b\nBranch: fix/railway-project-hydration, which conflicts with main\n"), { head: "fix/railway-project-hydration", base: "main" }, "the branches, from the prompt");
eq(branchesOf("no branches here"), null, "no branch line, no branches");
