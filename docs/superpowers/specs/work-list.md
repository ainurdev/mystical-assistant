# Work: tasks and their flows

A project keeps a list of tasks: what you want done, and in which order. Agents fill and change
it when you ask, from wherever you name. A task is built by a flow: its Start opens a session of
its own on BUILD, FIX or DESIGN, which may split it into parts, and the WORK panel shows where
each task's flow stands, live. Until 2026-11-17 a run (a manager agent with helpers) built the
list instead; it overlapped the flows' parts and was retired (docs/adr/0004).

## Why not the existing pieces

- `/goal` is one objective per chat, and it loops one session whose context fills up. It stays
  as it is, for that job. The list is a different thing with a different name.
- A kanban board where dragging a card starts an agent was folded in here: the sidebar's
  groups are that board, and starting is one explicit act rather than a side effect of a drag.
- Mystical doesn't sync with Jira, Linear or Rivendell. An agent reads them with whichever tools
  it has and writes the list. A new tracker needs no code, and nothing changes behind your back.

## The list

It belongs to the project, in `.mystical/worklist.json` at the main checkout, so every chat and
worktree of a repo sees one list and it outlives any chat. An item is a title, a detail, an
optional source (`kind`, `ref`, `url`), dependencies, a state and a note.

States: `todo`, `doing`, `review`, `blocked`, `done`, `dropped`. A started task's state is its
flow's: spec, parts or build `doing`; parts waiting for approval or one needing a fix `blocked`;
merging or the council's review `review`; the flow's end `done`. It is read live for the panel
and written back at every turn's end.

Agents use one tool, `work_list`, with `read`, `add`, `update`, `remove`, `replace` and
`reorder`. `replace` is "create it anew": items it names by id or source ref keep their state,
unnamed open items go, and finished ones stay unless told otherwise. Helpers don't get it.

## The panel

One row per task, grouped Needs you, Building, Up next and Done (folded). Line 1 is a state dot,
the title and a bar per part with n/m; line 2 what it does now, or the question one of its sessions
asks, in amber with Answer. A started row opens its session. Refining, editing and adding each take over the panel instead of expanding in it, so the mode is
never in doubt and the panel stays the only scroller. That last part isn't taste: WebKitGTK, the
Linux window's engine, holds a whole wheel gesture on a box that scrolls, even at its end.

## Refining

A task nobody has started has a Refine button. You give ideas, corrections and questions, and an
agent that can read the project asks back or suggests a new title and detail, with the differences
marked. Nothing changes until you press Use this.

Each message is a one-shot in plan mode, with the conversation kept on the item (`workrefine.py`).
It isn't a chat, so it adds nothing to yours and can run while yours is busy. A tracker's text can
reach it, so it can read and nothing else.

## This chat's plan

Beside the project's list, the open chat's plan: the steps its agent set itself, as a timeline with
times, the agent's note on each, Markdown descriptions and sub-steps. Agents write it with `chat_plan`;
a Claude chat's built-in task list and an ACP agent's plan updates are mirrored in as plain steps, and
never over a plan written with the tool.

The agent owns its plan, so changing a step, asking about it, doing it sooner, skipping it or changing
the whole plan reaches it as a message from you, pending until it next writes the plan. Copying a step
to the work list is yours alone. Kept per chat in `.mystical/plans/` (`bridge/chatplan.py`).

## Starting a task

Only you start one, from ▸ Start on its row: no agent tool can, because a tracker's text must not
be able to set work going. Start opens under the row with the flow guessed from the task (a bug
reads as FIX) and the branch it will get, `feat/` or `fix/` and the title. Starting makes a session
named for the task, on that branch (FIX gets its worktree at once, as its first step already fixes),
and sends the task's title and detail as the flow's first prompt.

- A task's one part starts without the approval more parts wait for: its Start was the approval.
- A task after another (`depends_on`) can be started early: it is armed, reads `after w15`, and
  starts when that one is done. A dependency alone never starts anything.
- Every part's final reply ends with Decisions and Not verified, and the merge session runs the
  tests before and after merging and says what changed: the two things the run gave you that a
  task still needs.

## Spin-offs: tasks another chat found

A chat whose work turned up work it isn't doing (issues for other projects, a list of separate
items) offers them with `spin_off`: a card under its reply, one row per item or cause, each placed
on a project by its folder, remote or name (bridge/spinoffs.py; ADR 0007). START files each ticked
row as a task on its own project's list and starts it there; PARK files it unstarted. The task
carries `from` (the chat and the source keys), so its session links back, and a row's `after`
becomes a blocker in another project's list: that one's end starts it (`then`, sync). A source
already on a list is a repeat and links there. Telegram and the Mini App get one line with Start
all, which never clones.

## Not built

- Writing back to trackers on its own. An agent can, when you ask.
- Rewind and fork, which were split off and dropped.
