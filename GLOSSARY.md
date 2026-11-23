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
The **Reviewers** that read the work a **Session** would push, score it and list what to fix; the session fixes it, round by round, until the score passes or the council stops and it **Needs you**. After a **Flow** merges its **Parts**, its review **Step** is a council on the merged work.
_Avoid_: panel, jury, review loop

**Reviewer**:
One **Account** you switched on to sit on the **Council**: each round it reads the work fresh, on its own, scores it out of 10 and lists what it would fix.
_Avoid_: judge, seat, juror

**Account**:
One sign-in Mystical runs an agent under: a Claude login, another agent's login, or a pasted API key.
_Avoid_: slot, profile

**Auto-switch**:
The on-limit choice that moves a **Session** whose **Account** ran out onto another Account with room, without asking you. The other two choices are Ask (it offers you the move) and Wait (for the **Limit reset**).
_Avoid_: auto mode, auto, auto fallback

**Out of Auto-switch**:
An **Account** whose own Auto-switch switch is off: **Auto-switch** never moves a **Session** onto it without asking you, though you can still pick it yourself. Unlike a disabled Account, which nothing runs on.
_Avoid_: manual only, reserved, excluded

**Feature branch**:
The branch a **Flow** builds on, in a worktree of its own. It is named for what is being built, as `type/short-name`, by the agent that hands over to the build **Step**; when a task covers the work, the task's key leads the name. The session's title names it only when the agent gave no name.
_Avoid_: flow branch, session branch

**Task**:
Something you want done in a project, kept on its work list (the WORK panel) until it is done: what and when. Only you start one, and starting it opens its own **Session** on the **Flow** you pick (build, fix or design), whose progress it then shows.
_Avoid_: work item, ticket, todo

**Part**:
One piece of a **Task** that its **Flow** split off to be built beside the others, in a **Session** and worktree of its own. Every part whose blockers are done builds at once, and one session merges them all at the end. A task's parts wait for your approval before any starts, unless its flow has **Auto-start** on or there is only one. A part of yours (its file says ready-for-human) gets no session or worktree: it waits in **Needs you** until you tap Go.
_Avoid_: ticket, ticket set, sub-task, issue

**Super session**:
The **Session** whose **Flow** split the work into **Parts**: for a **Task**, the task's session. Its row in the sidebar stands for all the parts; their sessions fold under it instead of having rows of their own.
_Avoid_: parent session, flow session

**Auto-start**:
A flow's setting that lets its new **Parts** start building without waiting for your approval.
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
Everything waiting on you right now, across sessions: an open Ask, a Rivendell job still on offer, a session asking you to log in, a **Task**'s **Parts** waiting for your approval, a **Part** of yours waiting for Go. It is worked out fresh each time, and a reply's to-dos are not part of it.
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

## Watcher

**Watcher**:
The part of Mystical that studies how you work across every project's sessions over time, and suggests what in Mystical, or in a project's own setup, should change so the work goes better. It only suggests; it never changes anything itself.
_Avoid_: audit, study, insights, retro, dreaming, monitor

**Lens**:
One question the Watcher keeps asking of your sessions: how the dashboard's UI serves you, how what you asked for went, or which tools, routes and flows a session took.
_Avoid_: category, dimension, check

**Watch**:
One nightly pass of the Watcher over everything since the last one.
_Avoid_: run, scan, job, audit

**Finding**:
One thing a watch or a retro suggests changing, with its evidence and how often it has shown up over time; every finding sits in one list. You pick it for a work list or set it aside; once it is built, later watches check that it stays gone and reopen it if it comes back.
_Avoid_: insight, issue, suggestion, recommendation, RED

**Click log**:
The dashboard's own record of the controls you press and where, kept on this machine. Usage sharing is the other source: masked clicks and replays sent to PostHog.
_Avoid_: telemetry, analytics, tracking

## Reports

**Install**:
One bridge and every window that drives it: Mystical.app, a browser tab, a phone on the Mini App.
_Avoid_: installation, device, machine

**Team install**:
An install whose bridge has an enabled connection to the team's Rivendell. Only team installs send **Reports**.
_Avoid_: internal install, trusted install

**Report**:
One **Crash** or **Slow spot** that a team install sends to Sentry.
_Avoid_: issue, event, telemetry

**Crash**:
An error the bridge or the dashboard page did not handle, or a turn that ended CRASHED.
_Avoid_: issue, exception, failure

**Slow spot**:
A wait that ran past its limit: a start-up, a click or key, a frozen frame, a bridge call, or a turn's start.
_Avoid_: performance issue, lag, jank
