# Tray companion — Mystical.app's menu bar, on Windows and Linux

## Why

Mystical.app (`macos/`, see `macos-app-design.md`) earned its place with three
things a browser tab can't do. On Windows (bridge in WSL) and Linux desktops two
of them already exist without it:

- **Its own window**: INSTALL AS APP puts the dashboard in a Chrome/Edge app
  window, and OPEN THE WINDOW TOO opens it at login (`bridge/startup.py`).
- **Supervision**: the systemd user unit starts the bridge at login and restarts
  it after a crash.

What's still missing is the menu bar: a glanceable count of the sessions waiting
on you, start/stop without a terminal, and **alerts with the window closed**. The
dashboard's alerts (`lib/push.ts`) only fire while a dashboard page is open.

## Decisions (agreed in brainstorming)

| Question | Decision |
|---|---|
| Shape | A **tray companion** next to the installed window. No new window, no native re-implementation of anything the dashboard shows |
| Tech | Only what each OS ships: **Windows PowerShell 5.1 + WinForms** (every Windows 10/11); **system python3 + GTK** (PyGObject, AppIndicator, libnotify) on Linux |
| Distribution | Runs from the checkout. Nothing to build, download or sign |
| Switch | **OPEN THE WINDOW TOO** starts it at login, the way it opens Mystical.app on a Mac; `mystical app` starts it right away |
| Double alerts | The tray stays quiet while a dashboard page with alerts on is polling |

Out of scope: an own window, downloadable installers, any change to the Mac app,
"session started" alerts, a show-log item, remote bridges.

## Architecture

```
windows/tray.ps1              the Windows tray (PowerShell 5.1, WinForms)
linux/tray.py                 the Linux tray (system python3, GTK 3 via PyGObject)
bridge/startup.py             OPEN THE WINDOW TOO also starts the tray: a line in the
                              WSL Startup .cmd, a second autostart entry on Linux;
                              + launch_tray() for `mystical app`
bridge/dashboard/server.py    /local/running gains `watched`
bridge/dashboard/web          the running poll says when its own alerts are on
bin/mystical                  `mystical app` on Linux/WSL starts the tray
setup.sh                      doctor: the Linux tray's packages
SettingsModal.tsx, README     copy
```

Both trays are the same small program:

1. Every 4 s (the dashboard's own cadence) `GET http://localhost:<port>/local/running`.
   GETs need no token, and a native client sends no `Sec-Fetch-Site`, so the
   cross-site backstop lets it through, as it does for the Mac app's menu bar.
2. Diff the `status` map against the previous poll (rules below). If
   `watched` is false, alert.
3. Redraw the icon's count and the menu.

**Inputs.** The port, distro, user, repo path, browser and browser profile are
arguments, written by `startup.py` into the login entry. They're the same values
the window line beside it already uses, and a change re-applies through the
switch. The tray needs no token for polling. To open a window, it reads the live
token from `GET /manifest.webmanifest`: `start_url` is `/?token=…` when
DASH_TOKEN is set. So a rotated token is picked up without a restart, and the
token is never written into a file on the Windows side.

**Opening a session.** `<browser> --profile-directory=<profile>
--app=http://localhost:<port>/?token=…&s=<id>&skipboot`. That's the same browser,
profile and `localhost` origin as the login window, so it shares the installed
app's localStorage. No browser found: the system default (`Start-Process <url>` /
`xdg-open`). Every open is a new window, even if one is already up (known limit,
below).

## What counts as news

The same transitions the dashboard rings for (`App.tsx`, the `statusMap` effect),
minus "started":

| Event | Rule (previous → current poll) | Title | Body |
|---|---|---|---|
| waiting on you | state becomes `awaiting` | `⏸ <title>` | label, else "waiting on you" |
| done | was `working`, now not `working`/`awaiting`/`parked` | `✓ <title>` | "finished" |
| parked | state becomes `parked` | `⏳ <title>` | label, else "parked" |

- **The first poll is the baseline.** Nothing that predates the tray is news
  (same as the dashboard's `statusSeen`). The same goes for the first poll after
  the bridge comes back up.
- **Titles** come from `jobs[].title`, as in the Mac app's `Running.swift`. They're
  remembered across polls, because a session that ends its turn on a question
  leaves `jobs` but was in it while working. Fallback: the label, then "session" —
  except for done, which skips the label: a working session's label is its activity,
  and "✓ running Bash" reads as if Bash were what finished.
- **When `watched` is true**, the tray still records the new state (so nothing
  replays later) but doesn't alert.

## No double alerts: `watched`

An open dashboard page already alerts, with the user's sound, and it skips the
session they're looking at (`shouldPush`). The tray must not repeat it.

- The dashboard's 4 s poll asks for `/local/running?alerts=1` when its own OS
  alerts are on (`settings.push && pushGranted()`). Other callers
  (`HistoryView`, the Mac app's menu bar, the trays) send nothing extra.
- `server.py` stamps `time.monotonic()` on an `alerts=1` poll and adds
  `"watched": <stamped within the last 90 s>` to the response. It's a module-level
  float, and the dashboard server is the only writer. The Mini App's `/running` is
  untouched.
- **Why 90 s:** Chrome throttles a hidden page's timers to about one a minute
  after five minutes in the background, so a minimised window still polls about
  every 60 s. If a page dies or gets frozen, it stops polling, and the tray takes
  over within 90 s.

## Windows: `windows/tray.ps1`

- **Launch** (the Startup .cmd, after the wait loop, whether or not the bridge
  answered, so a failed start still leaves a tray with Start in it):
  `start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass
  -File "\\wsl$\<distro>\<repo>\windows\tray.ps1" -Port … -Distro … -User …
  -Repo … -Browser … -BrowserProfile …` (not `-Profile`: `$PROFILE` is a PowerShell
  automatic variable). The script runs from the checkout, so a
  `git pull` updates it. A repo under `/mnt/<drive>` uses its Windows path instead
  (`_win_path`). The hidden console flashes briefly at login.
- **Icon:** `bridge/dashboard/web/public/icon-192.png`, scaled with System.Drawing;
  the waiting count is drawn as a badge on its corner. The tooltip reads
  "mystical — N waiting on you" (the 63-character limit is respected). Each
  redraw destroys the previous HICON.
- **Menu** (ContextMenuStrip): `● running` / `○ stopped` / `… starting` · one item
  per waiting session (opens it) · Open dashboard · Start / Stop / Restart bridge
  (enabled by state) · Quit tray. A left click opens the dashboard.
- **Alerts:** `NotifyIcon.ShowBalloonTip`, which Windows 10/11 shows as a toast.
  Only one balloon shows at a time, so one poll's events become one balloon:
  - a single event names its session, and clicking it (`BalloonTipClicked`)
    opens that session;
  - several make "N sessions need you" with the titles in the body, and clicking
    it opens the dashboard.
- **Polling never blocks the menu:** `WebClient.DownloadStringAsync` from the UI
  thread, with completion handled back on it, a 3 s timeout and `Proxy = $null`
  (a system proxy must not intercept localhost).
- **Bridge commands:** `wsl.exe -d <distro> -u <user> -e bash -lic
  "'<repo>/bin/mystical' start|stop|restart"`, through a login+interactive shell so
  it sees your terminal's PATH (nvm's npm, for a stale bundle). `-e`, not `--`: `--`
  hands the line to the default shell, which re-parses the quoting. They run hidden, with output going to a temp file. A UI timer
  watches the process; a non-zero exit shows a MessageBox with the output's last
  lines.
- **One instance:** a named mutex `Local\mystical-tray`. A second launch exits.
- **Encoding:** **ASCII only**; every glyph (`⏸ ✓ ⏳ ● ○ …`) is built from its code
  point (`[char]0x23F8`). Windows PowerShell 5.1 reads BOM-less scripts as ANSI, and
  a BOM is one editor save away from being stripped; an ASCII file can't be misread.
  A test pins it.

## Linux: `linux/tray.py`

- **Launch:** `~/.config/autostart/mystical-tray.desktop`, written and removed with
  the window entry: `Exec=/usr/bin/python3 <repo>/linux/tray.py --port … --browser …
  --profile …`. It runs on the **system** interpreter, because that's where the
  distro's PyGObject lives; the bridge may run on another one. It's a second entry
  rather than a second command in the window's `Exec`, so the desktop's own
  startup-apps settings list it, and can disable it, on its own.
- **Bindings:** `AyatanaAppIndicator3` (falling back to `AppIndicator3`) for the
  icon, `Notify` for alerts, and `Gtk` for the menu and the error dialog. GI
  imports happen inside `main()`, so the pure functions import without them (for
  tests). If they're missing, the tray exits with one stderr line naming the
  packages.
- **Icon:** the same PNG. The count is shown with `set_label`, which Ubuntu's
  indicator shows and some panels ignore; the menu header carries it too.
- **Menu and alerts:** same items as Windows (AppIndicator gives a left click to the
  menu, so a middle click opens the dashboard). One `Notify.Notification` per
  session, kept and updated by session id, so a chatty session replaces its own
  alert instead of stacking. The `default` action opens the session.
- **Polling:** `urllib.request` on a worker thread, with the result handed to
  the UI through `GLib.idle_add`.
- **Bridge commands:** `bash -lic "'<repo>/bin/mystical' <cmd>"` on a worker thread,
  for the same reason as on Windows: a desktop session's PATH lacks nvm's npm. A
  non-zero exit shows a `Gtk.MessageDialog` with the output's last lines.
- **One instance:** `fcntl.flock` on `$XDG_RUNTIME_DIR/mystical-tray.lock`.
- **GNOME** shows no tray icons without the AppIndicator extension, which Ubuntu
  ships and Fedora doesn't. Alerts still work without it. README says so.

## `startup.py`, `mystical app`, doctor

- `_script(open_window=True)` gains the tray line; `_script(False)` has none (the
  login half only boots WSL, as today).
- Linux `apply()`: window on → both autostart entries; window or login off →
  both removed. `state()["window"]` keeps reading the window entry.
- `launch_tray()` starts it detached with the same arguments. On WSL that's
  `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` (Windows exes
  aren't on a WSL PATH), on Linux `/usr/bin/python3 linux/tray.py …` in a new session,
  after `tray.py --check` passes, so `mystical app` can say which packages are missing.
- The switch does **not** start the tray immediately. WSL interop from inside the
  systemd-run bridge is unverified, and the Mac switch doesn't launch the app
  either. It takes effect at next login, or now with `mystical app`.
- `bin/mystical app`: darwin unchanged. Linux/WSL → `launch_tray()`.
  `mystical app open` stays macOS-only, and its error says what `mystical app`
  does here.
- `setup.sh` doctor, on a Linux desktop (`XDG_CURRENT_DESKTOP` set, not WSL):
  `/usr/bin/python3 linux/tray.py --check` passes → ok "tray bindings"; else warn,
  naming the packages (`gir1.2-ayatanaappindicator3-0.1 gir1.2-notify-0.7` on
  Debian/Ubuntu, `libayatana-appindicator-gtk3 libnotify` on Fedora). The names live
  in linux/tray.py alone. WSL needs nothing.

## Error handling

- **Bridge not answering:** `○ stopped`, the count is cleared, Start is enabled,
  and there are no alerts. When it answers again, that first poll is a fresh
  baseline.
- **A bridge command fails:** a dialog with its output's tail (above).
- **Icon file missing** (moved checkout): a stock icon (`SystemIcons.Application`
  / `dialog-information`), and the tray keeps running. Re-apply the switch after
  moving the checkout, as with `mystical app` on a Mac.
- **Quit tray** leaves the bridge alone.

## Known limits

- For up to 90 s after the last dashboard window closes, `watched` stays true, so
  alerts in that gap are lost.
- A dashboard tab with alerts on in a browser you aren't looking at still counts
  as watching. The tray stays quiet and that tab alerts.
- Opening from the tray always makes a new app window. Focusing an existing one
  would need the installed PWA's app id and a `launch_handler`.

## Testing

- **pytest** (`tests/test_startup.py` patterns, all fakes):
  - the .cmd has the tray line, with its arguments, only with the window on;
  - the UNC path vs the `/mnt/c` path;
  - Linux writes and removes both entries with the switches;
  - `launch_tray()` builds the right command per platform.
- **pytest, server:**
  - `watched` is false at first, true after an `alerts=1` poll and unchanged by a
    plain poll;
  - it expires after 90 s (clock monkeypatched).
- **pytest, `linux/tray.py` pure functions:** the three events, the baseline, the
  title cache and fallback, `watched` suppression, and the open-URL builder (token
  and no token).
- **Dashboard:** `tsc -p tsconfig.app.json`. The change is one query flag on the
  poll, and the server tests cover what it does.
- **PowerShell, here:** a parse check of `tray.ps1` and an assert script over its
  pure functions (the same cases as the Python tests), run in the
  `mcr.microsoft.com/powershell` container. WinForms can't run there.
- **Linux, here:** the real tray in a Linux desktop container whose panel hosts
  tray icons (XFCE), against a fake `/local/running` that steps through the
  transitions. Screenshots of the icon with a count, the menu, and an alert go to
  the user.
- **Windows, on a Windows+WSL machine (the user):** five checks.
  1. `mystical app` → icon appears.
  2. A session asks a question with no window open → toast; clicking it opens the
     session.
  3. With a window open and alerts on → no toast.
  4. Stop → `○ stopped`; Start → `● running`.
  5. Log out and in → tray and window come back.

  Getting the branch there (a push or a `git bundle`) is the user's call at that
  point.

## Where it's built

In a worktree (bridge-worktree skill). Nothing persists new data: no table,
column or state file. The dashboard change needs a `dist` rebuild after merge,
and none of it touches the Mac bridge's running code paths except the additive
`watched` field.
