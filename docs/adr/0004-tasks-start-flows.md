# Tasks start flows; the work run retires

The work list (what to do, and when) had its own builder, the run: a manager agent handing tasks to helpers in worktrees and merging them into a `mystical/work-*` branch. The flows built the same way (split into tickets, build them side by side in worktrees, merge once), so the two overlapped and could fight over one feature. Now each keeps one job: the work list is the backlog, and a task's Start opens a session on a flow, which is the only builder. Tickets became the task's **Parts** in every word the user reads (GLOSSARY: Task, Part); the code keeps `tickets.py` and `.mystical/tickets/`, since /to-tickets writes them. Picked on 2026-11-17 with the WORK panel's A · Rows design.

## Considered Options

- **Keep both, split by size** (not picked): small items to the run, features to flows. Two builders would stay, with two merge stories, and a task would still have to be sorted by hand.

## Consequences

- A one-part task starts without an approval tap; more parts wait for it as before.
- "Up to N at once" is gone: parts have no cap.
- The run's Decisions / Not verified report moved into every part's final reply, and its before-and-after check into the merge session's prompt. Its evidence keeping, Land sheet and `/work run` are gone.
- A run still going when this ships keeps its worktree and branch, but nothing drives it: finish or merge it by hand.
