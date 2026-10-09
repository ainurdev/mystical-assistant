# Mystical.app — a native macOS shell for the dashboard

## Why

The dashboard already installs as a PWA (Safari → Add to Dock), so a Mac app has
to earn its place with what a tab can't do:

1. **Notifications with the window closed.** `dashboard/web/src/lib/push.ts`
   uses the plain Notification API and only fires while a tab is open. Without
   Telegram, nothing tells you a session is waiting on you.
2. **Supervision.** `bin/mystical` hands over to a systemd user unit on Linux;
   macOS has no equivalent wired up, so the bridge neither starts at login nor
   restarts after a crash.
3. **A real app**: Dock, ⌘-Tab, menu bar presence, its own window.

## Decisions (agreed in brainstorming)

| Question | Decision |
|---|---|
| Scope | Native **shell** around the existing dashboard — no native re-implementation of any pane |
| Supervisor | A per-user **launchd LaunchAgent** runs the bridge; the app and `mystical` both drive it via `launchctl` |
| Distribution | **Built from source** with the Command Line Tools' Swift, ad-hoc signed, installed to `~/Applications` |
| Notification logic | **Dashboard stays alive** in the app; a shim maps `window.Notification` to macOS notifications |

Out of scope: remote bridges (the dashboard is loopback-only by design), a
signed/notarized download, native panes, a global hotkey.

## Architecture

```
macos/                          Swift package, zero third-party dependencies, macOS 14+
  Package.swift                 targets: MysticalCore (pure logic, tested), Mystical (AppKit app)
  Sources/MysticalCore/         status JSON, URL policy, waiting-on-you list, notification ids
  Sources/Mystical/             AppDelegate + menus, DashboardWindow (WKWebView), NotificationShim,
                                StatusItem, Bridge (CLI + HTTP client)
  Sources/Mystical/Resources/   notification-shim.js
  Tests/MysticalCoreTests/      Swift Testing (+ JavaScriptCore for the shim)
  build.sh                      swift build → .app bundle → ad-hoc sign → ~/Applications/Mystical.app
bridge/startup.py               + macOS branch: launchd agents behind the existing login/window switches
bin/mystical                    + launchctl handover; + `mystical app` / `mystical app open`
setup.sh                        + macOS: offer the app and bridge-at-login; doctor lists swift
dashboard/web (one tweak)       INSTALL AS APP row recognises the Mac app by its user-agent suffix
```

**Data flow.** `build.sh` stamps the checkout path into Info.plist
(`MysticalRepo`). The app runs `$MysticalRepo/bin/mystical status --json` to learn
port, token and running state, then loads `http://127.0.0.1:<port>/?token=…`.
Lifecycle actions shell out to `bin/mystical start|stop|restart` — one
implementation, shared with the terminal. The menu bar polls
`GET /local/running` every 3 s (the dashboard's own cadence; GETs need no token
and a native client sends no `Sec-Fetch-Site`, so the cross-site backstop passes).

The dashboard's existing gates already admit the web view: Host
`127.0.0.1:<port>`, Origin `http://127.0.0.1:<port>`, token in `X-Dash-Token`.
`?s=<id>` deep-links a session and `?skipboot` skips the intro.

The app's subprocesses need a real PATH: a GUI app launched from Finder inherits
only `/usr/bin:/bin:/usr/sbin:/sbin`, and `mystical start` needs `npm` for stale
bundles. `build.sh` stamps the building shell's PATH into Info.plist
(`MysticalPath`, pyenv shims dropped); rebuilding refreshes it.

## The bridge under launchd

`bridge/startup.py` gains a darwin branch behind its existing `state()` / `apply()`
contract, so the SYSTEM tab's START AT LOGIN / OPEN THE WINDOW TOO switches work
on a Mac unchanged.

| Agent (`~/Library/LaunchAgents/<label>.plist`) | Runs | Keys |
|---|---|---|
| `cloud.ainurhq.mystical.bridge` | `$REPO/run.sh`, cwd `$REPO` | `RunAtLoad`; `KeepAlive {SuccessfulExit: false}` (crash restart only); `ThrottleInterval 5`; stdout+stderr → `~/.bridge_state/mystical.log`; `EnvironmentVariables` PATH, LANG, PYTHONUNBUFFERED=1 |
| `cloud.ainurhq.mystical.app` | `/usr/bin/open -a ~/Applications/Mystical.app` | `RunAtLoad` only |

**PATH pinning.** launchd's default PATH resolves `python3` to the system 3.9
(the bridge needs 3.10+) and finds no `claude`. The plist pins, in order: the
directories of `claude`, `node` and `sys.executable` (the interpreter the bridge
runs on), `/opt/homebrew/bin`, `/usr/local/bin`, then the system dirs — pyenv
shims excluded, de-duplicated, exactly as `_unit_text()` does for systemd. LANG
is copied from the environment, defaulting to `en_US.UTF-8`.

**`state()` on darwin**: `supported` true; `login` = bridge plist present and not
disabled (`launchctl print-disabled gui/<uid>`); `supervised` = the bridge job is
loaded with a running PID (`launchctl print gui/<uid>/<label>`); `window` = app
plist present; `browser` = `"Mystical.app"` when `~/Applications/Mystical.app`
exists, else None (the UI copy then reads naturally); `profiles` = `[]`.

**`apply()` keeps systemd's safety rules.**
- login on: write plist (only if the text changed), `launchctl enable`. **Never
  bootstrap** — a hand-launched bridge would clash on ports; the agent takes over
  at next login or the next `mystical restart`.
- login off: `launchctl disable`, remove plists. **Never bootout** — the caller is
  talking through that bridge.
- window on without the app installed: RuntimeError "build the Mac app first: mystical app".

**`bin/mystical` handover** (darwin, mirroring the systemd block):

| Command | Agent installed | Not installed |
|---|---|---|
| start | `launchctl bootstrap gui/<uid> <plist>` (or `kickstart` if already loaded); wait for the port | today's nohup path |
| stop | `launchctl bootout gui/<uid>/<label>` (a plain kill would be relaunched) | today's signal path |
| restart | loaded: `launchctl kickstart -k`; hand-launched: signal-stop, then bootstrap | stop + start |
| status | `supervised: "launchd"` (or `"hand-launched"` when the agent is installed but the running bridge isn't its) | unchanged |

`/local/restart` (`os.execv`, same PID) is invisible to launchd and keeps working.

**Restart from inside a bridge session.** `launchctl kickstart -k` makes launchd
itself do the kill and restart, so the restart completes even though the calling
turn dies with the bridge's process group. To be verified on the machine, then
written into the bridge-ship skill's new macOS section.

## The app

**Window and Dock.** One window; close hides it and keeps the web view alive.
Dock icon while the window is visible (`.regular`), menu-bar-only when hidden
(`.accessory`). ⌘Q quits the app, never the bridge. Reopen from the menu bar,
the Dock, Spotlight (`applicationShouldHandleReopen`) or `mystical app open`.
Frame autosaved.

**Web view configuration.**
- default persistent `WKWebsiteDataStore` — dashboard localStorage (push toggle,
  sounds, drafts) survives relaunches;
- `preferences.inactiveSchedulingPolicy = .none` — timers keep running hidden;
- `mediaTypesRequiringUserActionForPlayback = []` — chimes play unprompted;
- `isInspectable = true`;
- `applicationNameForUserAgent = "MysticalMac/<version>"`.

**Host duties a bare WKWebView drops:**

| Need | Implementation |
|---|---|
| ⌘C ⌘V ⌘X ⌘A ⌘Z | Edit menu built in code, standard responder-chain selectors |
| `<input type=file>` (composer attachments) | `runOpenPanelWith` → `NSOpenPanel` |
| `alert` / `confirm` / `prompt` (`ui/Ask.tsx` fallback) | `NSAlert` (otherwise `confirm()` returns false) |
| `target=_blank`, `window.open`, off-origin navigation | `NSWorkspace.open` in the default browser; cancel in-view |
| `<a download>` (EditorTab) | `WKDownload` → `~/Downloads` |
| reload, zoom | View menu: ⌘R, ⌘+ ⌘− ⌘0 (`pageZoom`, persisted) |

**When the bridge isn't up**, the window shows a native placeholder instead of
WebKit's error page: *stopped* (with a Start button) or *waiting for the
bridge…* (auto-loads once `/local/running` answers). A web-content-process crash
reloads. A 401 re-reads `status --json` (rotated token) and reloads.

**Notification shim** (`notification-shim.js`, injected at document start, main
frame only):
- `window.Notification` with static `permission` (seeded from native at injection,
  kept current), `requestPermission()` (via `WKScriptMessageHandlerWithReply` →
  `UNUserNotificationCenter.requestAuthorization`), constructor
  `(title, {body, tag})`, `onclick`, `close()`.
- Native posts a `UNNotificationRequest` whose identifier is the tag (a new
  notification with the same tag replaces the old, as browsers do; no tag → a
  fresh id). No macOS sound — the dashboard plays the user's chosen one.
- Click → show window, then `window.__mysticalNotificationClick(id)` runs the
  stored `onclick`, which already selects that session.
- The setting is per web view: a browser tab only notifies if enabled there too.

**Menu bar** (`NSStatusItem`, SF Symbol `sparkle` as a template image; a count
beside it when sessions await you):
- status line: running · supervised by launchd / hand-launched · stopped · starting;
- **Waiting on you**: one item per `state == "awaiting"` entry in
  `/local/running`'s status map, titled from its `jobs` entry, falling back to the
  label → opens `/?token=…&s=<id>&skipboot`;
- Open Dashboard · Open in Browser · Start / Stop / Restart Bridge (enabled by
  state) · Show Log (Console.app) · Quit Mystical.

## Build, install, setup

`macos/build.sh` (behind `mystical app`):
1. `swift build -c release --package-path macos`;
2. assemble the bundle in a temp dir: `Contents/MacOS/Mystical`, Info.plist
   (`CFBundleIdentifier cloud.ainurhq.mystical`, `LSMinimumSystemVersion 14.0`,
   `NSAppTransportSecurity.NSAllowsLocalNetworking`, `MysticalRepo`, version from
   `git describe`), `AppIcon.icns` from `bridge/dashboard/web/public/icon-512.png`
   via `sips` + `iconutil`, the shim resource;
3. `codesign --force --sign -`;
4. if Mystical is running, quit it (by bundle id); move into
   `~/Applications/Mystical.app`; reopen if it was running.

A failed build leaves the installed app untouched. `mystical start` does **not**
rebuild the app — rebuilding is explicit (`mystical app`). `macos/.build/` is
git-ignored.

`setup.sh` on darwin: the doctor lists `swift` as optional ("builds the Mac app";
missing → `xcode-select --install`). Two questions: build the app? start the
bridge at login? (→ `startup.apply(login=True, window=<app built>)`). The existing
"start it now?" then goes through `mystical start`, i.e. launchd.

## Error handling

- `status --json` fails or the repo path is gone → placeholder naming the path
  and `mystical app` to rebuild from the right checkout.
- `launchctl` errors surface verbatim: as a 400 from `/local/startup`, as the
  CLI's `die` line, and as an `NSAlert` from the menu's lifecycle items.
- Notification permission denied → `Notification.permission` reads `denied`;
  the dashboard already flips its toggle off.

## Testing

- **Python** (`tests/test_startup.py`, `launchctl` faked, LaunchAgents dir pointed
  at a temp root): plist text (PATH order, shims excluded, KeepAlive, log paths);
  `state()` parsing; login on enables and never bootstraps; login off disables,
  removes and never bootouts; window refuses without the app.
- **Swift** (`swift test`, Swift Testing): status JSON incl. `running:false`; URL
  policy (in-view / browser / download); waiting-on-you list from a recorded
  `/local/running`; tag → identifier.
- **Shim JS** under JavaScriptCore with a fake `webkit.messageHandlers`:
  constructor posts, permission flow, click dispatch, `close()`.
- **End to end on the Mac**: window loads the dashboard; an awaiting session
  shows in the menu count and as a notification whose click opens it; menu
  Stop/Start; quitting the app leaves the bridge up; `kill -9` the bridge →
  launchd restarts it; `kickstart -k` from inside a session restarts it. The user
  clicks Allow on the notification prompt; the restart checks end the agent's
  turn, so they're announced first.

**First implementation task is the risk spike**: confirm an ad-hoc-signed bundle
can post and receive clicks on `UNUserNotificationCenter` notifications on this
macOS. Fallback if not: post without click-through.

## Where it's built

In a worktree (bridge-worktree skill). `MysticalRepo` and the launchd agent must
point at the main checkout, so the final `mystical app` and agent install run
there after merge.
