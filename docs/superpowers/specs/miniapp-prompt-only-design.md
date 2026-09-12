# Mini App → prompt-only surface

**Date:** 2026-07-30
**Scope:** `bridge/miniapp/web` frontend only. No backend changes.

## Problem

The Mini App grew to nine tabs (`Run`, `Issues`, `History`, `Memory`, `Server`, `Shell`,
`Preview`, `Design`, `Teacher`) rendered in a single `flex-1` row with no horizontal
scroll. At the 390px width of a phone webview the row overflows and clips mid-way
through `Shell` — **Preview, Design and Teacher have no reachable tap target at all.**

The tabs also duplicate the dashboard HUD, which has a richer version of all nine. The
phone is where prompts get typed while away from a desk; it is not where a terminal,
a preview frame, or a selector overlay is usable.

## Goal

One screen: pick a project, pick a chat, type a prompt, answer Claude's questions.
No tab bar.

## Design

### The two survivors are not tabs

`History` and `Issues` stay, because both are already *prompt sources* that end by
returning to the run screen:

- `issues.tsx` → `setDraft(issuePrompt(i))` then `navigate({ to: "/" })`
- `history.tsx` → `openSessionInProject(...)` then `navigate({ to: "/" })`

They remain routes, reached from two icon buttons in the header rather than a nav bar.
Keeping them as routes (not modals) preserves hash-history behaviour, so Telegram's
back gesture works and no state has to be lifted into the layout.

### Header

Two rows — the same height as the old project-row + tab-row, with nothing clipped:

```
┌────────────────────────────────────────────┐
│ ✨ mystical-assistant ▾        ⏱   ◎      │  project picker · History · Issues
│ ● Refactor the mini app interface       ▾  │  session select + New   (only on /)
└────────────────────────────────────────────┘
```

- Row 1 renders on every route. The active route's icon highlights; tapping the active
  icon returns to `/`.
- Row 2 renders only on `/`, unchanged in behaviour from today. The session `<select>`
  moves off row 1 and loses its `max-w-[38vw]` clamp, so chat titles become readable.

### Deleted

| Path | Reason |
|---|---|
| `routes/{server,shell,preview,design,memory,teacher}.tsx` | Dashboard-side work |
| `components/TeacherView.tsx` | Only consumer was `routes/teacher.tsx` |
| `components/design/{DesignView,PreviewFrame,SelectionTray}.tsx`, `useSelector.ts` | Only consumer was `routes/design.tsx` |
| `tabs` array + `<nav>` in `routes/root.tsx` | Replaced by two header icons |

Nothing outside the tab bar linked to these routes (verified: no `to="/…"` or
`navigate({ to:` references them), so the cut has no inbound edges.

### Untouched

`Composer.tsx`, `lib/chat.tsx`, `RunStream.tsx`, `QuestionCard`, `PermissionCard`,
`MemoryCandidateCard`, `ReviewCandidateCard`, `RunningNow`, `AgentsPill`,
`AgentsModal`, `UsageStrip`, `FolderNavigator`.

Memory and review candidate cards already render inline inside `RunStream`, so
approving a memory from the phone still works after `/memory` is gone; only the
browse-and-pin view is lost.

`bridge/miniapp/server.py` keeps every endpoint. `bridge/dashboard/server.py` imports
from that module, and the endpoints the deleted routes used (`/api/shell`,
`/api/preview`, `/api/server`, `/api/memory/*`, `/api/learning/*`, `/api/graph/*`) are
still served for the dashboard. Removing them is out of scope.

### Dead client methods

Deleting the routes orphans methods in `lib/api.ts` (shell, preview, server, memory,
learning, graph). `tsc` does not flag unused *exports*, so each is grepped for
remaining references and dropped only when the count is zero. If the file's structure
makes that ambiguous, `api.ts` is left alone and the dead methods are reported rather
than guessed at.

## Found during implementation: "Not Found" on every Telegram launch

Verifying against a real Telegram launch URL surfaced a pre-existing bug unrelated to
the tab cut. Telegram opens the webview at `…/#tgWebAppData=<initData>&tgWebAppVersion=…`.
`telegram-web-app.js` reads that hash (`location.hash.toString()`) and **never writes to
it** — the file contains no `replaceState` and no `location.hash =`. `createHashHistory()`
then parses `tgWebAppData=…` as the route path, matches nothing, and renders `Not Found`
under a correctly-populated header.

Fixed in `router.tsx`, above `createHashHistory()`: if the hash exists and does not start
with `#/`, replace it with `#/`. Safe because `telegram-web-app.js` is a blocking script in
`<head>`, so it has already published `window.Telegram.WebApp.initData` from that hash by
the time this module evaluates — the hash is spent, and auth survives the rewrite.

## Verification

1. `tsc -b` exits clean.
2. `vite build` succeeds; `web/dist` is regenerated. The server reads `WEB_DIR` per
   request, so the new bundle goes live without restarting the bridge.
3. Headless screenshot at 390px against the running bridge on `:8787` — which
   exercises the real `/api/state`, `/api/running` and `/api/sessions` — for `/`,
   `#/history` and `#/issues`.
4. Confirm: no clipped header content, and both survivors reachable and returning
   to `/`.

## Non-goals

- Restyling the transcript, composer, or cards.
- Touching any Python.
- Recovering the dropped tabs elsewhere — they exist on the dashboard HUD.
