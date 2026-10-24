# Usage on the right rail

**Ask (2026-10-24, /design-first):** move usage from the left to the right sidebar, with a better UI and
better features. Approved: the USAGE tab (A), plus the pace line, tap a day + copy as timesheet + stopped
turns, and worktrees folded into their repo. Not taken: the low-limit badge on the rail. Draft:
`drafts/usage-rail/` in the linked Claude Design project.

## What moved
- The week report used to hang off a bar-chart icon at the end of the brand cap (`Brand` → `ReportButton` →
  `WeekPanel`) as a popover over the sessions list. Both are gone. The clock menu's row now reads *Usage* and
  opens the tab (`rightTab: "usage"`).
- The composer's PROFILE chip keeps its reading. It is the profile picker, about this chat's login.

## The tab (`hud/UsagePanel.tsx`, `lib/week.ts`)
Built from the GIT tab's parts (`.gp` root, `.gp-ro` readout, `.gp-fold` folds), so every family draws it.
The new CSS is `.us-*`, after the GIT TAB block in `index.css`.
- **Limits** for the login this chat spends (`spendingSlot`): 5-hour, week and each model's own weekly cap,
  each as % left with a fuel line along the cell's foot. Amber at ≤25% left or a non-normal severity, red at
  ≤10% or critical. Under the cells, both refills as a clock time (12H-aware) and a countdown.
- **Pace** (`accounts.meter` → `runs_out_at`): `usage.py` keeps the last hour of each login's 5-hour readings,
  the ones `get_usage()` already makes. `_pace()` draws a line from the oldest reading to the newest. It
  needs at least 10 minutes of readings, and only reports a time that comes before the refill. The panel
  adds what happens then, from the session's `fallback_policy` or the bridge default (`ask`/`auto`/`wait`).
  Readings exist only while something polls the meter, which in practice means an open dashboard.
- **Logins:** every account with 5H/WK meters, or the reason it has none. Hidden with a single login.
- **This / last week:** agent time, turns and sessions; the change against the week before; and a day strip.
  Tapping a day turns the readout into that day (agent time, turns, % of the week). Today comes from `days`,
  not `/local/today`.
- **Projects:** `ProjectTile`, `projectName`, time and share, with worktrees listed under their repo. A row
  opens the project. The copy icon puts the week on the clipboard as a markdown table.
- **Stopped turns:** `report.failures` by outcome, without `delivered`, since that answer reached you.
- **Tokens:** four plain figures.

## Worktrees fold into their repo (`report._fold_worktrees`)
A session started in `<BASE>/.worktrees/<repo>/<branch>` used to be a project of its own. Its numbers now
count toward the one project this week whose folder name is `<repo>`, and it is listed under that project
as `worktrees`. By the time a week is read, most of those folders have been deleted, so the match goes by
name, not by git. Ambiguous names, or a repo with no turns of its own that week, stay as separate rows
(a `shortcut:` comment marks this). The Telegram `/report` and the Monday push get the folded rows too.

## Not done
The Mini App has no week panel and got none. The weekly notice doesn't open the tab.
