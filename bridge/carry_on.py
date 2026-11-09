"""Carry-on: the turn Mystical sends by itself after a session switched an MCP on.

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
"""

import json
import sys

from bridge import store

_TEXT = ("[mystical] MCP loaded: {names}. Carry on with what you were doing; "
         "those tools are available now.")


def _key(sid: str) -> str:
    return f"carry_on:{sid}"   # also written by ~/.claude/skills/mcp-on/toggle.py


def mark(sid: str, names: list[str]) -> None:
    """Remember servers this session switched on during its running turn."""
    have = set(json.loads(store.get_setting(_key(sid)) or "[]"))
    store.set_setting(_key(sid), json.dumps(sorted(have | set(names))))


def after_turn(job, resumed: bool) -> bool:
    """Called once per finished turn, after goals and flows had their say
    (`resumed`). Queues the carry-on and returns True if it did. Best-effort:
    never raises into the turn lifecycle."""
    try:
        sid = job.store_session_id
        raw = store.get_setting(_key(sid)) if sid else None
        if raw is None:
            return False
        store.set_setting(_key(sid), None)
        if resumed or job.status != "done" or job.interrupted:
            return False
        from bridge import queue_manager
        items = queue_manager.snapshot(sid).get("items") or []
        if any(i.get("status") in ("queued", "running") for i in items):
            return False
        sess = store.get_session(sid) or {}
        text = _TEXT.format(names=", ".join(json.loads(raw)))
        queue_manager.enqueue(
            sid, text=text, prompt=text, images=[], model=None, effort=None,
            permission_mode=None, width=None, sel=[], surface="carry-on",
            chat_id=job.chat_id if job.chat_id is not None else sess.get("chat_id"),
            project=sess.get("project") or "")
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[carry_on] failed: {e}", file=sys.stderr)
        return False
