# Device runs: in the Plugins tab, with a view of their own, never in your way

**Ask (2026-10-18):** "make sure nothing interrupt my work when passing these kind of tasks to my system, also in plugin tab can we list that session (with its specific view)". This came after Erfan Besharat's run on this Mac at 17:10 (ainurhq/ibgroups_operations, PR #81). The run worked, but it only showed up as a row in the bell and as "running now" in Settings.

These mockups use FLINT VIOLET, the user's current theme. The real tokens and sizes were read off the live dashboard.

## Today

- A teammate's run is headless: `claude -p --output-format json`, run as `mysticalruns`. Nothing streams until the run ends.
  - The owner sees a bell row, "running now" under Settings › Integrations › Rivendell › State, and the device on Rivendell's Devices page.
  - The asker sees nothing until the result arrives.
- Any Mystical restart stops a run in flight. A restart can come from UPDATE, from a session shipping with bridge-ship, or from `mystical restart`. At boot, `device_side.sweep()` stops the helper and posts FAILED: "The device restarted during the run."
- Already fine:
  - A run never holds up your own sessions or Rivendell jobs: `_device_run` is kept apart from `_active_runs`.
  - Its pings follow NOTIFY.

## The design

**01 · Plugins tab.** A DEVICE RUNS lane ("teammates on this device", in blue) sits above RIVENDELL.
- The run going now comes first, then the last finished ones: ✓ for done, ✕ for failed or stopped.
- Each row shows:
  - the run's title
  - the asker, in blue
  - the repo and PR
  - while it runs, the elapsed time in blue; once it ends, its age
- The tab's icon carries a blue dot while a run goes.

**02 · The run's view while it runs.** It opens in the centre like a session, read only.
- **The ask** is a bubble signed by the asker, with a blue bar, where YOU would be.
- **The WORK zone is live.** It shows the same steps, commands, pictures and timings a session shows, fed from the run's own stream. The current command shows its last output line.
- **A Mystical restart** is one line in the stream: "Mystical restarted 17:31 · this run kept going".
- **A read-only plate replaces the composer.** It has:
  - the title tab, the branch, and RUNNING · LOW PRIORITY
  - one line saying what this is
  - the asker, the repo with its commit, and the Simulator
  - STOP RUN, which asks before it stops

**03 · Done.**
- WORK folds to its counts and pictures.
- The report sits beside the screenshot, which is shown at full size.
- "Sent to Erfan Besharat 17:44".
- The plate says when the run finished and how long its view is kept.

## Never in your way

1. **Restarts don't stop a run.** The helper already runs in a session of its own and outlives the bridge. At boot, the bridge picks back up any stage whose helper is still running: it tails the stream from where it left off and posts the result when the run ends. Only a run whose helper is gone, after a reboot or a crash, still ends FAILED.
2. **Low priority.** Claude and everything it starts run under `taskpolicy -c utility`. Your apps, builds and sessions stay quick, and a run takes longer while you're busy.
3. **Never in your queue.** Your sessions and Rivendell jobs never wait for a teammate's run. This is already how it works.
4. **Quiet.** No toast and no banner. The run shows in the Plugins tab, and the bell gets one row when it starts and one when it ends. Telegram gets a message only where NOTIFY routes "Started elsewhere", as today.

## Build notes

- **Helper:**
  - Claude runs with `--output-format stream-json --verbose`.
  - Each line also goes to `<stage>/out/live.jsonl`. Root creates that file once, through the stage's checked handle (O_EXCL|O_NOFOLLOW), and gives it to the owner.
  - `claude.json` becomes the stream's last `result` line.
  - The launch goes under `taskpolicy -c utility`.
  - A helper whose bridge has gone keeps running: it no longer writes to a stderr that could kill it.
  - The helper is root's copy, so the new one needs one more Set up (one Mac password). STATE says so.
- **Bridge:**
  - A device run becomes a read-only session with origin `device-run:<instance>`.
  - `live.jsonl` goes through the same stream-json parser that sessions use. Token-shaped text is redacted before anything is stored.
  - `sweep()` takes a live helper back instead of stopping it.
  - STOP RUN is the helper's stop, plus a FAILED result: "Stopped by this device's owner."
- **Dashboard:**
  - SessionsPanel's PLUGINS tab gets the DEVICE RUNS lane.
  - The session view swaps the composer for the read-only plate when the origin is `device-run`.
  - Settings' "running now" links to the view.

## Sample data

These details come from Erfan's real run: row 1, the ask, the repo, the PR, the commit, the Simulator, and the live build line.

These are made up, because the real run was still building: the other rows, the 17:31 restart, the report and the screenshot.

## Not in this draft

- A run's dev server can take a port you use, such as Metro's 8081.
- The asker still sees nothing until the report arrives. A live view on their side needs Rivendell to relay the stream.

## Open

1. "Nothing interrupts my work" is covered both ways: your restarts don't stop a teammate's run, and the run neither slows you down nor takes your turn. Is that right?
2. Should a finished run's view be kept for 7 days? It can hold the asker's code and `.env` values.
3. Should the owner have STOP RUN?
