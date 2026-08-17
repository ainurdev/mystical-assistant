---
name: mystical-assistant-design
description: Use this skill to generate well-branded interfaces and assets for Mystical Assistant — a remote-dev bridge that runs Claude Code on your machine, driven from a Telegram bot, a Telegram Mini App, and a localhost desktop dashboard. Its look is a phosphor CRT terminal HUD (teal-on-black, monospace, scanlines, corner-bracketed panels, an occult-oracle voice). Use for production work or throwaway prototypes/mocks/decks. Contains design guidelines, color/type/spacing tokens, fonts, the brand emblem, reusable React components, and full UI-kit recreations of both surfaces.
user-invocable: true
---

Read the `readme.md` file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets
out and create static HTML files for the user to view. If working on production code,
you can copy assets and read the rules here to become an expert in designing with this
brand.

If the user invokes this skill without any other guidance, ask them what they want to
build or design, ask some questions, and act as an expert designer who outputs HTML
artifacts _or_ production code, depending on the need.

## What's here

- `styles.css` — the one stylesheet to link. `@import`s every token + font file in `tokens/`.
- `tokens/` — `colors.css` (the phosphor palette + moods), `typography.css`, `spacing.css`,
  `effects.css` (radius/glow/CRT primitives + the full keyframe library), `fonts.css`
  (Share Tech Mono + JetBrains Mono via Google Fonts), `base.css`.
- `assets/` — the brand emblem SVGs (`emblem.svg`, `emblem-boot.svg`).
- `components/` — reusable React primitives in four groups: `core/` (Button, Chip, Card,
  Banner, StatusDot, Spinner), `hud/` (Panel, Meter, Stat, Sparkline, SurfaceBadge,
  Emblem), `terminal/` (ToolTag, ResultBlock, PromptLine), `forms/` (Field, Dropdown).
  Each has a `.d.ts` (props) and `.prompt.md` (what/when + usage).
- `ui_kits/dashboard/` — the desktop HUD recreation (`index.html` + `app.jsx`).
- `ui_kits/miniapp/` — the Telegram Mini App recreation (`index.html` + `app.jsx`).
- `templates/` — copyable starting points (`dashboard-hud/`, `mini-app/`) that consuming projects can seed a new design from.
- `guidelines/` — foundation specimen cards (Colors / Type / Spacing / Brand).

## Using the components

In an HTML file, link `styles.css`, load the compiled bundle `_ds_bundle.js`, then read
components off the window namespace (run the design-system check to get the exact name —
it looks like `MysticalAssistantDesignSystem_<hash>`):

```html
<link rel="stylesheet" href="styles.css" />
<script src="_ds_bundle.js"></script>
<script type="text/babel">
  const { Panel, Button, Chip, Sparkline, PromptLine } = window.MysticalAssistantDesignSystem_24409d;
</script>
```

For static artifacts (no build), you can also just use the tokens + utility classes
(`.panel`, `.glow`, `.crt`, `.drawline`) directly with the CSS custom properties.

## The brand in one line

Teal phosphor (#7fe9d8) on a near-black void (#060a0a); everything monospace (Share Tech
Mono for labels, JetBrains Mono for terminal/code); zero radius; corner-bracketed panels;
scanlines + glow; UPPERCASE tracked instrument labels paired with a lowercase, italic
**oracle voice** ("name the bug; i will unmake it."). See `readme.md` for the full
content + visual + iconography guidance.
