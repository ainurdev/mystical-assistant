# Mystical.exe — the native Windows shell, for a bridge in WSL

## Why

Mystical.app (`macos-app-design.md`, `mac-app-v2-design.md`) is the dashboard in
its own window plus what a tab can't do: banners with the window closed that you
can answer from, a menu bar with the sessions waiting on you, lifecycle without a
terminal, `mystical://` links, screen capture for sessions, a floating panel.
On Windows the bridge runs in WSL and the desktop side is a PowerShell tray
(`windows/tray.ps1`, `tray-companion-design.md`) beside a Chrome/Edge `--app=`
window. That covers the count and the lifecycle; it has no window of its own,
its alerts are tray balloons with no buttons, and nothing on the Windows side
can be asked for a capture or a probe. Every Windows developer on the team runs
WSL, so the app's job is the same as the Mac app's, with one extra they asked
for: a global hotkey that summons the dashboard from any app.

## Decisions (agreed in brainstorming)

| Question | Decision |
|---|---|
| Scope | **Parity with Mystical.app** — own window, tray icon with the waiting count, toasts you can answer, screen + window capture, probe, `mystical://` links, floating WAITING ON YOU panel, rebuild from the app — **plus a global hotkey**. Nothing beyond that: no "run Windows commands", no clipboard, no foreground-window reporting (offered, declined). |
| Tech | **C# on the .NET SDK: WinForms + WebView2 + WinRT toasts.** Microsoft frameworks only; the one package fetched is Microsoft's own WebView2 SDK (and the Windows SDK projection the TFM pulls in). The Windows counterpart of "AppKit, WebKit, UserNotifications". |
| Toolchain | **.NET SDK 8+ on the Windows side** (`winget install Microsoft.DotNet.SDK.10`), driven from WSL through interop: `windows/build.sh` runs `dotnet.exe`. The doctor names it; the PowerShell tray stays as the no-SDK fallback. |
| Where it runs | **A Windows process, built from the WSL checkout**, installed to `%LOCALAPPDATA%\Programs\Mystical\`. It reaches the bridge through `wsl.exe` (lifecycle, status) and `http://127.0.0.1:<port>` (the poll, the page) — Windows → WSL localhost forwarding works in NAT and mirrored networking alike. |
| WSL → app channel | **A named pipe, `\\.\pipe\mystical`, with the exe as its own client.** `windows/capture.sh` and `windows/probe.sh` run `Mystical.exe --capture …` / `--probe …` through interop; a second instance forwards a `mystical://` link the same way. Verified: interop works from inside a systemd user unit on WSL 2.4 (the supervised bridge can run it), and Windows writes into `\\wsl.localhost\<distro>\…`. |
| Notification logic | **The dashboard stays alive in the app**; the same `window.Notification` shim as the Mac app, over `chrome.webview.postMessage`, so `lib/mac.ts` and `lib/banner.ts` work unchanged. The app ports no alert diffing from `tray.ps1`. |
| The tray | **Replaces `tray.ps1` once the app is installed**: the Startup `.cmd` and `mystical app` start the exe instead of the PowerShell tray and the browser window. `tray.ps1` is untouched and still what a machine without the SDK gets. The swap is made at install time, not at the next switch toggle (below, "Taking over from the tray"). |
| Chrome | **Windows' own title bar and caption buttons.** No drawn traffic lights, no `drag` op, no `--mac-titlebar`: those stay `isMacApp()`-only on the page. The title bar follows the theme (dark/light). |

Out of scope: a packaged installer (MSIX), code signing, a taskbar overlay badge
(the tray badge carries the count), a busy glyph (the tooltip says "N working"),
WSL 1, a native Linux app, a second window, a configurable hotkey chord.

## Architecture

```
windows/
  app/                      the exe: one csproj, no XAML, no designer files
    Mystical.csproj         WinExe · net8.0-windows10.0.19041.0 floor · UseWindowsForms ·
                            PackageReference Microsoft.Web.WebView2 · app.manifest (PerMonitorV2)
    Program.cs              mutex, CLI (--probe/--capture/--quit/mystical://), Application.Run
    Core/                   pure, no WinForms — what windows/check asserts
      BridgeStatus.cs       `mystical status --json`            (= BridgeStatus.swift)
      Running.cs            /local/running → waiting, working   (= Running.swift)
      UrlPolicy.cs          in-view / browser / ignore, session links (= URLPolicy.swift)
      DeepLink.cs           mystical://open, mystical://session/<id> (= DeepLink.swift)
      Prefs.cs              floating, titleFollowsSession, hotkey (= MacPrefs.swift)
      CaptureRequest.cs     {dir, window?}, window matching   (= CaptureRequest.swift)
      Shim.cs               permission mapping, ids, action sanitising, shim source
      Stamp.cs              mystical.json beside the exe       (= Info.plist's Mystical* keys)
    shim.js                 window.Notification + the handler bridge (embedded resource)
    Bridge.cs               wsl.exe runner, 3 s poll, rebuild      (= Bridge.swift)
    DashboardForm.cs        the window: WebView2, placeholder, hotkey, full screen, dark title bar
    Notifier.cs             page ops over WebMessageReceived; toasts and their activation
    Tray.cs                 NotifyIcon + ContextMenuStrip + badge icon (= the menu bar)
    FloatingPanel.cs        topmost, non-activating WAITING ON YOU form
    Capture.cs              GDI screen / window capture
    Probe.cs                window.png + state.json
    Pipe.cs                 \\.\pipe\mystical server and client
  check/
    Check.csproj            console; compiles ../app/Core/*.cs; plain asserts, exit 1 on failure
    Program.cs
  shim.check.mjs            node: shim.js under a fake chrome.webview
  build.sh                  `mystical app` on WSL: stage → dotnet publish → install → registry
  capture.sh, probe.sh      the WSL-side wrappers (= macos/capture.sh, probe.sh)
  tray.ps1, tray.check.ps1  unchanged: the no-SDK fallback
bridge/startup.py           WSL: the .cmd and launch_tray() prefer the installed exe
bin/mystical                `mystical app` on WSL builds when dotnet.exe is there; `app open`
setup.sh                    doctor lists dotnet; a WSL step offers the build
bridge/dashboard/web        lib/mac.ts grows isWinApp()/isNativeApp(); the MAC APP tab is the
                            native app's tab on both platforms; three gates widen
tests/test_startup.py       the .cmd and launch_tray() with and without the exe
CLAUDE.md, README.md, .claude/skills/bridge-ship   the Windows lines
```

**Data flow.** `build.sh` writes `mystical.json` beside the exe: `repo` (this
checkout's WSL path), `distro`, `user`, `path` (the building shell's PATH, pyenv
shims dropped) and `version` (`git describe`). The app runs
`wsl.exe -d <distro> -u <user> -e env PATH=<path> <repo>/bin/mystical status --json`
— `-e` and `env`, not a login shell, so stdout is the JSON and nothing a shell rc
prints — to learn port, token and running state, then loads
`http://127.0.0.1:<port>/?token=…` in WebView2. Lifecycle is the same line with
`start|stop|restart`; the systemd handover inside `bin/mystical` is untouched.
The tray polls `GET /local/running` every 3 s. Rebuild is `… bin/mystical app`
detached, its output redirected inside WSL to `~/.bridge_state/app-build.log`
(beside the bridge's own log, as on the Mac), so the app's exit mid-build can't
break a pipe under it.

**Why `wsl.exe`, not a shell:** `tray.ps1` uses `bash -lic` for lifecycle so the
user's PATH is there; the app needs clean stdout for `status --json`, so it pins
the PATH it was built with instead, the way `MysticalPath` does on the Mac.
A moved checkout or a changed PATH means a rebuild, as on the Mac.

**WSL2 only.** `\\wsl.localhost` shares and localhost forwarding are WSL2's. The
app never connects WSL → Windows (that direction needs mirrored networking); the
wrappers run the exe through interop instead.

## The app

**Window.** One `Form`, WebView2 docked to fill, min 720×480, bounds remembered
in `settings.json`. Close hides it (`FormClosing` → cancel + `Hide()`), so the page
and its notification rules keep running; the tray's Quit ends the process. Shown
at launch (the Startup `.cmd` or a hand launch — either way you asked for it),
from the tray's left click, from the hotkey, from `mystical://`, from a toast.
`DocumentTitleChanged` mirrors the page title into the form's; the page sets it
(`titleFollowsSession`, App.tsx, already written for the Mac).

**WebView2.**
- environment: user data folder `%LOCALAPPDATA%\Mystical\WebView2` (settings,
  drafts, sounds persist); `AdditionalBrowserArguments`
  `--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling
  --disable-renderer-backgrounding` (chimes play unprompted; the page keeps polling
  while the window is hidden — a hidden WebView2 is a background tab to Chromium);
- settings: user agent = default + ` MysticalWin/<version>`; dev tools on;
  status bar off;
- `AddScriptToExecuteOnDocumentCreatedAsync(Shim.Source(permission))`, guarded
  to the top frame inside the script;
- `WebMessageReceived` ↔ `PostWebMessageAsJson`: the handler bridge (below);
- `NavigationStarting` (main frame) → `UrlPolicy.Decide` → cancel + default browser
  for anything off-origin; `FrameNavigationStarting` left alone (the preview pane);
  `NewWindowRequested` → default browser, handled;
- `ProcessFailed` → `Reload()`; a failed navigation → the placeholder;
- `AcceleratorKeyPressed`: F11 toggles full screen (borderless + maximized), F5 /
  Ctrl+R reload (WebView2's own), Ctrl+= / Ctrl+- / Ctrl+0 zoom (`ZoomFactor`,
  persisted). Copy/paste, the file picker, `alert`/`confirm`/`prompt` and
  downloads are WebView2's own — the AppKit host duties have no Windows twin.

**The handler bridge.** `shim.js` defines
`window.webkit.messageHandlers.mysticalNotify.postMessage(msg)` → a Promise: it
stamps an `id`, calls `chrome.webview.postMessage({id, ...msg})`, and resolves on
the `chrome.webview` `message` event carrying that id (`{id, result}` or
`{id, error}`). The page's `lib/mac.ts` finds the same handler it finds on the Mac
and needs no change for the shared ops. Ops: `request`, `show`, `close`,
`settings`, `set`, `appearance`, `rebuild` — the Mac set minus `drag` and `window`
(answered with "unknown op"). `settings` replies
`{floating, titleFollowsSession, hotkey, version, platform: "windows"}` — no
`keepInDock`: the page hides that row where the reply lacks it.

**Placeholder** (when the bridge isn't up): the brand ground, one line of state,
the one action that helps — *waiting for the bridge…* with a spinner,
*the bridge is stopped* with START THE BRIDGE, *can't find the checkout* naming
`repo` and `mystical app`. A `Panel` over the WebView2, same three states as
`Placeholder` on the Mac, same copy.

**Toasts.** `Windows.UI.Notifications` from the `10.0.19041.0` TFM. The AUMID
`cloud.ainurhq.mystical` is registered by the app itself at every start — an
idempotent write under `HKCU\Software\Classes\AppUserModelId\` (DisplayName,
IconUri — what Windows shows as the sender on an unpackaged app; verified on this
machine: a toast with two buttons lands in the notification center from a
registry-registered id), so a dev copy's toasts are attributed too — and set on
the process (`SetCurrentProcessExplicitAppUserModelID`). A `show` becomes a
ToastGeneric with title and body, `Tag` = the shim id, `Group` = `mystical`, no
sound (the dashboard plays the one you picked), and one `<action>` per
sanitised button (`activationType="foreground"`, `arguments` = the action id).
A toast with buttons is a card waiting on you, so it uses `scenario="reminder"`
and stays on screen with its buttons until answered or dismissed — a collapsed
toast in the notification center taps as a body click. Taps reach the app two
ways, both landing in one handler: the toast object's own `Activated` event
(an on-screen banner; the object is kept referenced until it settles, or the
subscription is collected with it) and a **COM activator**
(`INotificationActivationCallback`, CLSID registered beside the app id as
`CustomActivator`, `LocalServer32` = this exe `-ToastActivated`, the class
object registered at every start), which is how Windows delivers a tap on a
toast that went to the notification center — Focus Assist, a timed-out banner, a
tap minutes later — and without which such taps reach nothing (verified). The
`launch` / `arguments` text is JSON `{id, action?}`, so a fresh instance launched
by a tap knows the toast too; a tap arriving by both paths within seconds is one
tap. A bare click → `__mysticalNotificationClick(id)`, a button →
`__mysticalNotificationAction(id, action)`, falling back to opening the session
when the page that made it is gone — exactly `DashboardWindow.notificationClicked`
/ `notificationAction`. `close` → `History.Remove(tag, group)`. Permission:
Windows never prompts, and `ToastNotifier.Setting` is null for an unpackaged app
id, so the two registry toggles Windows Settings writes are read instead
(`HKCU…\PushNotifications\ToastEnabled`, `…\Notifications\Settings\<AUMID>\Enabled`):
`granted` unless one is 0. `request` returns that.

**Tray** (`NotifyIcon`, `ContextMenuStrip`, rebuilt on every open from the latest
poll — the menu bar's twin): state line (● bridge running · systemd / ○ stopped /
◌ starting… / ● working… / ● rebuilding…) · **Waiting on you** rows (open the
session in place via `__mysticalOpenSession`, else `?s=<id>&skipboot`) · Open
Dashboard · Open in Browser · Start / Stop / Restart Bridge (enabled by state) ·
Show Log (a console running `wsl.exe … -e tail -n 200 -f <log>`) · Mystical
<version> · Rebuild App · Quit Mystical. Left click opens the dashboard. Icon:
`icon-192.png` scaled, the waiting count on the amber badge — `tray.ps1`'s
drawing, ported. Tooltip "2 working · 1 waiting on you" / "mystical//assistant";
the icon reads disabled-grey while the bridge is down.

**Floating panel.** A borderless, topmost, non-activating `Form`
(`WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`, `ShowWithoutActivation`, not in the
taskbar), the ground with a teal hairline, "✦ WAITING ON YOU · N" and up to six
rows; a row opens its session; dragged by its body (`WM_NCHITTEST` → `HTCAPTION`);
position remembered. Shown while `floating` is on, the list is non-empty and the
dashboard form isn't the active window.

**Global hotkey.** `RegisterHotKey(Win+Ctrl+A, MOD_NOREPEAT)` while the `hotkey`
switch is on (default on — it's what was asked for). `WM_HOTKEY` toggles: hidden or
behind → show and activate (a hotkey press carries foreground rights); already in
front → hide. Registration failing (the chord is taken) shows one balloon saying
so and leaves the switch on. `ponytail:` the chord is fixed; make it a pref the
first time someone collides.

**Deep links.** `build.sh` registers `HKCU\Software\Classes\mystical`
(`URL Protocol`, `shell\open\command` = `"<exe>" "%1"`). The exe started with a
`mystical://` argument hands it to the running instance over the pipe (`open`) and
exits; the first instance parses it (`DeepLink`) — `open` shows the window,
`session/<id>` opens that session. A link opens things and never starts, stops or
restarts anything.

**Pipe** (`\\.\pipe\mystical`, one JSON line in, one out, clients served one at a
time): `probe {dir}`, `capture {dir, window?}`, `open {url}`, `show`, `hide`,
`eval {js}` (the JSON of an expression's value in the page — the driver the
checks use), `quit`.
`dir` is a Windows path — the wrappers translate with `wslpath -w`, so a WSL
`/tmp/x` arrives as `\\wsl.localhost\<distro>\tmp\x`. The client is the exe itself
(`--probe <dir>`, `--capture <dir> [-w <text>]`, `--quit`): it connects, sends,
prints the reply, exits 0/1. Anyone local can talk to the pipe — the same trust
as the Mac's distributed notifications; nothing is captured unless a local
process asks, and nothing the pipe does changes bridge state.

**Capture** (`Capture.cs`, no permission on Windows): the window list from
`EnumWindows` (visible, titled, with the owning process name); the asked window is
the first whose title or process name contains the text, bounds from
`DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`; else the primary screen.
`Graphics.CopyFromScreen` → `capture.png`; `capture.json` `{ok, width, height,
windows:[{app,title}]}` or `{ok:false, error}` listing the windows it saw. The
manifest's PerMonitorV2 awareness keeps everything in physical pixels.
`ponytail:` CopyFromScreen — an occluded window shows what covers it; switch that
path to `PrintWindow(PW_RENDERFULLCONTENT)` when it bites.

**Probe** (`Probe.cs`, read-only): `window.png` from `CapturePreviewAsync` when
the page shows, `DrawToBitmap` of the placeholder otherwise; `state.json` with
`visible, page, placeholder, up, misses, running, supervised, waiting, badge,
permission, hotkey, fullscreen`.

**Appearance.** `appearance {light}` → `DwmSetWindowAttribute(
DWMWA_USE_IMMERSIVE_DARK_MODE)` on the window and the panel, remembered for the
next launch. MessageBoxes keep Windows' own look.

**Rebuild App.** The tray item and the tab's REBUILD run `bin/mystical app`
through `wsl.exe`, detached, logging to `~/.bridge_state/app-build.log`; `build.sh` quits this
instance over the pipe, swaps the files and reopens it. A non-zero exit shows
the log's tail in a MessageBox; the state line says "● rebuilding the app…" while
it runs.

**`--check`-free testing.** `windows/check` is a second, console csproj that
compiles `app/Core/*.cs` straight in: no test framework package, plain asserts,
exit 1 on the first failure — the repo's `*.check.ts` shape.

## Build, install, setup

`windows/build.sh` (behind `mystical app` on WSL):
1. WSL2 and `dotnet.exe` (interop PATH, else `/mnt/c/Program Files/dotnet/`) — or
   die naming `winget install Microsoft.DotNet.SDK.10`. SDK major from
   `dotnet.exe --version`; 8 is the floor.
2. `%LOCALAPPDATA%` from `cmd.exe /c echo %LOCALAPPDATA%`, through `wslpath -u`.
3. Stage `windows/app/` into `%LOCALAPPDATA%\Mystical\build\src` (the build runs
   on the Windows side — `obj/` on a 9P share is slow and UNC-hostile), write
   `app.ico` (PNG-in-ICO from `icon-192.png`, by python, no PIL), then
   `dotnet.exe publish -c Release -r win-x64 --self-contained false
   -o …\build\out`, the staged csproj's `TargetFramework` rewritten to the
   installed SDK's major first (a `-p:TargetFramework` override is ignored by
   `dotnet run`'s implicit restore), so no second targeting pack is fetched and
   the runtime always matches; `RollForward=LatestMajor` is the belt. Errors to the
   terminal, the full log to a temp file.
4. `mystical.json` into `out`. `repo` is this checkout unless `MYSTICAL_APP_REPO`
   names another — a worktree build that should drive the live bridge.
5. Install: if the app is running, `Mystical.exe --quit` (then `taskkill` after
   5 s); stop a running `tray.ps1`; swap `out` into
   `%LOCALAPPDATA%\Programs\Mystical` (rename-old, move, delete-old — a failed
   step leaves the installed app alone); `reg.exe add` the `mystical` scheme;
   a Start Menu shortcut (`WScript.Shell` via `powershell.exe`); reopen if the
   app or the tray was running — through PowerShell's `Start-Process`: run from
   WSL, `cmd.exe /c start` waits for its GUI child and hangs the caller. Back in `bin/mystical`,
   `startup.refresh_launcher()` rewrites the Startup `.cmd` if login is on.
   `MYSTICAL_APP_DEST` (a Windows path) builds a dev copy: no quit, no tray
   stop, no registry, no reopen, no `.cmd` — same as the Mac.

Measured here: restore 2.4 s, publish 7 s, 27 MB framework-dependent output.
The WebView2 package's WPF assembly raises MSB3277 (WindowsBase versions);
`NoWarn` it in the csproj with a comment.

`bridge/startup.py` (WSL branch): `_win_app()` = the one Windows profile's
`AppData/Local/Programs/Mystical/Mystical.exe` when it exists (the profile root
`_startup_dir()` already finds). With it, `_script(open_window=True)` writes
`start "" "<exe>"` after the wait loop instead of the tray line and the browser
`--app=` line (the app has its own placeholder, so it starts whether or not the
bridge answered, like the tray does today); `launch_tray()` starts the exe;
`state()["browser"]` reads `"Mystical.exe"`, and `state()["window"]` recognises
the exe line as well as `--app=` (today's test is `"--app=" in text` alone —
left as is, the switch would read off the moment it was written). Without the
exe, nothing changes.

**Taking over from the tray** (the builder check's question; my call). A machine
with OPEN THE WINDOW TOO already on has a `.cmd` that starts `tray.ps1` and a
browser window, and often a tray running right now. Three things make the swap
seamless, none of them a switch toggle:
1. `startup.refresh_launcher()` — new, narrow: rewrites the `.cmd` from the
   current `state()` (login on, window, pinned profile) and nothing else; no
   `systemctl enable`, no linger. `bin/mystical app` calls it after a successful
   `windows/build.sh` (that branch already sources `.env`, so `config.DASH_PORT`
   is right). `apply()` keeps writing the same text, so a later toggle changes
   nothing.
2. `build.sh`'s install step stops a running `tray.ps1` — the `powershell.exe`
   whose command line names it, via `Get-CimInstance Win32_Process` — before it
   reopens the app.
3. `Program.cs` holds the tray's own mutex, `Local\mystical-tray`, beside its
   `Local\mystical-app`: a stale `.cmd` on some other machine that still starts
   the tray gets a tray that exits at once (`tray.ps1` already does that when the
   mutex is taken), so there is never a second icon.

`bin/mystical app` on WSL: no argument → `windows/build.sh` when `dotnet.exe` is
reachable, else today's tray launch; `open` → the installed exe (die naming
`mystical app` if not built). Usage line updated. Linux unchanged.

`setup.sh`: the doctor on WSL lists `dotnet.exe` as optional ("builds the Windows
app (Mystical.exe)"; missing → the winget line, and "the PowerShell tray still
works"). A WSL step after the macOS block offers the build the way the Mac one
does; START AT LOGIN is the existing systemd + Startup-folder path.

## The dashboard

`lib/mac.ts`: `isMacApp()` (UA `MysticalMac/`), new `isWinApp()` (`MysticalWin/`)
and `isNativeApp()`; `MacSettings` gains `platform?: "mac" | "windows"`,
`hotkey?: boolean`, and `keepInDock` becomes optional. `handler()` is unchanged —
the Windows shim installs the same object. `installprompt.isInstalled()` matches
both user agents.

Gates that widen to `isNativeApp()`: the banner-with-buttons path in App.tsx's
awaiting transition, the window-title mirror, the SETTINGS rail and search
entries for the tab. Gates that stay `isMacApp()`: `--mac-titlebar` drag, the
Brand cap's traffic lights.

The tab: key `mac` stays; label and `about` read "MAC APP" / "WINDOWS APP" by
platform; icon `AppWindowMac` / `AppWindow`. Rows: SESSION IN THE TITLE (both);
KEEP IN DOCK (Mac, when the reply carries it); WAITING ON YOU PANEL (both; the
copy says "every Space" on the Mac, "on top of every window" on Windows);
SUMMON WITH WIN+CTRL+A (Windows); VERSION + REBUILD (both, copy per platform:
`mystical app` rebuilds from the checkout and reopens); SCREEN CAPTURE (both;
Windows: "through windows/capture.sh; no permission to grant").

No Python under `bridge/dashboard` changes; `lib/push.ts` and `lib/banner.ts`
need none.

## Error handling

- `status --json` fails, or `repo/bin/mystical` is gone from `\\wsl.localhost`
  → the *can't find the checkout* placeholder naming the path and `mystical app`.
- `wsl.exe` not found, or the distro is gone → the same placeholder, with the
  distro named.
- A lifecycle or rebuild command exits non-zero → a MessageBox with the last
  1500 characters of its output (the Mac's `alert`).
- Toasts disabled for the app or the user → `Notification.permission` reads
  `denied`; the dashboard flips its toggle off and says where (its copy already
  points at the OS setting).
- The hotkey chord is taken → one balloon; everything else works.
- Pipe request with a relative or unreachable `dir` → `{ok:false, error}`; the
  wrappers print it and exit 1.
- Two instances → the second forwards (a link) or just exits (nothing to forward).

## Testing

- **`windows/check`** (`dotnet.exe run`, staged like the app): status JSON
  (running, stopped, garbage, running-but-not-answering); waiting list and
  working count from a recorded `/local/running`; the seven URL-policy cases;
  session links and `sameDashboard`; deep links incl. the never-command rule;
  prefs round-trip through a temp JSON; action sanitising (empty, duplicate,
  clipped, capped at four); capture request parsing (rooted dir, trimmed window,
  matching).
- **`node windows/shim.check.mjs`**: shim.js under a fake `chrome.webview` —
  posts only when granted, ids from tags, click and action dispatch, close,
  requestPermission adopting the answer, installs once, replies resolve by id.
- **pytest** (`tests/test_startup.py`, `_win_app` monkeypatched): the .cmd starts
  the exe and drops the tray and browser lines when it's installed, and is
  unchanged when it isn't; `state()` reads the exe line as the window half;
  `launch_tray()` prefers the exe; `state()["browser"]`; `refresh_launcher()`
  rewrites the .cmd only when login is on and never touches systemd.
- **Dashboard**: `npx tsc -p tsconfig.app.json --noEmit`; the existing checks.
- **On this machine** (Windows 11 + WSL 2.4, the user's): `mystical app` builds
  and opens it; `windows/probe.sh` → `window.png` shows the HUD, `state.json`
  says `up`; `windows/capture.sh -w Mystical` → a PNG of the window;
  `windows/capture.sh` → the primary screen; a real question with no window in
  front → a toast with the card's buttons, and a tap answers it; Win+Ctrl+A
  toggles the window; `cmd.exe /c start mystical://open` raises it; tray Stop →
  placeholder with START, Start → the page is back; REBUILD from the tab swaps
  and reopens; log out and in → the app comes back through the `.cmd`.

**The risk spike, resolved (2026-10-16):** toast *activation* on an unpackaged
exe needed more than the `Activated` event — a tap on a toast that had left the
screen reached nothing until the COM activator above was added; with it, a body
tap and an Allow button both reached the page's handlers (the user tapped them).

## Where it's built

In a worktree (bridge-worktree skill). `mystical.json` must name the main
checkout, so the final `mystical app` runs there after merge; a worktree build
goes to `MYSTICAL_APP_DEST`. Shipping is a dashboard dist rebuild (`mystical
build`) for the page changes, `mystical app` for the exe (which also rewrites
the Startup `.cmd`), and a bridge restart only so the SYSTEM tab's switch runs
the new `startup.py`.
