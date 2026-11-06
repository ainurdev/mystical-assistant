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
