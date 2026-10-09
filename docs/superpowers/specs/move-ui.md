# MOVE: export and import from the dashboard

Asked 2026-10-09: "add ui for export and import with proper and minimizable
progress bar for each action with full customize". Customize means both what
moves and how the bar looks. Dashboard only: no Mini App, no bot command. The
design was approved from mockups (`.mystical/design-drafts/move-import-export/`,
not in git). `mystical export` and `mystical import` (bridge/move.py) are
unchanged; this puts the same work behind a tab.

## What the user gets

- **Settings ▸ MOVE** (THE WORK, after SYSTEM), with three pages under one strip:
  - **EXPORT**: six groups (repos, MCP servers, plugins, Claude Code, history,
    bridge). Each group has a tri-state box and opens to its items. Repo chips
    say what rides: unpushed commits, uncommitted changes, worktrees, stashes,
    .env files, untracked files, .mystical size. Repos with work no remote has
    come first. A SAVE AS path, then ▸ EXPORT.
  - **IMPORT**: move files found in ~, Downloads, Desktop and
    `<state>/incoming-*`, or a typed path. READ unpacks the file and dry-runs it,
    so every item shows what it would do here (CLONE, ADD, MERGE, ALREADY HERE,
    LEFT BEHIND, PARKED…). Items with nothing to do have no box. ▸ IMPORT applies
    only what is ticked. When it finishes, the page shows the totals, WHAT'S LEFT
    (restart, MCP logins, Rivendell, parked files, delete the file, each with its
    button), and the full report.
  - **PROGRESS**: a live preview, then the bar style (LINE · BLOCKS · ASCII ·
    SWEEP), thickness, an export colour and an import colour (theme tokens
    only), the dock corner, the minimized form (PILL · EDGE · FRAME), which parts
    a card shows, START MINIMIZED, HIDE AFTER SUCCESS and MOTION.
- **The dock** (`MoveDock.tsx`, mounted by App): one card per job, showing the
  overall bar, % and time left, bytes and speed, a row per step, the log tail,
  and CANCEL. – folds a card. A finished card offers RETRY, IMPORT AGAIN, COPY
  PATH or REVIEW, and an import's things-left list. Ending a job raises a toast,
  the OS banner and the NOTIFY sound, through the same channels a finished
  session uses.

## How it works

- `bridge/move.py` gained a `Progress` interface (step, item, tick, line,
  bytes, check) and `Cancelled`, which is a BaseException so the
  one-item-never-sinks-the-rest guards let it through. It also gained `skip`
  refs (`"history"` for a section, `"repos:acme/app"` for one item), `plan()`
  for the EXPORT list, and READ split from IMPORT: `unpack()` and `inspect()`,
  then `apply()`. Dry-run notes carry a `ref`, so each item gets its outcome.
  `next_steps()` is the single source for what's left, used by both the CLI's
  closing lines and the dashboard.
- `bridge/movejob.py` runs one job at a time on a thread. READ unpacks into
  `<state>/move-read/` (0700) once. IMPORT replays that folder and deletes it
  when it succeeds. Finished jobs persist in `<state>/move_jobs.json` until
  dismissed. A job that was running when the bridge stopped comes back failed.
  "Restart the bridge" drops off the list once the bridge has booted since the
  import.
- Routes, dashboard only: GET `/local/move/{plan,files,jobs,read}`, and POST
  `/local/move/{export,read,import,cancel,dismiss,forget,delete}`. Delete only
  takes a `mystical-move-*.tar.gz`. A bridge older than the bundle answers 404,
  and the page says to restart it.
- Prefs live in `hud-settings.move` (lib/theme.ts). Folded cards are stored in
  `hud-move-mini`.

## Limits, on purpose

- The overall % weighs steps by fixed shares, and time left is elapsed divided
  by that %, so the card says "about". A cancel lands between files on export
  and between repos on import. It can't interrupt a single `git bundle` or
  `git clone` already running.
- After a failed or cancelled import, the list still shows the original dry
  run. READ again to refresh it.
- Left out: the Mini App and bot, browser upload (the file is already on this
  disk), compression choice, custom hex colours, a size estimate before export
  (bundle sizes aren't known until built), and merging the old bridge.db.
