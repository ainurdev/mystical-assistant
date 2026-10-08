# Review loop: diff notes and PR state, back to the agent (design)

2026-10-06 · approved in chat · picks ★9 and ★10 from
`.mystical/docs/reports/Mystical Assistant feature opportunities.md`

Mockups, all git-ignored drafts:

- `.mystical/design-drafts/review-loop/`: `a-diff-comments.html`,
  `b-pr-chip.html`, `c-pr-states.html` (self-contained). Their editable
  sources are in `src/`. The draft's own `SPEC.md` is the text below.
- Claude Design, in the linked design project, at `drafts/review-loop/`.

The mockups use the STUDIO palette. The build uses the app's CSS variables
(`var(--acc)`, `var(--err)`, `var(--purple)`…) and its inline-style idiom.

## Intent

Reviewing a change should feed straight back to the agent that made it, with
no copy-paste. Notes on diff lines go to the session as one message (A). Once
a PR exists, its checks and review sit in the chat header. A failure or a
review goes back to the agent in one click (B, C).

## Settled by the approval

1. **Merging stays on GitHub.** READY gets no MERGE button. The popover
   links to the PR.
2. **Diff notes are dashboard-only drafts** in localStorage, for each
   worktree and branch. There is no server table, so the Mini App doesn't see
   them.
3. **Review comments are sent all at once.** You don't tick which ones go.
4. **Dashboard only this round.** No Mini App.

## A · Diff notes (Project ▸ GIT)

The mockups call this tab CHANGES. In the app it is labelled GIT, and its key
is `changes`.

- **Where.** The diff panel of `AnalyzeModal` ▸ `ChangesTab`. File rows get
  a `◆N` count.
- **Gutter.** An 18px column left of the line number. Hover shows a `+` with
  an accent fill. Noted lines keep a `◆` in purple. Dragging down the line
  numbers notes a range.
- **Editor.** Inline under the anchor line. ⌘↵ adds and Esc cancels. Saved
  notes render as purple-edged threads with EDIT · ✕.
- **Send bar.** Pinned to the diff panel's foot once a note exists. It shows
  the count, the target session, CLEAR, and SEND TO AGENT. The target is the
  open session on this branch. ▾ lists the branch's other sessions, plus "new
  session here".
- **Nothing sends on its own.** Notes stay on the diff while you read the
  rest of the change. CLEAR drops them. They only leave on SEND.
- **Message.** One user message, one turn. If the session is mid-turn, the
  message goes through the existing session queue and runs after the turn. Its
  format (sheet A):

  ```
  Review notes on ⎇ feat/inbox-grouping (3):
  backend/src/inbox/group.service.ts:36-37
    flatten these two ifs — const key = item.meeting?.clientId; if (!key) continue;
  backend/src/inbox/group.service.ts:45
    sort groups by client name so the inbox order stays stable
  frontend/src/routes/inbox.tsx:88
    show the client's name here, not its id
  ```

  The line numbers are the working tree's at the moment you press SEND.
- **Storage.** Notes are drafts for each worktree and branch. They stay in
  the dashboard's localStorage until they are sent or cleared. ponytail: no
  server table. Add one if the Mini App ever needs the notes.

## B · PR chip (chat header, caption row)

- **The chip.** It is shown only when the session's branch has a PR. It sits
  in the nameplate's caption row, after the branch, so the header stays one
  height. Its colour says which state the PR is in (C). Clicking it opens the
  popover.
- **Data.** `gh pr view <branch> --json
  number,title,state,url,baseRefName,additions,deletions,statusCheckRollup,reviewDecision,reviewRequests,latestReviews`.
  The failing log comes from `gh run view <id> --log-failed`, tailed to about
  60 lines.
- **Polling.** Every 60s while the session is open in a visible tab, on
  focus, and after a dashboard push. There is one server-side cache for each
  (repo, branch), so two tabs make one call.
- **Popover.** The PR line comes first: number, state, GITHUB ↗. Then the
  title, head → base, +/− and age. Next comes CHECKS: each check's name,
  state and duration, plus the failing step's last lines. SEND FAILURE TO
  AGENT sits under the checks. REVIEW is last. The footer reads "CHECKED
  EVERY 60S WHILE THE SESSION IS OPEN · VIA gh".
- **The failure, not the whole log.** SEND FAILURE TO AGENT sends the check
  name, the PR and about 60 lines of that log, as one message.
- **Pings.** Checks turning red ping the bell and Telegram, and so does a
  review that requests changes. Each pings once per head commit. The next
  green run clears it.

## C · States

| Chip | State | Next |
|------|-------|------|
| `⇡ #131 ◌ 2/5` | RUNNING | Checks finished out of total. Nothing to do yet. |
| `⇡ #131 ✕ 1 FAILING` | FAILING | The popover offers SEND FAILURE TO AGENT. Pings once. |
| `⇡ #131 ✓ 5/5 · REVIEW` | GREEN / REVIEW | Green, waiting on a reviewer. Shows who was asked. |
| `⇡ #131 ◆ 2 COMMENTS` | CHANGES REQUESTED | The popover lists the comments, with SEND 2 COMMENTS TO AGENT. |
| `⇡ #131 ✓ READY` | READY (filled) | Approved and green. Merging stays on GitHub. The popover links there. |
| `⇡ #131 MERGED` | MERGED | Offers ARCHIVE SESSION and REMOVE WORKTREE. Each asks first. |
| `⇡ #131 CLOSED` | CLOSED | Closed without merging. Stays quiet. |
| (no chip) | no PR | OPEN PR stays where it is, in Project ▸ WORKTREES. |

Nothing is archived or removed on its own.

## Tokens

`--err` FAILING · `--warn` review comments · `--ok` green and READY (READY
filled) · `--purple` notes and MERGED · `--acc` running and the gutter `+`.
Chip type is 9px with .6px tracking, the same as the caption row.

## Not in this round

- PR state on the sessions panel's rows (report item #11, the natural next
  step).
- The Mini App.
- Merging from the dashboard.
