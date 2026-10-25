# Go live: the rail button that makes the code on disk the code running

**Ask (2026-10-25, /design-first):** "when we change something and need restart or every step
it need to apply the changes, add button icon above the changelog button for this case so on
clicking it, it will apply the changes to dashboard locally live." Approved: **A · PEEK**, plus
all three add-ons: wait for turns, pop when it lights, sessions point at it. The mockups are in
`.mystical/design-drafts/go-live/`.

## Before

- **Committed wasn't live.** The bridge runs the Python it launched with, and both web apps
  serve whatever `dist/` was last built. A merged change did nothing until someone rebuilt and
  restarted.
- **Sessions asked every time.** "When should I ship it?" came with three options, and the
  sessions built and restarted by hand.
- **Nobody could tell what was served.** On 2026-10-25 it took build-hash forensics to learn
  that the served dashboard was "master minus changelog v3".

## How it works

1. **Each part knows the tree it runs, as a commit.**
   - `selfupdate.boot()` runs first thing in `main()`. It records the bridge's tree as
     `git stash create`: HEAD plus any uncommitted edits, without touching the tree, the index
     or the stash list. Plain HEAD when the tree is clean.
   - Every vite build writes the same snapshot to `dist/.built`, through the `builtFrom`
     plugin in both `vite.config.ts`. That covers `mystical build`, UPDATE, `npm run build`,
     and a scratch `--outDir` build that gets copied in.
2. **`GET /local/live` (`selfupdate.live()`) diffs each part against its tree.**
   - A part is listed when `git diff --name-only <its tree> -- <its paths>` is non-empty.
     - The Mini App's paths are `bridge/miniapp/web`; the dashboard's are `bridge/dashboard/web`.
       Either one listed needs a **REBUILD**.
     - The bridge's paths are `bridge/*.py` and `claude_telegram_bridge.py`. A listed bridge
       needs a **RESTART**.
     - Tests and docs are never listed.
   - Each part carries:
     - its commits since that tree (`base..HEAD`, newest first, with commit times);
     - how many of its changed files are uncommitted;
     - `since`, the build time or launch time.
   - A missing stamp, or one git no longer knows, reads as behind (`unknown`). One rebuild
     fixes it.
   - The response also carries:
     - the running turns, with their titles and start times;
     - `queued`, the wait if one is armed;
     - `error`, what a failed wait said;
     - the short shas running → on disk.
   - No network, so it's polled every 30 s, on focus, and every 4 s while a wait is armed.
3. **⟳ shows only when something is behind** (`LiveButton.tsx`, the rail's foot above the
   changelog). The pill shows one of:
   - the count of distinct commits, in `--acc`;
   - a dot when only uncommitted edits are behind;
   - a red `!` after a failed build;
   - a `--warn` clock while a wait is armed.

   During a run the icon spins and a ring fills. In Middle-earth the family greys every
   rail icon, so there the pill carries the state alone.
4. **The card is UPDATE's popover frame.**
   - It names each part that's behind: icon, name, age, the REBUILD or RESTART tag, up to
     four commits, and "+ N uncommitted file(s)".
   - A `--warn` line appears when a restart would stop running turns.
   - The footer is LATER plus the verb: REBUILD, RESTART, or REBUILD & RESTART.
   - With turns running and a restart needed, the footer is instead LATER, AFTER N TURNS,
     and NOW.
5. **Going live runs from the page, one request per step, so every step ticks.**
   1. Each app that's behind gets `POST /local/live/build {ui}` (`selfupdate.build`). It is
      UPDATE's `npm run build`, serialized by a lock and timed. A missing `node_modules` is
      reported as a failure, not skipped.
   2. If the bridge is behind: `POST /local/restart`, then `watchRestart("GO LIVE")`. The
      boot screen covers the restart and reloads into the new build, and the changelog's boot
      row tells the range as usual.
   3. If only the dashboard changed, the page reloads and says "live" after. If only the Mini
      App changed, the card closes with a toast.
   4. The first failure stops the run. The card shows the failed step and the tail of its
      output, and nothing restarts. FIX WITH CLAUDE starts a session in the bridge's checkout
      with the error.
6. **AFTER N TURNS** is `POST /local/live/after` (`selfupdate.after`).
   - It notes the job ids running at the press, and a thread waits for those jobs alone.
     A turn that starts meanwhile, even in the same session, doesn't hold it up.
   - When they end, the thread runs `go()`: the same builds, then the restart.
   - The page meets the restart with the boot screen when its poll fails.
   - `{cancel: true}` (CANCEL, CLOSE) drops the wait and any failed wait's error.
7. **The pop.** A commit that isn't live and is newer than any ⟳ has seen pops out of the
   icon for 8 s. It uses the changelog's `.clg-co` callout, in the accent, and saves its
   place in `localStorage golive-seen`. The first look after this ships only takes note, and
   uncommitted edits alone never pop.
8. **Sessions point at it.** The bridge-ship skill and CLAUDE.md tell sessions to end a
   merged change with "press ⟳ to go live" instead of asking the ship card or restarting.

## Edges

- **The tree is read as it stands.** Uncommitted edits go live with the rest, because the
  build and the restart read the working tree, as UPDATE's do. The card counts them.
- **Edits that were on disk at launch** don't read as new: the snapshot holds them. The
  commit list is HEAD-based, though, so a later commit of exactly those edits is listed
  once something else makes the bridge behind.
- **Old bridge, new bundle:** `/local/live` 404s and ⟳ just doesn't show.

## Not in this

- No ⟳ on the Mini App or in Telegram.
- No streamed build log; steps show seconds only.
- No auto-apply.
- No `npm install` when a lockfile moved. The build fails, and FIX WITH CLAUDE takes it from there.
