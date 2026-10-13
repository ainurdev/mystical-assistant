# Mystical.app v2 — plan

Spec: `docs/superpowers/specs/mac-app-v2-design.md`. Worktree `feat/mac-app-v2`.
Each task ends green on its own checks and is one commit.

1. **Core** — `Running.working`, `DeepLink`, `MacPrefs`, `CaptureRequest`, shim
   `actions` + `__mysticalNotificationAction` + `NotificationShim.actions(_:)` /
   `category(for:)`; tests for each. → `cd macos && swift test`.
2. **App** — Notifier ops (`settings`/`set`/`appearance`/`rebuild`), categories +
   action routing; DashboardWindow: transparent full-size title bar, `--mac-titlebar`
   user script, title KVO, `notificationAction`; AppDelegate: Dock menu, busy glyph,
   version line + Rebuild App, deep links, Keep in Dock, floating panel; Bridge:
   `rebuildApp()`, `working`; `FloatingPanel.swift`, `Capture.swift`; build.sh
   (URL types, dev-dest guard); `capture.sh`. → `swift build -c release`, then a
   dev bundle + `probe.sh` (state.json shows `activationPolicy`, window.png shows
   the HUD under the title bar).
3. **Web** — `lib/mac.ts` + check; `push()` actions; `api.job()`; App.tsx
   (appearance, title, titlebar padding, banner actions with `onaction`); MAC APP
   tab + search entries; themes CUPERTINO/GRAPHITE (+ Mini App copy, + contrast
   canvas). → `tsc` in both webs, `node mac.check.ts`, `pytest tests/ -q`.
4. **Look** — scratch dashboard from the worktree, `cdp.mjs` shots of both themes
   and the MAC APP tab; `Attach` them.
5. **Ship** — merge to master, `mystical build` (dist), `mystical app` (bundle +
   reopen). No bridge restart (no Python changed). Then a real banner with buttons.
