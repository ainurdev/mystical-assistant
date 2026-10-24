# Changelog v3: a list and a reader, and words that survive a failed summary

The ask (2026-10-24) was "improve changelog". The user went through three rounds of mockups
(the drafts are in `.mystical/design-drafts/changelog-v3/`, git-ignored). They picked B's
list + reader in C1's plain type, made smaller and livelier: **D · C1, alive**. They took all
four additions.

## What was wrong

- **The two newest entries were raw commits.** Both updates on 2026-10-24/25 landed while the
  login was at its session limit. The haiku one-shot failed, so the rows read "25 commits
  pulled" and "2 commits pulled", followed by `docs: …` and `telegram: …`. Nothing ever asked
  again.
- **Headlines ended in "…".** The prompt asks for 40 characters, haiku goes a little over, and
  `_cut(…, 40)` dropped the rest.
- **Older updates were one-line titles behind a chevron.** "Oct 22" repeated four times, and
  you couldn't find a change.

## The words (`bridge/whatsnew.py`)

- **The fallback reads like notes.**
  - `area: text` becomes `Area — text`.
  - A conventional type gives way to its scope: `feat(sidebar): x` becomes `Sidebar — x`, and
    a bare `fix: x` becomes `X`.
  - `docs` / `test` / `chore` / `ci` / `build` / `style` / `note` commits are left out. A SEND
    NOTE commit is its own NOTE row.
  - It takes one per area first, then fills up to five in order.
  - The headline names the areas: "Rivendell updates", "Usage and Git", "Telegram, Sidebar,
    Usage and more". With no areas it stays "N commits pulled".
  - If nothing survives the filter, the bare first clauses come back.
- **A failed summary is asked again.** `updated` rows carry `meta.ai`.
  - `retry()` runs on the hourly `watch()` tick. It takes the newest fallback rows of the last
    week: `ai` false, or a "N commits pulled" row written before the mark.
  - On success it rewrites the row in place (`notices.revise`), so the id, time and read mark
    stay and the row isn't news twice.
  - The first refusal ends the round: a login at its limit refuses every call.
  - It runs only while UPDATE NOTES is on.
- **Places.** The prompt also asks for `go`: one entry per bullet from `PLACES` (8 Settings
  tabs and 5 right-rail tabs), or null.
  - Anything else is dropped.
  - The tags land in `meta.go` on `updated` and `coming` rows, and the boot's reuse of a
    preview carries them over.
- **The headline cap is 64.** The prompt still asks for 40.

## The reader (`ChangelogButton.tsx`, `lib/notices.ts`, `index.css`)

The popover is 540 × 440 (less area than the old 464 × 640), at the same anchor over the
rail's scroll.

- **The list:** days (TODAY, YESTERDAY, OCT 22) on a spine.
  - Each update is a node, sized by its commits (≤3, ≤12, more).
  - An unread one is filled and says NEW. The picked one glows.
  - A waiting update sits on top under COMING, with a dashed node in the update's green.
  - The spine is drawn by each row, so it runs the whole scroll.
- **The reader:**
  - The date, then the headline.
  - Each feature has an icon tile (`iconFor(lead)`: a keyword map with a spark as the
    default), its lead in bold, and **Open ›** when it has a place.
  - Open › dispatches `hud:settings`, or `hud:rail` (new, in App).
  - At the foot: the meta line and ⎇ branch, then **Ask Claude about it** and **Copy notes**.
    Ask Claude goes through `onFeed` (FIX WITH CLAUDE's path) into `/local/changelog`'s
    `project`, which is `selfupdate.project()`.
  - For COMING: the notes, "waiting on ⎇ branch" and **Update now** (`hud:update`).
- **The header:**
  - The last 7 days' commits as bars, today in the accent. A bar jumps to that day's newest
    update.
  - "N commits this week".
  - ⌕ opens Find. Find filters titles and bodies and marks every match in both panes. With no
    match it says "Nothing about “x” in the last N updates."
- **Keys:** ↑ ↓ step through the list (not while writing a note). Esc shuts Find first, then
  the popover. The footer shows "↑ ↓ · i of n".
- **Motion:** the reader fades in on each pick, except with reduced motion.

**Unchanged:**
- the popup out of the icon
- mark-read on close
- the note form
- OS banners
- UPDATE's preview, which still uses `Bullets` / `Meta`

The Mini App has no changelog. Telegram gets the readable fallback for free.
