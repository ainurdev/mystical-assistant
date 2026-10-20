# Rivendell: the task question waits for the push

Follows [rivendell-unplanned-tasks](rivendell-unplanned-tasks.md), which ties
every piece of work in a repo on a Rivendell board to a task, and files an
`unplanned` one, after asking, when none covers it. Approved by the user on
2026-10-20 through /design-first, as "All three": ask at the push, the push
gate, the styled card and the task tab. The mockups are in
`.mystical/design-drafts/rivendell-task-check/` and in Claude Design under
`drafts/rivendell-task-check/`.

## Why

The first version asked at the start of the work. The card stopped the turn
before any code changed, which was usually while the user was away. Its title
was a guess from a one-line prompt. Work that was never pushed still asked. The
ask also depended on the model remembering the note: nothing checked the push
itself.

## What changes

1. **The question waits for the push.** At the start, the session still reads
   the board (ListRivendellTasks). If a task covers the work, it carries the
   key without asking. If none does, it does the work. It asks once, right
   before the first `git push` or `gh pr create` of work that carries no key,
   with an AskUserQuestion card whose header is `Task`. The card is drafted
   from the diff. Its options are:
   - `Create “<title>”`
   - `It's <KEY> <title>`, only when an open task may cover the work
   - `Not a task`

   The suggestion comes first and is marked `(Recommended)`. Not a task is the
   suggestion for a tiny change, the open task when it likely covers the work,
   and Create otherwise. On Create or It's KEY, a branch that was never pushed
   is renamed to carry the key, and the key goes in the PR title. The note's
   text is `runner._RIVENDELL_NOTE`.
2. **A push gate.** Every run that carries the note also gets `--settings`
   with a PreToolUse hook on Bash. The hook is `bridge/taskcheck.py`, run as a
   script under `-I`. Given the repo id (its git common dir, which linked
   worktrees share) and the board's key prefixes, it holds back a push from
   that repo whose branch, unpushed commits and command all lack a key. It
   holds each branch once: exit 2, with words that send Claude to the card.
   The retry passes, so a Not a task answer never loops and a misfire costs
   one retry. It ignores deletes and tag pushes, and pushes from other repos.
   Verified against the real CLI on 2026-10-20: the first push was held, the
   retry went through, and the branch was recorded as `asked`.
3. **Answers are kept per branch** in the checkout's `.mystical/tasks.json`,
   which maps a branch to `asked`, `skip` or a key. A task card's answer is
   recorded by `Job.respond`, so an answer from any surface counts. A create is
   recorded by `rivendell.work_create`, and the tab's NOT A TASK by
   `POST /local/rivendell/taskstate`. A file instead of bridge memory: the hook
   is a separate process with no bridge to ask, and a restart forgets nothing.
4. **The styled card.** The dashboard's QuestionCard dresses a `Task` question:
   - the eyebrow reads `● NEEDS YOUR ANSWER · RIVENDELL TASK`;
   - the board's mark tile sits beside the question;
   - a `⎇` line shows the branch, commits and shortstat, with +/− coloured;
   - keys show as chips;
   - `(Recommended)` becomes a SUGGESTED tag, and that option is picked
     before the user touches anything;
   - the button names the outcome: *Create task & push*, *Link NRA-51 & push*
     or *Push without a task* (without "& push" when the card comes early).

   Display only: the labels go back exactly as asked. The Mini App and the bot
   show the plain card.
5. **The task tab.** `TaskChip` sits after the branch in the prompt box's
   caption, and `TaskLine` sits above PUBLISH in the GIT tab. Both read
   `GET /local/rivendell/taskstate` (`rivendell.task_state`, from cached
   tasks, so a poll costs a few git calls).
   - **States:** NO TASK (orange mark), the key (violet), NOT A TASK (dim).
     Nothing is drawn off a board, with the RIVENDELL TASKS switch off, or with
     nothing to push.
   - **Menu:** the house ContextMenu offers *Link a task now* (a prompt to the
     session, so the card comes before the push), *Not a task* and *Open the
     board*. A linked tab opens its task in Rivendell.

## Not covered

- Pushes made outside Mystical, from a plain terminal. Writing a git pre-push
  hook into client repos is out of bounds. The tab still shows NO TASK for
  their work.
- Keys in commits made before the card. Rivendell links by the branch and the
  PR, and those carry the key.
- PUBLISH in the GIT tab doesn't ask. The task line sits right above it.
- The Mini App has no task tab. It shows the plain card, which already works
  there.
- `push_dir` splits a command on shell separators before parsing quotes. A
  `--title "a; b"` splits in two, but the push's own segment still parses.
