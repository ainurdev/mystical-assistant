# Dashboard Shell Re-skin + Unified Visual Identity (Sub-project A)

**Date:** 2026-06-23
**Status:** Approved — ready for implementation plan
**Source design:** Claude Design project "Mystical Assistant Dashboard" (`Mystical Assistant Dashboard.dc.html`)

## Context

The desktop dashboard (`bridge/dashboard/web`, React 19 + Vite + Tailwind v4) and
the Telegram Mini App (`bridge/miniapp/web`) currently share one "mystic violet"
visual identity via verbatim-duplicated CSS tokens. A new Claude Design mockup
proposes a richer, darker desktop dashboard: a refined 3-pane layout with a
redesigned header, sidebar, chat stream, composer, a tabbed right panel
(Git / Issues / Diff / Logs), per-repo git status badges, and a ⌘K command
palette.

Several mockup features have **no backend today**: per-repo git status, a Diff
viewer, a GitHub Issues tab, and the command palette. Building the whole mockup
is too large for one spec, so the work is decomposed into four sub-projects:

- **A — Unified visual identity + dashboard shell** *(this spec; no new backend)*
- **B — Git intelligence** (per-repo `git status` + working-tree diff backend;
  sidebar git badges, Git tab, Diff tab)
- **C — GitHub Issues tab** (issues backend; Issues tab)
- **D — Command palette** (⌘K modal + real actions across the existing API + B/C)

Dependency order **A → B → C → D**. Each gets its own spec → plan → build cycle.
This spec covers **A only**.

## Goals (Sub-project A)

1. Adopt the mockup's palette + **Geist** typography as the **shared** identity of
   **both** the dashboard and the Mini App (re-unify, not diverge).
2. Restructure the dashboard to the mockup's 3-pane layout and component styling,
   wired entirely to data the server already returns.
3. Leave clean extension points for B/C/D (tabbed right panel, git-badge row slot,
   ⌘K button) without shipping fake data.

## Non-goals (deferred to B/C/D)

- Per-repo git status badges with real branch/dirty/ahead-behind data (B).
- Git tab, Diff tab (B). Issues tab (C). Command palette actions (D).
- Making the "accept edits" / permission-mode chip *changeable* from the dashboard
  (A renders it read-only from real state).
- Any change to the Python backend. A is frontend-only.

## Approach

### Token strategy: change values, keep names

Both clients already drive styling through CSS variables consumed by Tailwind
utility classes (`bg-card`, `text-muted-foreground`, `border-border`,
`bg-primary`, …). Re-pointing the variables to the mockup palette makes every
existing utility class adopt the new look with minimal per-component churn.

Update **both** files, keeping them in sync (the "keep in sync" contract already
documented in their headers):

- `bridge/dashboard/web/src/index.css`
- `bridge/miniapp/web/src/index.css`

**Re-pointed existing tokens (mockup values):**

| Token | New value |
|---|---|
| `--background` | `#0e0c14` |
| `--card` | `#15121f` |
| `--foreground` | `#e9e7f0` |
| `--primary` | `#7458ff` |
| `--primary-foreground` | `#ffffff` |
| `--secondary` | `#1c1729` |
| `--muted-foreground` | `#9c95b0` |
| `--border` | `#241f33` |
| `--ring` | `#8b6dff` |
| `--accent` | `#1a1527` (hover surface) |
| `--popover` | `#1a1527` |

The legacy `--tg-*`, `--brand*`, `--surface-2` names are kept and re-pointed to
the same palette so nothing referencing them breaks. `--brand-soft` → `#8b6dff`.

**New tokens (mockup needs these; currently absent):**

| Token | Value | Purpose |
|---|---|---|
| `--panel` | `#120f1a` | header / sidebar / right-panel background |
| `--panel-border` | `#221d30` | panel dividers |
| `--muted-2` | `#6a6380` | faint timestamps / mono labels |
| `--success` | `#5ad18c` | running / connected / additions |
| `--warning` | `#e2b15a` | idle / dirty |
| `--danger` | `#e5736b` | errors / deletions |
| `--surface-vs` | `#8b6dff` | VS Code chip |
| `--surface-tg` | `#6fb5ff` | Telegram bot chip |
| `--surface-ma` | `#b08bff` | Mini App chip |
| `--surface-web` | `#5ad18c` | Web/dashboard chip |

Each surface color also gets a translucent background variant (e.g.
`--surface-vs-bg: rgba(139,109,255,.14)`), used for chip fills.

These new tokens are exposed to Tailwind v4 via the `@theme inline` block
(`--color-success`, `--color-warning`, `--color-panel`, etc.) so they're usable
as `bg-panel`, `text-success`, `border-panel-border`, and so on.

Also update, to match the mockup:
- the `body::before` violet aura (keep the signature glow, retune to the darker bg);
- the custom `::-webkit-scrollbar` thumb (`#2c2640`) and Firefox `scrollbar-color`;
- the keyframes `mpulse` (pulsing status dot), `mfade`, `mpop` (popover/modal entrance).

### Typography: self-hosted Geist

Add dependencies `@fontsource/geist` and `@fontsource/geist-mono` to **both**
web `package.json`s. Import the needed weights in each `main.tsx`
(`400/500/600/700` for Geist; `400/500` for Geist Mono). Set the body font to
`'Geist', -apple-system, sans-serif` and map Tailwind's `font-mono` to
`'Geist Mono', monospace` (via `--font-mono` in `@theme inline`). Self-hosting is
chosen over the mockup's Google-Fonts CDN link because the dashboard is a
localhost tool that must work offline.

### Dashboard component structure

Keep the existing 3-pane skeleton; re-proportion to the mockup (312px sidebar ·
flex chat · 372px right panel) and extract focused components instead of growing
`App.tsx`:

- **`components/Header.tsx`** *(new)* — logo + `mystical-assistant` wordmark,
  bridge-connected pill, Chat/History toggle, surface chips, ⌘K search button,
  Start-server / Preview controls. `App.tsx`'s inline `<header>` and
  `ServerControls` move here.
- **`components/Sidebar.tsx`** *(restructured)* with sub-parts:
  - `ProjectSwitcher` — active-repo dropdown (existing `api.select` + folder
    browse) restyled to the mockup popover, plus "New chat".
  - `ProjectList` — repos that have sessions, each with a running/active dot.
    *Leaves a slot for B's git badges; no git data in A.*
  - `ActiveSessions` — from `/local/running`; surface badge, machine, "ago",
    status dot. (Replaces/absorbs today's `RunningNow`.)
  - `RecentChats` — recent sessions grouped by repo (title · count · ago);
    click opens the session.
- **`components/ChatHeader.tsx`** *(new)* — session title, surface badge derived
  from session `origin`, `model · N turns`.
- **`components/Transcript.tsx` / `RunStream.tsx`** — restyled to the mockup
  message styles: user bubble (right, violet), plain text, mono tool-chip with
  per-tool icon color, gradient-bar summary card for the final result.
- **`components/Composer.tsx`** — restyled; context strip wired to real usage
  (see below). Model/effort/attach/Send behavior unchanged.
- **`components/RightPanel.tsx`** *(new)* — a tab-capable container that in A
  registers only the **Logs** tab. The tab list is data-driven so B/C add
  Git/Issues/Diff with no refactor. Wraps the existing `Logs.tsx` (restyled).

### Data wiring — real vs. deferred (A)

| Mockup element | Source in A |
|---|---|
| `bridge connected · localhost:PORT` | page is bridge-served; port from `location` |
| Chat / History toggle | existing `view` state |
| Surface chips TG / MA | present (bridge serves bot + Mini App) |
| Surface chip VS | green when a VS Code session is live in `/local/running` |
| Start server / Preview | existing `api.server` / `api.preview` |
| Project switcher | existing `api.select` / `api.projects` |
| Project list | sessions grouped by project (as today) |
| Active sessions | `/local/running` (`external` + `bridge_running`) |
| Recent chats | `/local/sessions` / `/local/history` |
| Chat header title / origin badge | selected `SessionBrief` (`title`, `origin`) |
| `model · N turns` | current `model` state + `turns.length` |
| Message stream | existing transcript events (text/tool/result) |
| Composer context meter | `/local/usage` five-hour `percent` |
| Composer "resets in …" | `/local/usage` `resets_at` |
| Composer "accept edits" chip | `/local/state` `permission_mode` (read-only) |
| Logs tab | existing SSE `/local/stream/logs` |

**Visual placeholders flagged for later sub-projects (no fake data):**

- ⌘K "Search & commands" button — rendered, inert in A, wired in **D**.
- Project-row git badge slot — empty in A, filled in **B**.
- "accept edits" chip — read-only real value in A; made changeable later.
- Git / Issues / Diff tabs — not rendered in A; container supports them for **B/C**.

## Components and boundaries

Each new component has a single purpose and a narrow prop interface driven by data
`App.tsx` already owns (project, sessions, running, selected session, view,
model/effort, usage). `App.tsx` stays the orchestrator (polls + state); presentation
moves into the components above. The `RightPanel` exposes a `tabs` array
(`{ id, label, badge?, render() }`) so later sub-projects register tabs without
touching the container.

## Error handling

No new failure modes. Polls already swallow errors and reconcile on the next tick;
new components inherit that. Missing/!available usage hides the context strip
(as `UsageStrip` does today). Missing `permission_mode` hides the accept-edits chip.

## Testing / verification

- `tsc -b && vite build` for **both** `bridge/dashboard/web` and
  `bridge/miniapp/web` (type-check + production build pass).
- Load the dashboard against a running bridge; confirm all three panes render, the
  new palette/font apply, and real data flows (projects, sessions, running, usage,
  logs, chat round-trip).
- Mini App: confirm the new palette/font apply with no layout regression
  (headless screenshot per the project's screenshot-miniapp flow).
- No Python/backend changes in A → existing backend tests unaffected.

## Rollout

A is shippable on its own: it delivers the full visual redesign wired to existing
data. B/C/D layer on top via the extension points above.
