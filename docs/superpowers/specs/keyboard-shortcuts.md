# Keyboard shortcuts that get used

The dashboard had about ten shortcuts and they went unused for two reasons:
none was shown anywhere (no tooltip, no ⌘K label, no list), and ⌥↑/⌥↓, ⌥1–9
and `/` switched themselves off inside text fields while the message box,
which takes the cursor on every session open, almost always had it.

Agreed with the user on 2026-11-08 (every recommendation taken). Terms are in
`GLOSSARY.md` under Shortcuts.

## Showing them

- A control that has a shortcut shows it in its tooltip, as keycaps: one small
  box per key, the ⌘K palette's ESC badge box (design pick A · KEYCAPS).
- Each ⌘K row that has a shortcut shows it, before its group label.
- ⌘/ opens the **shortcut sheet**: the ⌘K box with a filter on top, every
  shortcut grouped by where it works (Anywhere, Chat, Message box, Ask cards,
  Editor window). ⌃Tab and ⌘N say "app only" outside Mystical.app / .exe.
  Also a ⌘K row (pick A · LIST).
- The **shortcut nudge**: a mouse click on a control that has a shortcut shows
  "next time" and its keycaps in the tooltip's box beside it for 2.5 s, at most
  3 times per key (two buttons with the same key share the count), never again
  once that key was pressed. None on a touch screen. No off switch. Counted per
  window (localStorage) (pick A · AT THE CONTROL).
- Ask cards show ⌘1… keycaps on the current question's options (the others keep
  the room, hidden, so nothing reflows), and ⌘↵ on Send; the dock's rows, its
  Allow / Deny and a prose ask's replies carry theirs too; touch screens show
  none (pick A · KEYCAPS ON OPTIONS).

## New and changed shortcuts

| Keys | Does | Notes |
| --- | --- | --- |
| ⌥↑ ⌥↓, ⌥1–9 | as before | now also from the empty message box; while the router suggests a command there, ⌥↓ stays its "other commands that fit" |
| ⌃Tab | back to the last session; again to return | from a fresh screen, the session you just left; browser tabs keep ⌃Tab |
| ⌘J | next session in NEEDS YOU, the bell's order (newest first), skipping the one you're in, round to the newest | says so when nothing else waits; a Rivendell offer has no session and is passed by |
| ⌘B / ⌥⌘B | fold the sidebar / the right panel | ⌘B matches the editor window's Ctrl+B |
| ⌘. | stop the turn | always taken (a Mac turns a loose ⌘. into Cancel) |
| ⌘1–9, ⌘↵ | the live Ask on top: pick option N on the question the keys are on; a pick-one question moves on by itself, a pick-several one with ⌘↵; ⌘↵ sends once every question has an answer (in the dock, ⌘↵ is the box's own button: Next, or Send on the last) | ⌘↵ goes to the Ask only while the message box is empty; permissions: ⌘1 Allow, ⌘2 Deny; a prose ask: ⌘N replies with option N |
| ⌘N | new session in this project | browser tabs keep ⌘N |
| a letter or digit | typed with no field to take it, lands in the message box | not while a dialog, ⌘K or the sheet is open; `/` still searches the sessions |
| ⌃⌘A | Mac app: summon shortcut, the twin of Windows' Win+Ctrl+A | a switch in SETTINGS ▸ MAC APP, on by default like Windows |

One fixed set; no page to change them. On Windows and Linux every ⌘ is Ctrl.
App takes these keys in the capture phase, before the message box's editor
(where ⌘/ would comment a line and ⌘↵ would send an empty box). Inside the
project window (the editor) none of the new keys fire: its own VS Code keys
win. While a dialog is up (`role="dialog"` / `aria-modal`, ⌘K, the sheet,
Settings) only ⌘. does, and ⌘/ from ⌘K or the sheet itself. The Linux window gets no summon shortcut. The
bot and the Mini App are unchanged.

## Where it lives

- `bridge/dashboard/web/src/lib/shortcuts.ts`: the table the sheet lists,
  keycap labels, ⌘J's order, the Ask-card key flow, the nudge count; checked
  by `shortcuts.check.ts`. `chord.ts` now reads digits off `code` too.
- `components/ui/Keys.tsx` draws keycaps; `ui/Tip.tsx` (NativeTips) adds them
  to tooltips from a control's `data-key` and runs the nudge.
- `App.tsx` handles the new keys and hands ⌘1–9 / ⌘↵ to the live Ask as
  `hud:ask-key` (`useAskKeys` in `ui/Keys.tsx`: AskDock's question, permission
  and prose docks, QuestionCard, PermissionCard; the topmost one answers).
- `macos/Sources/Mystical/SummonShortcut.swift` holds ⌃⌘A (Carbon, no
  Accessibility permission); `MacPrefs.hotkey` is the switch.
