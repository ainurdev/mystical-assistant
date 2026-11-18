"""Carry-on: the turn Mystical sends by itself after a session switched an MCP on,
or lost a background command to the end of its turn.

A server switched on mid-turn only loads on the next turn (its schemas go into
the system prompt before the first token), so a session that needed one used to
stop and ask you to "send any message". Instead the mcp-on skill's toggle.py
marks the session here, and the end of that turn queues one tagged prompt.

Why a settings key and not a column: toggle.py runs in the session's shell, a
separate process, and the settings table is the one place both already share;
the key is spelled out in toggle.py too, which can't import this module from
an older checkout.

Why so many ways to send nothing: a stopped, failed or limit-hit turn means
stop (the limit ladder resumes on its own); a goal or flow step that re-prompts
loads the tools anyway, as does your own message already queued. The mark is
cleared at every turn end either way, so it never fires a turn later.
Switching a server on from the Tools modal never marks: your own toggle never
starts a turn.

The lost command: a session that starts a test run in the background, says "I'll
report once it finishes" and ends its turn never reports. Claude Code's Bash tool
promises to re-invoke it, but runner._watchdog ends a finished turn's background
commands (they once held a turn RUNNING for hours), so nothing wakes the session.
From 2026-10-18 to 11-10 that happened in 80 turns of 70 sessions, and in 40 the
last words promised a report. The watchdog notes what it took down in
job.bg_ended, and the turn's end sends one carry-on naming it. Once: the
carry-on's own turn that loses a command again is left alone. Only in a session
you talk to (_YOURS): bridge/tickets.py carries a ticket or merge session on
itself and counts, and a Rivendell job, an automation or a helper has handed its
result on by the time its turn ends.

Since 2026-11-17 this is the net, not the rule: the watchdog keeps a finished
turn waiting on a background command the CLI reports (runner.BG_WAIT_CAP) and
the CLI wakes the session itself. job.bg_ended holds only a command that wait
never held the turn for, which still goes down at BG_SHELL_GRACE. A wait that
runs out is the command card's to tell (runner._bg_expired_prompt).
"""

import json
import sys

from bridge import store

_TEXT = ("[mystical] MCP loaded: {names}. Carry on with what you were doing; "
         "those tools are available now.")
# "No path for this message.": an order from the bridge, not a bug for the paths pack to route.
_LOST = ("No path for this message.\n\n[mystical] Your turn ended while a background command was "
         "still running, and the bridge ended it with the turn: {names}. If you still owe its result, "
         "run it again, wait for it in the foreground, then report. If you owe nothing, say so in "
         "one line.")


def _key(sid: str) -> str:
    return f"carry_on:{sid}"   # also written by ~/.claude/skills/mcp-on/toggle.py


def mark(sid: str, names: list[str]) -> None:
    """Remember servers this session switched on during its running turn."""
    have = set(json.loads(store.get_setting(_key(sid)) or "[]"))
    store.set_setting(_key(sid), json.dumps(sorted(have | set(names))))


_YOURS = ("dashboard", "miniapp", "bot", "bridge")   # "bridge": a terminal session you took over


def _lost(job, sess: dict) -> list[str]:
    """The background commands this turn lost, when the session is to be told."""
    if not job.bg_ended or sess.get("origin") not in _YOURS:
        return []
    last = store.turn_prompt(store.latest_turn_id(job.store_session_id) or "") or ""
    return [] if last.startswith(_LOST.split("{")[0]) else job.bg_ended


def after_turn(job, resumed: bool) -> bool:
    """Called once per finished turn, after goals and flows had their say
    (`resumed`). Queues the carry-on and returns True if it did. Best-effort:
    never raises into the turn lifecycle."""
    try:
        sid = job.store_session_id
        raw = store.get_setting(_key(sid)) if sid else None
        if raw is None and not (sid and job.bg_ended):
            return False
        sess = store.get_session(sid) or {}
        lost = _lost(job, sess)
        if raw is None and not lost:
            return False
        if raw is not None:
            store.set_setting(_key(sid), None)
        if resumed or job.status != "done" or job.interrupted:
            return False
        from bridge import queue_manager
        items = queue_manager.snapshot(sid).get("items") or []
        if any(i.get("status") in ("queued", "running") for i in items):
            return False
        mcps = ", ".join(json.loads(raw)) if raw is not None else ""
        text = "\n\n".join(filter(None, (
            lost and _LOST.format(names="; ".join(lost)),
            raw is not None and _TEXT.format(names=mcps))))
        queue_manager.enqueue(
            sid, text=text, prompt=text, images=[], model=None, effort=None,
            permission_mode=None, width=None, sel=[], surface="carry-on",
            chat_id=job.chat_id if job.chat_id is not None else sess.get("chat_id"),
            project=sess.get("project") or "",
            sent_by="mystical:mcp" if raw is not None else "mystical:nudge",
            sent_why="; ".join(filter(None, (
                raw is not None and f"you turned {mcps} on while Claude was working",
                lost and "the turn ended with a background command still running"))))
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[carry_on] failed: {e}", file=sys.stderr)
        return False
