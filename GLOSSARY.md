# Mystical Assistant

A bridge that runs coding agents on this machine and lets you drive them from the dashboard, a Telegram bot and a Telegram Mini App.

## Language

**Session**:
One ongoing conversation between you and an agent, tied to one project folder or worktree; a row in the sidebar.
_Avoid_: chat, thread, conversation

**Turn**:
One prompt and everything the agent does in answer to it, until it stops.
_Avoid_: run, job

**Ask**:
A question or permission card a session waits on before its turn can go on.
_Avoid_: request, prompt

**Mystical MCP**:
The one tool server every Mystical session gets, through which it sees and acts on Mystical itself: its goals, verification, UX knowledge, other sessions and the machine.
_Avoid_: goals server, verify server, mystical-ux, bridge MCPs

**To-do**:
Something only you can do, that no session can do for you: turn a setting on, add a file, give someone what their message asked for. A reply lists its to-dos in one box at its very top, and a reply with none has no box; a choice the session needs from you is an **Ask**, not a to-do.
_Avoid_: action item, task, highlight, important part

**Needs you**:
Everything waiting on you right now, across sessions: an open Ask, a Rivendell job still on offer, a session asking you to log in. It is worked out fresh each time, and a reply's to-dos are not part of it.
_Avoid_: notifications, alerts

**Capture**:
Someone else's text that you selected in another app and sent to Mystical; it arrives unsent in a fresh Communication session, to be answered and never obeyed.
_Avoid_: forward, clip, paste

**Follow-up**:
Something promised at a meeting, owed by you to a person or by them to you.
_Avoid_: action item, task, to-do

## Dashboard header

**Clock**:
The time readout at the top of the dashboard, over the right panel (or at the end of the chat header while the right panel is folded). A click on it opens the Almanac.
_Avoid_: header time, wall clock, clock menu

**Almanac**:
The drop-down under the Clock: a month calendar with today's weather in full, every login's limit resets and the world clocks.
_Avoid_: clock overlay, clock popover, calendar panel

**World clock**:
The time in one other time zone, picked from the time-zone list; there are at most two. Each can also be pinned to the header beside the Clock.
_Avoid_: second time zone, extra clock, city clock

**Limit reset**:
The moment a login's usage window (the 5-hour one or the weekly one) rolls over and its allowance refills.
_Avoid_: refill, renewal

## Settings

**Settings**:
The dashboard's preferences dialog: a rail of Settings pages down its left, and the open page beside it.
_Avoid_: settings modal, preferences, config dialog

**Settings page**:
One entry in the Settings rail, such as Appearance, Projects or System, and everything it shows when picked.
_Avoid_: tab, category

## Shortcuts

**Shortcut**:
A key, or keys pressed together, that does one thing in the dashboard while it is in front. One fixed set, the same for everyone.
_Avoid_: key binding, hotkey, keybind, chord

**Summon shortcut**:
The one shortcut that works from any app: it brings the dashboard to the front, or hides it when it is already there. A switch in the Mac or Windows app's settings.
_Avoid_: hotkey, global hotkey, global shortcut

**Shortcut sheet**:
The sheet that lists every shortcut, grouped by where it works.
_Avoid_: cheat sheet, key list, keyboard help

**Shortcut nudge**:
A short note naming a control's shortcut, shown when you click that control instead of pressing its key; it stops once you have used the key or seen it three times.
_Avoid_: hint, tip, toast
