# HUD Boot Intro + Phosphor Theme Switcher

**Date:** 2026-06-23
**Status:** Approved — ready for implementation plan
**Builds on:** the HUD redesign (shipped).

## Context

The dashboard now wears the CRT terminal HUD. Two additive features extend it:
an **animated boot intro** (CRT power-on splash on load) and a **phosphor theme
switcher** (recolor the accent between Teal / Amber / Green / Violet CRT schemes).
Frontend-only; no backend changes.

**Decisions (approved):**
- Theme switcher swaps the **primary phosphor** only; secondary semantic hues
  (success-green, warning-amber, danger-red, throughput-violet, TG-blue) stay
  fixed for readability. Persisted to `localStorage`; applied before first paint.
- Boot intro plays **every page load**, skippable by click/keypress.
- Switcher lives in the top **Strip**; dashboard only. Mini App mirrors the token
  refactor (default teal) for sync but ships no switcher and no boot intro.

## Feature A — Phosphor theme switcher

### Token refactor (both `index.css`, kept in sync)

Introduce `--accent-rgb` (space-separated RGB triplet) and derive every
phosphor-tinted value from it so a theme override is tiny:

- `:root` defaults: `--accent-rgb: 127 233 216;` and `--primary: #7fe9d8;`.
- Derived in `:root`:
  - `--brand`, `--brand-soft`, `--ring`, `--surface-vs` → `var(--primary)`.
  - `--border: rgb(var(--accent-rgb) / .16)`, `--border-bright: …/ .4`,
    `--input: …/ .2`, `--secondary: …/ .08`, `--muted: …/ .05`,
    `--accent: …/ .08`, `--surface-vs-bg: …/ .08`.
  - `--brand-glow: rgb(var(--accent-rgb) / .25)`.
- Primitives rewritten to the var: `.glow` text-shadow, `.panel::before/after`
  bracket border, `.sweep` gradient, `::-webkit-scrollbar-thumb`(+hover),
  `scrollbar-color`, `::selection`. (`.crt` scanlines are black — unchanged.)
- Fixed across themes (NOT derived): `--background`, `--panel`, `--card`
  (dark surfaces), `--success #8fd9a8`, `--warning #e3c279`, `--danger #e0897a`,
  `--violet #b9a6ff`, `--blue #6fb5ff`, and their `-bg` variants.

Theme blocks (override only these four):
```
[data-theme="amber"]  { --accent-rgb: 232 184 115; --primary: #e8b873; --foreground: #ddc7a0; --foreground-bright: #ffeccb; }
[data-theme="green"]  { --accent-rgb: 110 231 135; --primary: #6ee787; --foreground: #b6e6c1; --foreground-bright: #d6ffdf; }
[data-theme="violet"] { --accent-rgb: 185 166 255; --primary: #b9a6ff; --foreground: #d4caf7; --foreground-bright: #efe9ff; }
```
Default (teal) is plain `:root` (`--foreground: #bfe6de; --foreground-bright: #dff8f2`).

### Literal-teal sweep (components)

Replace literal teal in the HUD + feature components so they follow the theme:
- `rgba(127,233,216,X)` → `rgb(var(--accent-rgb) / X)` (style objects + Tailwind
  arbitrary classes).
- `#7fe9d8` → `var(--primary)` in style objects and `text-[…]/bg-[…]/border-[…]`
  arbitrary classes.
- **SVG strokes** (`stroke="#7fe9d8"` on sparklines/waveform + baseline lines):
  presentation attributes do NOT resolve `var()`, so convert these to a
  `[stroke:var(--primary)]` (or `stroke-[…]`) **class** instead — done manually,
  not via blind find/replace. The violet throughput sparkline stroke stays
  `#b9a6ff` (fixed secondary hue).

### `lib/theme.ts`

```
type Phosphor = "teal" | "amber" | "green" | "violet";
const THEMES: Phosphor[]
applyTheme(t: Phosphor): void          // sets document.documentElement.dataset.theme (teal => remove attr) + localStorage["hud-theme"]
getTheme(): Phosphor                    // from localStorage, default "teal"
useTheme(): [Phosphor, (t)=>void]       // React state synced to applyTheme
```
`main.tsx` calls `applyTheme(getTheme())` before `createRoot` (no FOUC).

### Switcher UI (`components/hud/ThemeSwitcher.tsx`)

A compact row of four swatches in the `Strip` (right of BRIDGE ONLINE, before
MAIN SHELL): each a small square filled with that scheme's primary; the active
one gets a bright outline. Clicking sets the theme via `useTheme`. Reads current
theme from the hook.

## Feature B — Boot intro (`components/hud/BootIntro.tsx`)

A fixed full-screen overlay (`z-[100]`, above CRT z-80 and palette z-90) with a
scanline texture and black bg, centered column:
- power-on **flicker** → glowing `MYSTICAL//ASSISTANT` wordmark + `REMOTE DEV
  BRIDGE` subtitle → a `drawline` underline → 3–4 boot lines revealing with
  staggered `mfadeup` (`▸ INIT BRIDGE LINK ……… OK`, `▸ MOUNT WORKSPACE … OK`,
  `▸ SYNC SESSIONS … OK`, `▸ READY`) → blinking caret → fade out.
- `BootIntro({ onDone })`: an internal timer calls `onDone` after ~2200ms; a
  fade-out class applies in the last ~350ms. A `window` keydown listener and an
  `onClick` on the overlay call `onDone` immediately (skip). A
  `PRESS ANY KEY TO SKIP` hint sits at the bottom. Cleans up timer + listener on
  unmount.
- `App` holds `const [booting, setBooting] = useState(true)` and renders
  `{booting && <BootIntro onDone={() => setBooting(false)} />}` at the root.
  Plays every load (no storage gate). Dashboard only.

Boot lines are decorative branding (a splash, not data) — no real-data claim.

## Error handling

`localStorage` access wrapped in try/catch (private-mode safe; default teal on
failure). The intro never blocks interaction beyond its ~2.2s and is always
skippable. No new failure modes.

## Testing

- `tsc -b && vite build` for both apps.
- Backend suites stay green (no backend touched).
- Manual: switch each phosphor scheme → accents recolor, status hues unchanged,
  choice persists across reload; boot intro plays on load and skips on
  click/keypress.
- Screenshot if the libasound headless dependency is restored.

## Rollout

One spec + plan (two small independent features). Shippable when both apps build
and the manual checks pass.
