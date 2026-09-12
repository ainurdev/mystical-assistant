# Command Palette (Sub-project D)

**Date:** 2026-06-23
**Status:** Approved — ready for implementation plan
**Depends on:** A (shell + inert ⌘K button), B (Git/Diff tabs, controlled RightPanel), C (Issues tab) — all shipped.
**Source design:** Claude Design project "Mystical Assistant Dashboard".

## Context

A shipped the dashboard with an inert ⌘K "Search & commands" header button and no
global keyboard handler. D makes it live: a ⌘K command palette that launches the
actions already present across the app (sessions, view, server/preview, right-panel
tabs, git, model). Frontend-only — no backend changes. This is the last
sub-project of the dashboard redesign.

## Goals

1. A `CommandPalette` modal: search-filter a command list, keyboard-navigable,
   matching the mockup's styling.
2. Open via the header ⌘K button and a global ⌘K / Ctrl-K shortcut; close via Esc
   or backdrop.
3. Commands wired to existing handlers/state, with labels that reflect current
   state (e.g. Start vs Stop server).

## Non-goals

- No new command types beyond what the app already does (no fuzzy ranking beyond
  substring match, no recents/MRU, no command arguments). YAGNI.
- No backend changes. No new git/issues actions — palette navigates to the
  relevant tab for anything needing input or carrying write risk.

## Component: `components/CommandPalette.tsx`

Props:
```
interface Command { id: string; label: string; group: string; icon: string; run: () => void }
CommandPalette({ open: boolean; commands: Command[]; onClose: () => void })
```
Behavior:
- Renders null when `!open`. When open: a fixed backdrop (`rgba(8,6,14,.62)` +
  blur) centered near the top; an inner card (`mpop` entrance) with a search input
  (autofocus) and a scrollable result list.
- Local state: `query`, `highlight` (index into filtered list).
- Filter: case-insensitive substring match of `query` against `label` and
  `group`; empty query shows all. `highlight` clamps to the filtered length and
  resets to 0 on query change.
- Keyboard (listener active only while open): **↑/↓** move highlight (wrap),
  **Enter** runs the highlighted command, **Esc** closes. Backdrop click closes;
  inner click stops propagation. Clicking a row runs that command.
- Running a command calls `cmd.run()` then `onClose()`.
- Rows: icon chip (monospace glyph on a tinted square), label (flex-1), group
  (muted, right). Highlighted row uses an accent background.

## App wiring (`App.tsx`)

- State: `paletteOpen: boolean`.
- Global `keydown` effect: `(e.metaKey || e.ctrlKey) && e.key.toLowerCase()==='k'`
  → `preventDefault` + toggle `paletteOpen`; `Escape` → close. Registered once on
  mount.
- `commands: Command[]` built each render from current state + handlers:

  | Group | Label | Action |
  |---|---|---|
  | Session | New chat | `newSession()` |
  | Session | Switch project… | `setBrowsing(true)` (lifted; opens sidebar browser) |
  | View | Go to Chat | `setView("chat")` |
  | View | Go to History | `setView("history")` |
  | Server | Start/Stop dev server | `api.server(running?"stop":"start")` (label flips on `state.server.status`) |
  | Server | Open/Stop preview | `api.preview(url?"stop":"start")` (label flips on `state.preview.url`) |
  | Panel | Open Git / Issues / Diff / Logs | `setActiveTab(id)` |
  | Git | Commit changes… | `setActiveTab("git")` |
  | Git | Push to origin… | `setActiveTab("git")` (per approved scope: navigate, no silent push) |
  | Model | Use Opus / Sonnet / Haiku | `setModel(m)` |

  Both Git commands open the Git tab (distinct labels aid search; same safe
  destination). Server/preview labels reflect live state.
- Header gets `onOpenPalette` → sets `paletteOpen=true`; its ⌘K button's `onClick`
  calls it and the "coming soon" `title` is replaced with "Search & commands (⌘K)".
- `<CommandPalette open={paletteOpen} commands={commands} onClose={()=>setPaletteOpen(false)} />`
  rendered at the App root.

### Lifted state: sidebar `browsing`

"Switch project…" needs the sidebar's folder browser, whose `browsing` boolean is
currently internal to `Sidebar`. Lift it to App as controlled props
`browsing: boolean` + `onBrowsingChange: (v:boolean)=>void`; Sidebar uses them in
place of its local `useState`. Both the palette and the sidebar's "change" button
drive the same flag. (The `listing` fetch state stays internal to Sidebar.)

## Header change

`Header` gains an `onOpenPalette: () => void` prop; the existing ⌘K button uses it
for `onClick`. No layout change.

## Error handling

Running a command always closes the palette. API-backed commands
(server/preview) reuse the existing fire-and-forget `.catch(()=>{})` handling and
the 3s state poll reconciles labels. Navigation commands are pure state setters.
No new failure modes.

## Testing

- `tsc -b && vite build` (type-check + build).
- Manual: ⌘K opens the palette; typing filters; ↑/↓ + Enter runs; Esc/backdrop
  closes; "Start dev server" toggles the server; "Open Git" switches the tab;
  "Switch project…" opens the sidebar browser; "Use Sonnet" changes the composer
  model.
- Screenshot if the libasound headless dependency is restored.
- No unit tests — pure UI wiring, consistent with A's frontend tasks.

## Rollout

D completes the dashboard redesign (A→B→C→D). After it, the mockup is fully
realized with real data and actions.
