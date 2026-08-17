# Mystical Assistant — Design System

> The brand voice and visual system of **Mystical Assistant**: a remote-dev bridge
> that runs **Claude Code on your own machine**, driven from anywhere — a Telegram
> bot, a Telegram Mini App, and a localhost desktop dashboard, all sharing one
> conversation store. The interface is a **phosphor CRT terminal HUD** with an
> occult-oracle streak: teal-on-black, monospace, scanlines, corner-bracketed
> panels, boot sequences, and a diamond-and-ring emblem that "channels" your intent
> into diffs.

This project is the *design system* — tokens, components, UI-kit recreations, and
guidance — extracted from the product so design agents can build on-brand
interfaces and assets. It is not the product itself.

---

## Sources

Everything here was reverse-engineered from the product codebase:

- **Codebase:** `mystical-assistant/` (attached, read-only) — a Python bridge plus
  two React + Vite + Tailwind v4 web clients:
  - `bridge/dashboard/web/` — the **Desktop Dashboard** (localhost HUD, the richest surface)
  - `bridge/miniapp/web/` — the **Telegram Mini App** (mobile control panel)
  - `bridge/dashboard/web/src/index.css` & `bridge/miniapp/web/src/index.css` — the shared token source (kept in sync between the two)
  - `docs/superpowers/specs/2026-06-23-hud-redesign-design.md` — the canonical HUD redesign spec (palette table, layout, motion, motifs)
- **Design origin (referenced, not attached):** a Claude Design project
  "Mystical Assistant Dashboard" → `Mystical Assistant HUD.dc.html`, per the spec.

The two clients import the same primitives (`components/ui/index.tsx` is shared
verbatim) and the same `:root` tokens, so this system describes **one product with
two surfaces**, not two products.

---

## The product, in one breath

You start a Claude Code session on any surface and continue it from any other. The
bridge runs `claude` locally and reuses its login. Your phone or browser is a
remote control; the work happens on your machine, in your repos. The dashboard is
a full-bleed instrument panel — projects, sessions, a terminal-style chat, live
host telemetry, git/issues/diff/logs, a ⌘K palette, a boot intro. The Mini App is
the same identity folded into a phone: tabs, a folder picker, a chat composer.

---

## CONTENT FUNDAMENTALS — how the product talks

The product speaks in **two registers**, and the contrast between them *is* the
brand:

### 1. HUD instrument labels — terse, UPPERCASE, tracked
Chrome labels are clipped technical readouts, almost always uppercase with wide
letter-spacing, often split by ` // ` or `·`. No articles, no punctuation-as-prose.

- `PANEL` · `WORKSPACE` · `AGENT TELEMETRY` · `CONTEXT MATRIX`
- `MOUNT` · `USED` · `REPO` · `CHANGES` · `⌘K COMMAND`
- `RESULT // OK` · `CHANGES // N FILES` · `TUNING SIGNAL…`
- `BRIDGE ONLINE` · `MAIN SHELL` · `SURFACES · TG / MA / VSCODE`
- Status words: `OK`, `SYNCED`, `BUSY`, `LIVE`, `AWAITING`, `WORKING`
- Boot log lines read like a system check: `› ESTABLISHING BRIDGE … OK`,
  `› CONVERSATION STORE … SYNCED`, `INITIALIZING WORKSPACE_`

### 2. The Oracle voice — lowercase, italic, incantatory
Empty states and idle prompts drop into a mystic second-person whisper. **All
lowercase, italic, present-tense, imperative or invitational.** This is where
"Mystical" earns its name. The assistant is an oracle you *channel*; errors are
*doors*; a clean diff is *a spell*.

- "the bridge is open — speak your change."
- "channeling… describe a change, paste an error."
- "every error is a door. show me yours."
- "name the bug; i will unmake it."
- "between commits, all things are possible."
- "paste the stack trace — i read entrails."
- "the runes are listening." · "what shall we conjure today?"
- "idle, but never asleep — what shall we ship?"
- "ready to conjure — name your bug."

Tone rules:
- **Person:** second person to the user ("speak your change", "show me yours");
  first person for the oracle ("i will unmake it", "i read entrails") — lowercase *i*.
- **Casing:** UPPERCASE for instrument chrome; lowercase for the oracle; Title Case
  only for proper product nouns (Claude Code, Telegram, VS Code, Opus/Sonnet/Haiku).
- **Punctuation:** em-dashes and ellipses carry the oracle's cadence; ` // `, `·`,
  `›`, `~ ❯`, `⎇` carry the HUD's.
- **Length:** instrument labels are 1–3 words; oracle lines are one short sentence.
- **No emoji in the HUD chrome.** (The Mini App, being a Telegram surface, permits
  a sparing ❓ / ● status glyph and lucide icons — see ICONOGRAPHY.)
- **Real numbers only.** Telemetry never fabricates a metric; if there's no signal
  (latency), the readout is omitted rather than faked.

### Naming
- Product: **Mystical Assistant**; wordmark stylized `MYSTICAL//ASSISTANT`.
- Tagline / sub-mark: `REMOTE DEV BRIDGE · CLAUDE CODE`.
- Surfaces are abbreviated to two-letter codes: **VS** (VS Code), **WEB** (Desktop),
  **TG** (Telegram bot), **MA** (Mini App), **CLI** (terminal).
- Phosphor moods have evocative names: **AURORA** (aqua/default), **VIRIDIAN**
  (green), **EMBER** (amber), **NOVA** (magenta).
- The prompt glyph is `~ ❯` (violet). Runes used as living glyphs: `✦ ◈ ⟁ ☿ ⌖ ✧ ◇ ⬡ ❖`.

---

## VISUAL FOUNDATIONS

### Mood
A sci-fi **CRT terminal / cockpit HUD** lit by a single teal phosphor on a
near-black void, crossed with **occult HUD** flourishes (a spinning rune ring, a
floating oracle face, twinkling sigils). Think: a salvaged tube monitor that also
happens to read tarot. Dense, instrumented, alive with small motion — but never
cluttered; every readout is real.

### Color
- **Background is a void:** `#060a0a`. Panels and cards are barely-there translucent
  dark teal — `--panel rgba(9,16,16,.5)`, `--card rgba(7,13,13,.6)` — so the bg
  reads through. Popovers go near-opaque (`rgba(7,13,13,.97)`).
- **One hero accent:** teal phosphor `#7fe9d8` (`--primary`). Almost all structure,
  focus, and emphasis is this teal at varying alpha (`.03 → .6`). Build any tint
  with `rgb(var(--accent-rgb) / <a>)`.
- **Text ramp:** bright `#dff8f2` (glow headings) → `#bfe6de` (body) → `#6f938d`
  (dim labels) → `#3c544f` (dimmest/ghost). Four steps, all cool.
- **A tiny named cast:** violet `#b9a6ff` (the model, the `~ ❯` prompt, the Mini App,
  "enhancement"), blue `#6fb5ff` (Telegram). Used sparingly as the *only* non-teal
  hues besides semantics.
- **Semantics:** success/online `#8fd9a8`, warning/dirty `#e3c279`, danger/error
  `#e0897a`. Muted, desaturated — they sit *inside* the phosphor world, never pop
  like web alerts.
- **Surface chips** code each origin by color: VS=teal, WEB=green, TG=blue,
  MA=violet, CLI=grey. **Projects** are hashed to a fixed 6-color palette so a repo
  looks identical everywhere.
- **Moods:** alternate phosphors (green/amber/magenta) are produced by overriding
  the accent (`[data-phosphor]`) — on the dashboard, paired with a global
  hue-rotate + saturate filter so *every* accent shifts together.

### Type
- **Everything is monospace.** Two families:
  - **Share Tech Mono** — the UI/label/wordmark voice. Wide, even, a little retro.
    This is the default `body` font.
  - **JetBrains Mono** (400/500/700) — the terminal, code, inputs, and chat body.
- **The HUD runs small.** Chrome labels are **8–11px** with **1–3px letter-spacing**,
  uppercase. Only readouts go large: clock **46px**, wordmark **34px** (tracking
  **10px**), values **23px**. Body/terminal text is **13px**.
- Tracking is the signature: nearly every uppercase label is letter-spaced. The
  wordmark is spaced to **10px**; sub-marks to **6px**.

### Space & layout
- **13px is the magic gutter** — the dashboard grid gap *and* its outer padding.
  Panels pad ~14px; chips pack to 2–7px; inline chrome is pixel-tight.
- **Dashboard:** a fixed 3-column instrument grid `344px / 1fr / 368px`, framed by a
  top **Strip** and a bottom **StatusBar**. Left = workspace/telemetry, center =
  terminal, right = projects/sessions.
- **Mini App:** a single centered phone column (`max-w-screen-sm`), sticky header +
  tab bar on top, fixed composer at the bottom.
- **Fixed chrome:** the CRT/sweep overlays, Strip, StatusBar, and mobile composer
  are pinned; content scrolls inside thin teal scrollbars.

### Borders, corners, cards
- **Radius is ZERO. Everywhere.** Hard edges are the whole point. (The only round
  things: status dots and the mobile send FAB.)
- **Borders are teal hairlines:** `1px solid rgb(127 233 216 / .16)` default, `.4`
  when active/focused. Dashed teal (`.14 alpha`) separates sub-sections inside a panel.
- **Cards = the `.panel`:** a bordered translucent box with **two L-shaped corner
  brackets** (top-left + bottom-right), a header row (`PANEL` ··· `TITLE`), and a
  **drawline** divider (a 1px teal→transparent gradient that wipes in via scaleX).
  There is no drop-shadow card; depth comes from borders + glow, not blur.

### Light, glow & texture
- **Glow, not shadow.** Emphasis text carries a teal `text-shadow` (`.glow`).
  Active elements get a faint box-glow; the oracle orb and send button have soft
  accent halos. Drop-shadows appear only on rising popovers (`0 -8px 26px #000a`).
- **Scanlines + sweep:** a fixed `.crt` repeating-gradient scanline overlay (opacity
  .5) sits over every screen, plus an optional slow vertical `.sweep` band. These
  are toggleable display settings.
- **No photography, no illustration fills, no big gradients-as-background.** The
  "imagery" is procedural: SVG sparklines, an I/O waveform, a context-matrix cell
  grid, a perspective grid + radar rings + drifting sigils on the boot screen.
  Gradients appear only as thin meter fills (`#7fe9d8 → #b9a6ff`) and divider lines.

### Motion
- **Entrances are directional + bright.** Panels boot in (`boot`, `enterLeft/Right/
  Up/Zoom`) with a brief brightness/CRT flash, staggered by ~60–360ms.
- **The boot intro** is a full CRT power-on: perspective grid, aura spin, radar
  pings, emblem pop, wordmark flicker (`wordflick`), a typed boot log, then a
  `crtoff` collapse to a scanline.
- **Idle life:** carets blink (`caret`/`caretbreath`), runes twinkle, the oracle
  orb bobs and blinks its eyes, quotes type-in then dissolve (`quotein`/`quoteout`),
  the clock digits flip (`digitflip`).
- **Channel-change:** switching sessions "retunes" the terminal — collapse to a
  bright scanline, then bloom open with a glitch.
- **House easing:** `cubic-bezier(.2,.8,.2,1)`. Durations ~0.3–0.65s for entrances.
- All of it respects `prefers-reduced-motion`.

### States
- **Hover:** a faint accent wash (`rgb(127 233 216 / .08)`) and/or text brightening
  toward `#dff8f2`; borders step from `.16` → brighter. No movement.
- **Active/press:** `active:opacity-70` (the shared button), or a filled accent wash.
- **Focus:** a 2px accent ring (`--ring`).
- **Disabled:** `opacity .4`, `cursor: not-allowed`.
- **Selected/active tab:** bright teal border + `.08` wash + brightened text; the
  inactive sits at `.16` border, dim text.

### Transparency & blur
- Used constantly but *gently*: panels/cards are translucent over the void;
  popovers are near-opaque; the boot aura uses a 3px blur. No heavy glassmorphism —
  this is layered phosphor, not frosted glass.

---

## ICONOGRAPHY

The product uses **two icon registers**, split by surface:

1. **Unicode glyphs as HUD icons (the Desktop Dashboard).** The dense instrument
   chrome is drawn almost entirely with typographic symbols — no icon font, no SVG
   sprite. This keeps the cockpit feeling like *text on a tube*:
   - Prompt & git: `~ ❯` (prompt, violet), `⎇` (branch), `↑ ↓ ●` (ahead/behind/dirty),
     `›` (boot bullet), `//` and `·` (separators).
   - Runes / sigils (living glyphs, oracle flavor): `✦ ◈ ⟁ ☿ ⌖ ✧ ◇ ⬡ ❖ ✧ +`.
   - Command/menu marks: `⊕ ⌘K ▸ ⧉ ⌫ ⊞ ◉ ◎ ▾ ✓ ■ ▣ ◷ ◐ ♪ ⚙ ↻ ⊙ ↥ °`.
   - Action affordances: `SEND ▸`, `STOP ■`.
   Use these literally in HUD chrome; they inherit the phosphor color and glow.

2. **Lucide icons (the Telegram Mini App + a few dashboard spots).** The mobile
   surface uses **[lucide-react](https://lucide.dev)** at ~13–18px, `currentColor`,
   default ~2px stroke — matching the thin monospace weight. Seen in the source:
   `Sparkles` (brand/model), `MessagesSquare`, `CircleDot`, `History`,
   `TerminalSquare`, `SquareChevronRight`, `MonitorPlay`, `MousePointerClick`,
   `SquarePen`, `ChevronUp/Down`, `Paperclip`, `ArrowUp`, `Square` (stop),
   `Minimize2`, `Wrench`, `Check`, `X`, `TriangleAlert`, `CircleStop`, `Sparkles`.
   **Load lucide from CDN** when building Mini-App-style screens; substitute the
   nearest lucide glyph if an exact one is missing and note it.

3. **The brand emblem** is a small SVG: a slowly-spinning **dashed ring**, a
   **diamond** (rotated square outline), and a **violet core** (a smaller rotated
   square). Strokes follow the active phosphor accent; the core stays violet. It
   appears at 22px in chrome and 150px on the boot/fresh screens with extra rings +
   tick marks. See `assets/` for standalone SVGs lifted verbatim from the source.

4. **Emoji:** effectively **not used** in the HUD. The Mini App may show a bare
   `❓`/`●` session-status glyph (Telegram convention). Do not introduce decorative
   emoji.

> Substitution note: lucide-react in the source is loaded via npm; this system
> references **lucide from CDN**. The two webfonts (Share Tech Mono, JetBrains Mono)
> are loaded from **Google Fonts** here rather than self-hosted. Both are the *same*
> assets, delivered over CDN — flag if you need offline binaries.

---

## INDEX  *(see also: the Design System tab for live specimen + component cards)*

**Foundations**
- `styles.css` — global entry point (link this). `@import`s everything in `tokens/`.
- `tokens/fonts.css` — Share Tech Mono + JetBrains Mono (Google Fonts `@import`).
- `tokens/colors.css` — the phosphor palette, semantic + surface tokens, phosphor moods.
- `tokens/typography.css` — the two voices, size ramp, tracking.
- `tokens/spacing.css` — the 13px-gutter scale + layout metrics.
- `tokens/effects.css` — radius (0), glow/shadows, the `.panel`/`.crt`/`.glow` primitives + the keyframe library.
- `tokens/base.css` — document reset.
- `assets/` — `emblem.svg` (the mark), `emblem-boot.svg` (rings + ticks variant).

**Components** (React; `Name.jsx` + `Name.d.ts` + `Name.prompt.md`; one card HTML per group)
- `components/core/` — **Button**, **Chip**, **Card**, **Banner**, **StatusDot**, **Spinner**
- `components/hud/` — **Panel**, **Meter**, **Stat**, **Sparkline**, **SurfaceBadge**, **Emblem**
- `components/terminal/` — **ToolTag**, **ResultBlock**, **PromptLine**
- `components/forms/` — **Field**, **Dropdown**

**UI kits** (high-fidelity, interactive recreations — `index.html` + `app.jsx`)
- `ui_kits/dashboard/` — the **Desktop Dashboard** (HUD): boot intro → strip · workspace/telemetry · terminal · projects · status bar. Send a message to see the stream.
- `ui_kits/miniapp/` — the **Telegram Mini App**: phone webview with header + tab bar, terminal-style chat, and the fixed composer (lucide icons via CDN).

**Templates** (copyable starting points — surface in the Templates picker for consuming projects)
- `templates/dashboard-hud/` — the Desktop Dashboard, ready to copy + rewire to real data.
- `templates/mini-app/` — the Telegram Mini App, ready to copy + rewire.

**Guidelines** (foundation specimen cards, surfaced in the Design System tab)
- `guidelines/colors-*.html` · `type-*.html` · `spacing-*.html` · `brand-*.html`

**Skill**
- `SKILL.md` — Agent-Skills-compatible entry point (download + use in Claude Code).

---

*Caveats: the two webfonts and lucide (Mini-App icons) load from CDN rather than
bundled binaries — flag if you need offline assets. The alternate phosphor moods
(VIRIDIAN/EMBER/NOVA) are documented via `[data-phosphor]`; the source dashboard
additionally applies a per-surface hue-rotate filter to shift every accent at once.*
