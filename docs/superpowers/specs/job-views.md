# Job views — every Rivendell job's answer drawn as what it is

Only the newspaper had a layout; every other job's answer showed as text, and the JSON ones
(video, meeting notes, briefs) as an unreadable blob. Now each kind is drawn as the artifact it is,
on the newspaper's sheet (`.paper`), with one signature element each. Approved from the
`/design-first` drafts (Claude Design `drafts/job-views/`) on 2026-10-20.

| Kind | Answer (Rivendell main f4a3b169) | View |
|---|---|---|
| BRIEF | JSON `{lead, sections[done/progress/next/ask], projects[]}` | date tile + countdown, the lead, DONE / IN PROGRESS / COMING NEXT boxes, TO ASK <client> as question bubbles; several projects as blocks |
| SUMMARY | 3–6 markdown bullets | a two-colour spine: MOVED FORWARD over NEEDS ATTENTION (split by trouble words — a shortcut) |
| MEETING NOTES | JSON `{notes (## Summary/topics/## Decisions), actionItems[]}` | minutes: topics, stamped decisions, action items with owners |
| REVIEW | free markdown | a verdict stamp only when the review states one; numbered findings with file chips and a FIX row |
| IMPLEMENT | markdown summary | the PR as a ticket stub, a batch's tasks done/skipped, the open questions |
| TASK DESC | markdown, fixed `##` sections | a ticket with the key on a punched tab; acceptance criteria as boxes |
| CHANGELOG | markdown `## <version> — <date>`, `### Added/Changed/Fixed…` | the version set huge, colour-coded groups, BREAKING first, refs as chips |
| VIDEO | TRANSCRIBE JSON / ASK markdown | a chapter reel with the real screens; ASK: the question as a bubble, m:ss as timecode chips |
| NEWS | JSON | unchanged |

Not drawn: TODOLIST and its RECOMMEND/TODO_ITEM steps (the todolist is moving into task management),
and DECK (no Rivendell job sends one).

Rules:
- A view shows only what the answer, the job's facts or Rivendell's prompt (turn 1) hold; what only
  Rivendell's server adds (client names, deploy badges, counts) stays out.
- A parser that can't read the answer gives no view, and the box keeps the markdown (`lib/jobviews.ts`).
- Only the job's own answer gets the view; follow-up turns render as usual, and the prose ask-back bar
  stays off a view (an open question in a task is for its readers).
- Theme tokens only, so every theme family recolours the views.
- The brief's date and countdown come from `job.starts` (rivendell_jobs.facts keeps `meeting.startsAt`).
