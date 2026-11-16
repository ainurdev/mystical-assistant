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
A question or permission a session waits on before its turn can go on. It waits docked on the message box, or as a card in the stream where it can't dock (device runs, TEAM sessions).
_Avoid_: request, prompt

**Flow**:
A kind of work and the fixed order of **Steps** a **Session** follows for it. The six in the prompt box's row (DESIGN, BUILD, REFACTOR, FIX, SHIP, ASK) are tapped by you, guessed by the box, or picked by Claude for a prompt sent with none. A session follows one flow at a time and can run several over its life, one after another; the one it is on until its last step is done is its active flow. Tapping another flow stops the active one where it was.
_Avoid_: path, kind, pipeline, workflow, plan

**Step**:
One part of a **Flow** (grill, design, build, review, retro…): done, running, waiting on you, or starting by itself. Some steps can be skipped; some run in sessions of their own.
_Avoid_: station, phase, stage

**Council**:
The reviewers that read the work a **Session** would push, score it and list what to fix; the session fixes it, round by round, until the score passes or the council stops and it **Needs you**. After a **Flow** merges its tickets, its review **Step** is a council on the merged work.
_Avoid_: panel, jury, review loop

**Ticket**:
One part of a feature that a **Flow** split off to be built beside the others, in a **Session** and worktree of its own.
_Avoid_: task, sub-task, issue

**Ticket set**:
All the **Tickets** one **Flow** split a feature into. Every ticket whose blockers are done builds at once, and one session merges them all at the end. A new set waits for your approval before any ticket starts, unless its flow has **Auto-start** on.
_Avoid_: ticket map, batch, plan

**Super session**:
The **Session** whose **Flow** made a **Ticket set**. Its row in the sidebar stands for the whole set; its tickets' sessions fold under it instead of having rows of their own.
_Avoid_: parent session, flow session

**Auto-start**:
A flow's setting that lets its new **Ticket sets** start building without waiting for your approval.
_Avoid_: approve before build, auto-approve

**Mystical MCP**:
The one tool server every Mystical session gets, whichever agent runs it, through which it sees and acts on Mystical itself: its goals, verification, UX knowledge, other sessions and the machine.
_Avoid_: gateway, goals server, verify server, mystical-ux, bridge MCPs

**Helper**:
An agent a session starts to take one task inside that session; it reports back as a message and shows under that session, not as its own row in the sidebar. A session that another session starts is a normal **Session**, not a helper.
_Avoid_: subagent, child session, worker

**To-do**:
Something only you can do, that no session can do for you: turn a setting on, add a file, give someone what their message asked for. A reply lists its to-dos in one box at its very top, and a reply with none has no box; a choice the session needs from you is an **Ask**, not a to-do.
_Avoid_: action item, task, highlight, important part

**Carry-on**:
A message Mystical sends a session on its own, marked as Mystical's, after the session switched a tool server on, so the session goes on with the new tools; waiting for you to nudge it is never a **To-do**.
_Avoid_: nudge, "go", auto-resume

**Needs you**:
Everything waiting on you right now, across sessions: an open Ask, a Rivendell job still on offer, a session asking you to log in, a **Ticket set** waiting for your approval. It is worked out fresh each time, and a reply's to-dos are not part of it.
_Avoid_: notifications, alerts

**WAITING ON YOU panel**:
The Mac and Windows apps' small always-on-top list of everything that **Needs you**, shown over other apps while the dashboard isn't in front.
_Avoid_: overlay, floating panel

**Live board**:
The one pinned message in the Telegram chat that shows every session running right now and everything that **Needs you**, and keeps itself up to date. It appears by itself when a turn starts and none is there; `/status` brings a fresh one down to where you're reading.
_Avoid_: status card, status message, widget (Telegram's word for what it's built on)

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
