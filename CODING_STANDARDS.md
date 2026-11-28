# Coding standards

Read at review time; the code-review skill picks this file up. These are judgement
calls: whatever a machine can check belongs in `npm run check` or pytest. The
conventions in CLAUDE.md apply as well.

## Dashboard (`bridge/dashboard/web`)

- **Capitals come from `.caps`.** Write labels in natural case. Add the `caps` class
  (index.css, "A label the HUD shouts"), or use `useVoice()` (SettingsModal.tsx)
  where a class can't reach. PEBBLE and middle-earth turn `.caps` off. A new
  `text-transform: uppercase` or an all-caps literal stays in capitals in those themes.
- **Colours are theme tokens** (`var(--info)`, `--ok`, `--warn`, `--purple`, …). A hex
  copied from one theme is wrong in every other theme. Art and terminal palettes are
  the exception.
- **Font sizes are type-scale tokens** (`var(--t7)` and its siblings, index.css "Type
  scale"), so the BASE FONT SIZE setting scales them.
- **Even heights.** Rows on one line share a height. Switching content (a view, a tab,
  a state) never resizes its box: stack the alternatives in one box and hide the ones
  not showing.
- **WebKit ignores CSS `filter` on SVG children**, and the Mac app runs on WebKit. Draw
  a glow as a second shape.
- **Header widgets have two homes**: the right panel's cap, and the end of the chat
  header when that panel is folded (Terminal's `chrome` prop). Check both, for width
  (flex, container queries) and for right-click. The menu comes from the nearest
  `[data-ctx-type]` (App.tsx). Inside the chat column that is Terminal's `"terminal"`,
  unless the widget sets its own.
- **Overlay keys stay in the overlay.** A drop-down or dialog that listens on `document`
  handles only unmodified keys outside inputs, and stops the propagation of every key
  it handles. App listens on `window` for ⌥↑/⌥↓ (jump between turns), ⌥1–9 and Esc
  (closes App's own overlays), so a key that leaks out does two things at once.
  The shortcuts in `lib/shortcuts.ts` (⌘J, ⌃Tab, ⌘N, ⌘B, ⌥⌘B, ⌘1–9/⌘↵ for an Ask)
  App takes in the capture phase, before any overlay sees them; they stand down
  while a `[role="dialog"]` or `[aria-modal="true"]` is on the page, so give an
  overlay one of those. A letter typed outside any field goes to the message box.

## Everywhere

- **Copy follows behaviour.** Text that tells the user what a skill or flow will do changes in
  the same branch as it: the composer buttons' `title` (Composer.tsx), the prompt kinds' facts
  line (`lib/kinds.ts` kindFacts), the AI features' `about` (`bridge/aifeatures.py`) and the
  routing text (`bridge/paths.py`). Search for the feature's name, case-insensitive, not for the
  skill's own wording.
- **A known limit gets a comment**: `shortcut: <the limit>, <when to upgrade>`. Older
  ones say `ponytail:`. `/ponytail-debt` lists them.
- **A guess keeps the session's permission mode.** A preset, default or guess that sends
  a `permission_mode` for the user sends `""` (the session's own) unless the user picked
  one. The cost of a stricter mode is invisible in the code: in a bridge session, plan
  raises a plan card and then an Allow/Deny card for every Bash call, even after the
  plan is approved, and acceptEdits asks for every Bash call.
