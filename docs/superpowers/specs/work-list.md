# Work list and runs

A project keeps a list of tasks. Agents fill and change it when you ask, from wherever you
name. When you say go, a manager agent works through it with helpers in their own worktrees,
and the right sidebar shows all of it live.

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

States: `todo`, `doing`, `review`, `blocked`, `done`, `dropped`. The sidebar shows them as up
next, in progress, in review, blocked, done in this chat, not in this run, and already done.

Agents use one tool, `work_list`, with `read`, `add`, `update`, `remove`, `replace` and
`reorder`. `replace` is "create it anew": items it names by id or source ref keep their state,
unnamed open items go, and finished ones stay unless told otherwise. Helpers don't get it.

## The panel

Every task says its state in words, with an icon and a colored edge, and a count bar sits on top.
Refining, editing and adding each take over the panel instead of expanding in it, so the mode is
never in doubt and the panel stays the only scroller. That last part isn't taste: WebKitGTK, the
Linux window's engine, holds a whole wheel gesture on a box that scrolls, even at its end.

## Refining

A task nobody has started has a Refine button. You give ideas, corrections and questions, and an
agent that can read the project asks back or suggests a new title and detail, with the differences
marked. Nothing changes until you press Use this.

Each message is a one-shot in plan mode, with the conversation kept on the item (`workrefine.py`).
It isn't a chat, so it adds nothing to yours and can run while yours is busy. A tracker's text can
reach it, so it can read and nothing else.

## A run

Only you start one: the sidebar's Run, `/work run` in the composer, or `/work run` on Telegram.
No agent tool can, because a tracker's text must not be able to set work going.

```
your branch ──●
               \
run branch      ●───M(w1)───M(w2)───  ← you merge this, or discard it
                 \  /      /
item worktrees    w1      /
                   \     /
                    w2 ─┘             ← later items start from the run branch
```

- **The run branch** is `mystical/work-<id>`, from your folder's last commit, with its own
  worktree. Uncommitted work in your folder isn't in it, and the start says so.
- **Each item** gets a helper in its own worktree, from the run branch as it stands then. Later
  items see earlier work.
- **Merging an item** commits what the helper left and merges into the run branch with
  `--no-ff`, so `git log --first-parent` reads one commit per item. A conflict aborts cleanly
  and the item goes back to its helper, whose copy merges the run branch and resolves it.
- **Your branch doesn't move** until you press Merge, which is a local merge that refuses
  rather than touching uncommitted work. Discard removes the branch and returns its done items
  to the list. Nothing here pushes.

### The manager

The chat's main agent. It holds statuses, not code: it picks the next items, writes briefs,
reads diffs, merges or sends back. Its tool is `work_run`: `status`, `start_item`, `review_item`,
`merge_item`, `send_back`, `block_item`, `restart_item`, `finish`.

Because the state lives in the list, a manager that loses its context or its chat can be picked
up: Resume in another chat moves the run and its helpers there.

### Asking for one in words

An agent can't start a run. If you ask it to, `work_run propose` shows a card naming the tasks and
where the run starts, and only your tap starts it.

### What a run leaves you

- **Reports.** A helper's final reply stays on its task, with its decisions and what it couldn't check
  pulled out. They show on the card and on the Merge screen, and go in the commit.
- **Evidence.** A merge removes the helper's copy, so its screenshots and logs move to
  `.mystical/runs/<run>/<item>` first. Anything that can't be removed is listed on the run.
- **Checks.** The project's check command runs on the starting commit before any helper, so helpers are
  told what already fails, and on the finished branch, compared with that. It never blocks a merge.

### Brakes

- Parallel helpers: 1 to 5, default 2, on top of the chat's own helper limits.
- Helpers are off in a chat, or the chat is read only: the run refuses to start.
- Dependencies: an item can't start until what it depends on is done.
- Nudges replace the goal loop's turn count: a manager that ends a turn with work open and no
  helper running is nudged, and three in a row with no item changing pauses the run and pings
  you. Progress resets it, so a long list isn't cut off at some number of turns.
- A blocked item waits for you and pings you. The others carry on.
- Permissions only narrow, as for any helper.

## Not built

- Writing back to trackers on its own. An agent can, when you ask.
- Rewind and fork, which were split off and dropped.
- Two runs at once in one project. They'd fight over what "the run branch" means.
