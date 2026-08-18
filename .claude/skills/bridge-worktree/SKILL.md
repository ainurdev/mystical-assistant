---
name: bridge-worktree
description: Use when starting a feature, experiment or risky refactor in this repo — anything bigger than a one-file fix. Also when the user says "worktree", "new branch", "work on this in parallel", or when a change adds a table, a column or any new persisted data. Covers where the worktree goes, what is missing inside it, and keeping new data off the live bridge DB.
user-invocable: true
---

# Feature work happens in a worktree

`master` is the checkout the live bridge runs from. Work there and a half-built
feature is one `mystical restart` away from being the thing the user is talking
to. One-file fix or doc tweak: master is fine. Anything else: worktree.

## Create it where the dashboard can see it

```sh
git worktree add -b feat/x ~/projects/.worktrees/mystical-assistant/feat-x
```

**Inside `BASE_PATH` is the load-bearing part** — `_abs_within()` drops any tree
outside `~/projects`, so a worktree in `/tmp` is invisible to every surface and no
session can start in it. Git resolves branch→tree, so a hand-made `git worktree
add` elsewhere under `~/projects` still attaches; `.worktrees/<repo>/<branch>`
(slashes to dashes, `_worktree_path()` in `bridge/dashboard/server.py`) is the
convention that keeps it out of the project browser.

## What isn't in there

`git worktree add` checks out tracked files only, so everything git-ignored is
missing:

- **`.env`** — `cp ~/projects/mystical-assistant/.env <wt>/.env`. Without it
  `bin/mystical` dies on any command except `build`/`doctor`.
- **`node_modules`** — only if you must build web *in* the worktree:
  `cd <wt>/bridge/dashboard/web && npm ci`. Usually you don't; build from master
  at ship time instead.

## New data goes in a scratch DB

`config.BRIDGE_DB` defaults to `~/.bridge_state/bridge.db` — the live bridge's
sessions, turns and events. A worktree that migrates it or writes new-shape rows
damages the thing the user is working in *right now*.

- **Tests need nothing.** `tests/conftest.py` already pins `BRIDGE_DB` to a temp
  file before config is imported.
- **Any manual script or REPL:** `BRIDGE_DB=/tmp/wt-x.db python3 …`. In the
  environment, before the process starts — `bridge/config.py` freezes the value
  at import, so setting it afterwards does nothing.
- **Schema changes** stay in `bridge/store.py`: a line in `_SCHEMA` plus an
  idempotent `ALTER TABLE` in `init()`, like every column already there. Additive
  only — master's code keeps reading that DB.

## Two traps

- **`mystical` on PATH is the *main* checkout.** It's a symlink to
  `mystical-assistant/bin/mystical`, and that script resolves `REPO` from its own
  location. `mystical restart` inside a worktree restarts the live bridge running
  master's code. Say `<wt>/bin/mystical` when you mean the worktree.
- **Worktree code is never live.** It can't be, until it's merged and the bridge
  restarts — see **bridge-ship**. Don't restart anything to "test" it.

## Fold back

```sh
git -C ~/projects/mystical-assistant merge feat/x
git worktree remove ~/projects/.worktrees/mystical-assistant/feat-x
```

Then **bridge-ship**. Abandoned worktrees aren't free: each one is a dirty tree
NEXT UP keeps suggesting and a row in the WORKTREES tab, and each can hold one of
the 8 dev-server slots (`devserver.MAX_SERVERS`).
