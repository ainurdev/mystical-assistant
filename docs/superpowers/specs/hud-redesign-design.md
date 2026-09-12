# Mystical Assistant HUD Redesign

**Date:** 2026-06-23
**Status:** Approved — ready for implementation plan
**Source design:** Claude Design project "Mystical Assistant Dashboard" → `Mystical Assistant HUD.dc.html`
**Supersedes:** the violet "Mystical" dashboard shell (A→D). All feature logic is reused.

## Context

The previous redesign (sub-projects A→D) built a violet "Mystical" dashboard with
real data: projects/git badges, sessions, terminal-able chat, Git/Issues/Diff/Logs
tabs, ⌘K palette, usage. A new mockup, `Mystical Assistant HUD.dc.html`, reskins
the **same** dashboard into a sci-fi **CRT terminal HUD**: teal-green palette,
monospace fonts, scanlines, panel corner-brackets, boot/flicker animations, and
ambient telemetry (sparklines, a context-matrix cell grid, an I/O waveform).

**Decisions (approved):**
1. **Replace** — the dashboard becomes HUD-only; the violet shell (Header,
   ChatHeader, RightPanel, Sidebar, violet tokens) is retired. Feature components
   are reused under the new skin.
2. **Real-derived telemetry** — charts/stats are driven by real signals; nothing
   is fabricated. Metrics with no signal (latency) are omitted.
3. **Re-theme both** — HUD palette + fonts (+ CRT overlay) also apply to the
   Telegram Mini App, keeping the "one product" unity. The Mini App keeps its
   mobile layout (tokens/fonts/scanlines only — no relayout).
4. **Full CRT FX** — scanlines + moving sweep + boot/flicker entrance, per the
   mockup.

No backend changes. This is a frontend reskin + relayout reusing the existing
data polls and feature components.

## Goals

1. HUD theme foundation (tokens, fonts, primitives) shared by both clients.
2. Dashboard relayout to the HUD grid (strip · 3-column · status bar) with the
   CRT overlays.
3. Real-derived telemetry (sparklines, waveform, context-matrix, stat grids).
4. Reskinned feature components (terminal chat, Git/Issues/Diff/Logs, palette).

## Non-goals

- No theme toggle / no preserving the violet layout (Replace).
- No new backend, no new data endpoints. Telemetry derives from existing state.
- No Mini App relayout (tokens/fonts/scanlines only).
- No fabricated metrics. Latency and raw token counts (not exposed) are omitted;
  the stat grid uses real turns / tools / cost / errors instead.

## Theme foundation (both `index.css` — keep in sync)

Replace the violet token VALUES with HUD values (names kept so reskinned
components still resolve). Key tokens:

| Token | Value | Role |
|---|---|---|
| `--background` | `#060a0a` | app bg |
| `--panel` | `rgba(9,16,16,.5)` | side panels |
| `--card` | `rgba(7,13,13,.6)` | center/terminal, popovers |
| `--foreground` | `#bfe6de` | body text |
| `--primary` / `--brand` / `--ring` | `#7fe9d8` | teal accent |
| `--brand-bright` | `#dff8f2` | glow headings |
| `--muted-foreground` | `#6f938d` | dim labels |
| `--muted-2` | `#3c544f` | dimmest labels |
| `--border` | `rgba(127,233,216,.16)` | hairlines |
| `--border-bright` | `rgba(127,233,216,.4)` | active edges |
| `--success` | `#8fd9a8` | online/run/add |
| `--warning` | `#e3c279` | idle/dirty/mode |
| `--danger` | `#e0897a` | del/error/bug |
| `--violet` | `#b9a6ff` | model / MA / enhancement |
| `--blue` | `#6fb5ff` | TG |

`@theme inline` exposes `--color-*` for these (incl. `--color-violet`,
`--color-blue`, `--color-brand-bright`, `--color-border-bright`) and
`--font-sans`/`--font-mono` → the mono stack. Surface tokens map: VS→teal,
WEB→green, TG→blue, MA→violet.

**Fonts:** self-host **Share Tech Mono** (display/labels) and **JetBrains Mono**
(terminal/body) via `@fontsource/share-tech-mono` + `@fontsource/jetbrains-mono`,
replacing Geist in each `main.tsx`. Body font = Share Tech Mono; a `.font-jb`
utility / `--font-mono` = JetBrains Mono for terminal/code.

**Primitives (global CSS):**
- `.panel` — corner-bracket `::before`/`::after`.
- `.crt` — fixed scanline overlay; `.sweep` — animated vertical sweep (z above
  content, `pointer-events:none`).
- `.glow` — teal text-shadow.
- Keyframes: `boot, flicker, drawline, blink, mpulse, mfadeup, mslide, mpop,
  grow, twinkle, caret, sweepmove`.
- Scrollbar + `::selection` retuned to teal.

The Mini App gets the same `:root`/`@theme` + fonts, and a `.crt` overlay element
at its root; no layout changes.

## Dashboard layout (`App.tsx` rebuild)

```
┌ Strip: MYSTICAL//ASSISTANT · REMOTE DEV BRIDGE · BRIDGE ONLINE · MAIN SHELL ┐
│ grid 344px / 1fr / 368px (gap 13, pad 13)                                   │
│ ┌ left col (scroll) ┐ ┌ center Terminal ┐ ┌ right col (scroll) ┐           │
│ │ WorkspacePanel    │ │ header          │ │ SessionsPanel       │          │
│ │ TelemetryPanel    │ │ transcript      │ │ ReadoutTabs         │          │
│ │ ContextMatrix     │ │ composer (cmd)  │ │  (Git/Issues/Diff/  │          │
│ │ ProjectsPanel     │ │                 │ │   Logs)             │          │
│ └───────────────────┘ └─────────────────┘ └─────────────────────┘          │
└ StatusBar: MOUNT · USED/context · REPO · CHANGES · ⌘K COMMAND ──────────────┘
+ fixed .crt + .sweep overlays
```

Components (new `src/components/hud/`):
- `Panel` — wrapper: corner brackets, header row (`PANEL` / title), drawline
  divider, body.
- `Strip` — top hairline; `StatusBar` — bottom bar (real: project rel as MOUNT,
  active-repo dirty count as CHANGES, ⌘K opens palette, context% from usage).
- `WorkspacePanel` — live clock/date (telemetry), real stat grid
  (BRIDGE/SURFACES/MODEL/UPTIME), surface chips (TG/MA/VS, VS live from running),
  project switcher (folder browser moved here from Sidebar) + a **New session**
  action.
- `TelemetryPanel` — two SVG sparklines (AGENT ACTIVITY, TOOL THROUGHPUT) with AVG
  labels + stat grid (TURNS/TOOLS/COST/ERRORS) — all real-derived.
- `ContextMatrixPanel` — cell grid filled to usage %, RESETS IN + MODE (usage +
  permission_mode).
- `ProjectsPanel` — projects (from session-grouping) with git badges
  (branch/dirty/ahead/behind from `gitBadges`); click switches active repo.
- `SessionsPanel` — recent sessions (flat, newest-first) with surface tag +
  status + ago (click opens); plus the CONVERSATION I/O **waveform** SVG.
- `Terminal` — center: header (shell label, active session title, surface badge,
  CHAT/HIST toggle), terminal-style transcript, command-line composer.
- `ReadoutTabs` — the existing `RightPanel` reskinned (GIT/ISSUES/DIFF/LOGS,
  underline tabs, badges).

Retired: `Header.tsx`, `ChatHeader.tsx`, `Sidebar.tsx`, `RightPanel.tsx`'s violet
styling (the tab container is reused, reskinned). The folder-browser + project
data move into `WorkspacePanel`/`ProjectsPanel`; the session list into
`SessionsPanel`. `view` (chat/history) is kept: the center renders the Terminal or
a reskinned `HistoryView`, toggled by a CHAT/HIST control + the palette commands.

## Telemetry — real-derived (`src/lib/telemetry.ts`)

`useTelemetry({ running, toolCount, eventCount })` ticks every 1s and returns
`{ clock, date, uptime, sparkA, sparkB, wave }` (number[] rolling buffers, seeded
once). Pure helpers `poly(arr,w,h,pad)` and `wavePoly(arr,w,h)` (ported from the
mockup) and `avg(arr)` build SVG `points`.

| Buffer | Real signal sampled each tick |
|---|---|
| `sparkA` (AGENT ACTIVITY) | `running` → high jitter, else decays toward idle baseline |
| `sparkB` (TOOL THROUGHPUT) | delta of `toolCount` since last tick (scaled) |
| `wave` (I/O) | spike when `eventCount` increased since last tick, else ~0 |

App computes `toolCount` / `eventCount` / cost / errors from `turns` (real
transcript events), `running` from `active`. Clock/date/uptime from
`Date.now()`/mount time. CONTEXT MATRIX + context bar from `/local/usage`.

No `Math.random`-only series ship as "data": each buffer is driven by an actual
signal (running state, tool/event deltas). Small jitter is cosmetic smoothing
only, never a standalone metric.

## Reskinned feature components (logic unchanged)

- `RunStream` / `Transcript` — terminal style: user lines `~ ❯ …`, assistant text
  indented (Markdown preserved), tool rows as bordered `[TAG] detail`, result as a
  `RESULT // OK` bordered block. Blinking caret at the tail.
- `Composer` — command-line: `~ ❯` prompt, model chip, `SEND ▸` outline button;
  keep model/effort/attach/stop logic + context strip (HUD bar).
- `GitTab` / `IssuesTab` / `DiffTab` / `Logs` — HUD borders/labels/colors; same
  data and actions (commit/push, create issue, diff parse, log stream).
- `CommandPalette` — terminal modal: `~ ❯` input, left-border-accent rows; same
  command set/keyboard nav.

All keep their existing props and behavior (incl. the user's Markdown rendering
and scroll-to-latest). Only markup/classes change.

## Error handling

Unchanged from the existing components (polls swallow + reconcile; usage/permission
absent → hide those readouts). Telemetry never throws (pure buffer math); empty
buffers render empty SVGs.

## Testing

- `tsc -b && vite build` for **both** web apps.
- Backend test suites stay green (no backend touched): git 8, github 10, bridge
  69, native 5.
- Manual smoke against a running bridge: HUD renders; clock ticks; sparklines move
  with real agent/tool activity; projects/git, sessions, tabs, palette, commit/push
  and issue-create work; CHAT/HIST toggles.
- Headless screenshot if the libasound dependency is restored.

## Rollout

One coherent reskin delivered as a single plan with sequenced tasks (theme →
telemetry → shell → left panels → right panels → terminal → tabs/palette →
integration/Mini App). Shippable when both apps build and the smoke passes.
