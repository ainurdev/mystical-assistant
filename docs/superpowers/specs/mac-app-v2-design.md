# Mystical.app v2 — what the native shell does that a tab can't

## Why

The first Mystical.app (`macos-app-design.md`) earned its place with three things a
browser tab can't do: banners with the window closed, a menu bar count, and
Start/Stop/Restart without a terminal. This round adds the rest of what the user
picked from the "what could a Mac app do" list, in one batch:

1. **Answer from the banner** — Allow/Deny and a question's options as buttons on
   the macOS notification, answered without opening the window.
2. **Native chrome follows the theme** — alerts, the file picker and the title bar
   go light or dark with the dashboard's palette, instead of the system's.
3. **The window title is the open session** (a switch).
4. **The HUD runs edge to edge** under a transparent title bar.
5. **Dock right-click menu** with the "Waiting on you" rows.
6. **Rebuild App** from the menu bar, with the app's version shown.
7. **The menu bar says busy** — a different glyph while any session works.
8. **Keep in Dock** (a switch, default on) instead of the Dock-icon flip that may
   break the Dock's Assign To Space pin.
9. **`mystical://` deep links** — a link opens the app on a session.
10. **Screen capture for agents** — a bridge session can capture the screen or one
    window through the app, which can hold the Screen Recording permission a
    `claude -p` child never gets.
11. **A floating "waiting on you" panel** (a switch) — always on top, on every
    Space, while the dashboard isn't in front.
12. **Two Apple-friendly themes** — CUPERTINO (light) and GRAPHITE (dark): system
    type, Apple's semantic colours, no CRT.
13. **A MAC APP settings tab**, shown only inside the app, holding the switches.

Not in this round (named so nobody looks for them): a global hotkey, Services
menu, Finder reveal / Quick Look, a second window, dropping a folder on the Dock,
notification image attachments.

## Decisions

| Question | Decision |
|---|---|
| Where the app's switches live | **The app owns them** (`UserDefaults`); the page reads and writes them over the existing message handler (`settings` / `set` ops). One source of truth, so Dock and panel are right at launch before any page loads, and a reload or a second web view never resets them. |
| Banner buttons: who answers | **The page.** The app routes the tapped action back into the page (`__mysticalNotificationAction`), which POSTs the same `respond` the card uses. The page is alive while the window is merely hidden. If it's gone (reloaded), the app falls back to opening the session. No token handling or POST logic in Swift. |
| What the banner needs to know | The awaiting transition already fires in `App.tsx`; the page fetches the job's pending list (`GET /local/run/<job_id>?cursor=…`, already served) and turns the first pending card into ≤4 actions. **No bridge change** — the running bridge serves this today. |
| Appearance | The page tells the app `light`/`dark` whenever the theme changes (`isLight(theme)`); the app sets `NSApp.appearance` and remembers the last value for the next launch. No theme logic in Swift. |
| Title bar | `titlebarAppearsTransparent` + `.fullSizeContentView` + `titleVisibility = .hidden`: the HUD's top row is the title bar (the window title still names Mission Control and the Window menu). The app injects `--mac-titlebar: <h>px` at document start; the Brand cap insets past the traffic lights, and a press on the row's bare surface posts `drag`, which the app answers with `performDrag(with:)` — a web view never moves the window by itself. |
| Keep in Dock default | **On.** ⌘-Tab works and the Space pin is safe; the old flip to menu-bar-only is the off position. |
| Floating panel | A borderless, non-activating `NSPanel` at `.floating` level on all Spaces, listing the awaiting sessions; visible only while the list is non-empty and the dashboard window isn't key. Click a row = open that session. |
| Deep links | `mystical://session/<id>`, `mystical://open` (also `mystical://open?s=<id>`). A link opens things; it never starts, stops or restarts anything. |
| Screen capture API | **Request-only**, same shape as the probe: `macos/capture.sh [-w <title>] [dir]` posts a distributed notification; the app writes `capture.png` + `capture.json` with ScreenCaptureKit. Permission is asked once (macOS prompt); the error names the setting. |
| Rebuild | Runs `bin/mystical app` **detached**, output to `~/.bridge_state/app-build.log`: build.sh quits and reopens the app itself, so a piped child would die with us. A non-zero exit shows the log tail. |
| Themes | Two more `ThemeDef`s; CUPERTINO joins `LIGHT_KEYS` and the contrast test's canvas table; GRAPHITE is copied into the Mini App's `theme.ts` (the sync test requires every dark theme there). Neither needs `data-theme` shape rules. |

## The channel, extended

`NotificationShim.handlerName` (`mysticalNotify`) already carries `{op,…}` messages
with replies. New ops:

| op | from page | reply |
|---|---|---|
| `show` | `{id,title,body, actions?: [{id,title}]}` | — (actions → a `UNNotificationCategory`) |
| `settings` | — | `{keepInDock, floating, titleFollowsSession, version}` |
| `set` | `{key, value}` | the same dict, after |
| `appearance` | `{light: bool}` | — |
| `rebuild` | — | — |

Page globals the app calls: `__mysticalOpenSession(id)` (exists),
`__mysticalNotificationClick(id)` (exists), **`__mysticalNotificationAction(id, action)`**
(new; false = the page lost that notification → open the session).

The shim's `Notification` gains the standard `actions: [{action, title}]` option
(browsers honour it only for service-worker notifications; here the app does) and
an `onaction(actionId)` handler.

`lib/mac.ts` (dashboard) wraps all of it: `isMacApp()` (UA `MysticalMac/`),
`macSettings()`, `macSet()`, `macAppearance()`, `macRebuild()`, `titlebarPx()`.
Off the Mac every call is a no-op or resolves to `null`.

## Feature notes

**Banner actions.** In `App.tsx`'s awaiting transition, when in the app and the
status carries a `kind`: look up the session's `job_id` in the last `/local/running`
payload, fetch the job's `pending`, and build actions from its first card —
permission → Allow / Deny; a single, single-select question with ≤4 options → its
labels (ids `opt:<n>`). Multi-select or multi-question cards get no buttons (the
banner still opens the session). `onaction` POSTs `api.respond(job_id, …)`. The
sound still plays immediately; only the banner waits on the fetch.

**Busy glyph.** `sparkle` idle, `sparkles` while any session's state is `working`
(every source: a terminal session working is busy too); the waiting count stays
beside it; tooltip reads "2 working · 1 waiting on you".

**Dock menu.** `applicationDockMenu` returns the same "Waiting on you" rows as the
status menu plus Open Dashboard. Dock menus can't carry key equivalents.

**Rebuild App.** Menu bar: a disabled "Mystical <MysticalVersion>" line and
"Rebuild App". While it runs the state line says "● rebuilding the app…"; on success
build.sh quits and reopens us; on failure an alert shows the log tail. The MAC APP
tab shows the version and has the same REBUILD button (op `rebuild`).

**Keep in Dock.** On: `.regular` always. Off: today's flip (`.accessory` while
hidden). Applied immediately on change.

**Window title.** The page sets `document.title` — `mystical//assistant` at boot in
the app, the open session's title when the switch is on. The app mirrors
`webView.title` into the window title (KVO). Browser tabs are untouched.

**Screen capture.** `Capture.swift` observes `cloud.ainurhq.mystical.capture`
(object: JSON `{"dir","window"?}`). Without permission it calls
`CGRequestScreenCaptureAccess()` (one macOS prompt) and writes `capture.json`
`{ok:false, error}` naming System Settings › Privacy & Security › Screen Recording.
With it: `SCShareableContent` → the first window whose title or app contains
`window` (case-insensitive), else the main display → `SCScreenshotManager` →
`capture.png`; `capture.json` lists the windows it could see. `shortcut:` the app
is ad-hoc signed, so macOS treats each rebuild as a new app and the permission has
to be re-granted; a stable self-signed identity in build.sh would fix it, when
captures are used often enough to matter. Agents read the PNG and `Attach` it.

**Themes.** CUPERTINO: canvas `#ebedf0` → panel `#ffffff`, accent a deeper
system blue (Apple's `#007aff` is 3.98:1 on white, below the test's 4.45 floor),
ink ladder from Apple's label greys, `-apple-system` type, SF Mono, 10px radii,
`halo` chat. GRAPHITE: canvas `#1c1c1e` → panel `#2c2c2e`, Apple's dark-mode
system colours (`#0a84ff`, `#30d158`, `#ff453a`, `#64d2ff`, `#bf5af2`), same type
and radii. Both: no CRT, no sweep, no glow.

**MAC APP tab.** Group THE HUD, icon `AppWindowMac`, hint "window · dock · panel",
only when `isMacApp()` (rail and search both filter). WINDOW: SESSION IN THE
TITLE, KEEP IN DOCK. PANEL: WAITING ON YOU PANEL. APP: VERSION + REBUILD, and one
line on screen capture.

## Files

```
macos/Sources/MysticalCore/   Running (+working), DeepLink, MacPrefs, CaptureRequest,
                              NotificationShim (+actions, +category id)
macos/Sources/Mystical/       AppDelegate (dock menu, glyph, rebuild, deep link, prefs),
                              DashboardWindow (title bar, title KVO, titlebar var, action
                              routing), Notifier (ops, categories, actions),
                              FloatingPanel (new), Capture (new), Bridge (+rebuildApp)
macos/Tests/MysticalCoreTests/CoreTests.swift
macos/build.sh                CFBundleURLTypes; no quit/reopen when MYSTICAL_APP_DEST is set
macos/capture.sh              new
bridge/dashboard/web/src/lib/mac.ts (+ mac.check.ts), lib/push.ts, lib/theme.ts,
                              api.ts (job snapshot), App.tsx, components/hud/SettingsModal.tsx
bridge/miniapp/web/src/lib/theme.ts   GRAPHITE
tests/test_light_theme_contrast.py    CUPERTINO canvas
CLAUDE.md                     the macOS line names capture.sh
```

No Python under `bridge/` changes: the running bridge already serves everything
the page needs, so shipping is a dashboard dist rebuild plus `mystical app`.

## Testing

- `cd macos && swift test`: working count, deep links, prefs round-trip, shim
  actions (JavaScriptCore), action sanitising + category id, capture request.
- `python3 -m pytest tests/ -q`: CUPERTINO clears every ink floor; GRAPHITE
  matches on the phone.
- `npx tsc -p tsconfig.app.json --noEmit` in both webs; `node …/mac.check.ts`.
- On the Mac: a dev bundle (`MYSTICAL_APP_DEST=/tmp/…`) probed for the title bar
  and the glyph; theme screenshots through `.mystical/probe-mac/cdp.mjs`; the
  final `mystical app` after merge, then a banner with buttons on a real question.
