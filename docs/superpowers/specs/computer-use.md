# Computer use: a session sees and drives this Mac

Re-checked 2026-11-21: `loop.py` exits 1 on CLI 2.1.329, so computer use is still absent in print mode. We build our own.

## Decided (grill, 2026-11-21)
- **Ask once per app per chat** (Claude's own `request_access` shape). One Allow covers the listed apps until the chat ends or is stopped. If the app in front isn't granted, the action fails and the chat says so.
- **Self-signed "Mystical Local" code-signing cert**: `macos/build.sh` makes it once in the login keychain and signs every build with it, so TCC keeps Screen Recording and Accessibility across rebuilds. Linux and Windows need nothing like it (see the end).

## States (computer-use.html, one column per state)
1. **Access ask**: a `COMPUTER` kind on AskDock (the warn/amber accent marks it as a question). Shows Claude's reason, one row per app with a tier, clipboard checkboxes, `Allow apps ⌘1` / `Deny ⌘2`. It asks in every mode, Bypass included: the MCP tool blocks on the bridge's own ask, not on Claude's permission prompt. Tiers: FULL (see, click, type) by default. LOOK (screenshot only) for terminals, IDEs and Script Editor, because typing there runs code.
2. **Driving**: a strip on the prompt box: pulse, `DRIVING`, app chips, action count, `STOP ESC`. Each action is a quiet Work line (`CLICK Safari · 412, 310`). A screenshot is a thumbnail with the ring where the last click landed.
3. **On the Mac**: Mystical.app draws a teal edge round the screen, a pill (`MYSTICAL IS DRIVING · <chat> · <apps> · ESC STOPS`) and a ring at each click. The menu-bar mark lights up, and its menu has Stop / Open the chat. The overlay windows ignore the mouse and are left out of our own screenshots.
4. **When it can't**: front app not granted (button: `ALLOW MAIL`, which re-asks for that one app); `DESKTOP BUSY` (another chat holds it, button: `STOP THAT ONE`); `STOPPED · ESC`; `MYSTICAL.APP ISN'T RUNNING`.
5. **Tools modal**: a `Computer use` row, off by default, per chat (toolsets + `store.get_disabled_tools`). Below it, the app's live TCC state (Screen Recording, Accessibility, signature), each with an `OPEN SETTINGS` deep link. Mac only: no row on Linux or Windows.

Telegram and the Mini App reuse PermissionCard for the access ask (Allow apps / Deny) and add a Stop button while it drives. No new design for them.

## Plumbing
- `bridge/computer_mcp.py`: stdio, stdlib only, like `verify_mcp.py`. `_mcp_config` declares it only when the chat has the tool on. Tool names and input shapes match Claude Code's list (`mcpcall.py list`): request_access, screenshot, zoom, left/right/double/triple/middle_click, type, key, scroll, left_click_drag, mouse_move, open_application, list_granted_applications, read/write_clipboard, wait, cursor_position, hold_key, left_mouse_down/up, switch_display, computer_batch. The descriptions are our own.
- **Grant + lock live in the bridge**: grant = `{session: apps, tiers, clipboard}`, in memory. There is one desktop lock (a session id). Stop from the chat, Esc or the menu clears the grant, frees the lock and interrupts the turn.
- **The app only obeys the bridge**: Mystical.app opens no listener for input orders. It dials the bridge (127.0.0.1:8790, the dashboard token it already has) and reads orders from that connection. Screenshots can stay on the existing distributed notification. Clicks and typing never go that way.
- **In the app**: ScreenCaptureKit with an `SCContentFilter` that takes only the granted apps (so other apps are hidden). CGEvent posts mouse and keyboard input. An active CGEventTap on Esc runs only while driving and swallows the key. Both need Accessibility, which the app asks for the first time the tool is switched on.
- **Tests**: the Swift input poster sits behind a protocol with a fake. Bridge tests use a fake app on the order channel. Nothing clicks or types on the real screen unless the user says yes first.

## Linux / Windows signing (asked)
Not needed. Linux has no per-app permission keyed to a signature. Windows lets any same-user app send input (UIPI only blocks input into elevated windows), so a stable signature buys nothing there. Both stay out of scope unless asked.

## Open
- Does Esc reach the app in front too, or does the tap swallow it? Draft: swallow it while driving.
- Which apps get LOOK by default: Terminal, iTerm, Ghostty, VS Code, Cursor, Xcode, Script Editor, System Settings?

## Approved 2026-11-21: notes for the build step
- User's note on approval: **send the screenshots from the real Mystical dashboard, in the user's current theme**, not mockup pages. Shoot the built dock, strip, rows and Tools row in the live dashboard UI (bridge-eyes), with the theme the user has set.
- Open items take the drafted defaults: Esc is swallowed while it drives. Terminals, IDEs, Script Editor and System Settings get LOOK.

## As built (feat/computer-use)
- Bridge: `bridge/computer.py` (grant, lock, card, order line), `bridge/computer_mcp.py` (relay), routes in `bridge/dashboard/server.py`, the switch as setting `computer_use:<session>`.
- App: `macos/Sources/Mystical/ComputerUse.swift`, `MysticalCore/ComputerCore.swift`; signing in `macos/signing.sh` (`--check` self-test).
- Dashboard: COMPUTER dock (`AskDock.tsx`), DRIVING pill (`ComputerPill.tsx`, `lib/computer.ts`), Tools row (`ToolsModal.tsx`), a stopped line in the transcript.
- Input lands only where the point (or the top window, for keys) belongs to a FULL app; Stop fails orders still in flight on both sides.
- Not built: per-action Work lines and screenshot thumbnails (generic tool rows), the DESKTOP BUSY strip and the ALLOW MAIL button (Claude gets the error and says so), a Stop button on Telegram and the Mini App (their turn Stop ends the drive, the grant stays), switch_display, asking for Accessibility at switch-on (asked at the first click), a fake behind the Swift event poster.
