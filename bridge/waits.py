"""Waits: a session that will act after another session finishes.

A turn that ends "I'll merge once the GIT tab session lands" reports DONE, pings
you as finished, and nothing wakes it when that session is done: the promise
only lives in its prose. WaitForSession (bridge/goal_mcp.py, by POST /local/wait)
records it here instead. The waiter reads WAITING wherever the status map
reaches (runner._build_status). When the session it waits on ends a turn, done
or failed, and nothing else is lined up for it (it isn't asking you, a queued
prompt didn't start, it isn't waiting itself), the waiter is queued a prompt
saying how that turn went and what it said it would do. That prompt goes on the
waiter's own queue, so PAUSE holds it the way it holds a goal nudge.

Any turn that starts on the waiter ends its wait (runner.start_streaming_job): a
prompt of yours means you took over, and Claude can call the tool again. A target
you STOPPED keeps its waiters waiting, because its work didn't finish, so
RESUME or CANCEL is yours.

Not built: waiting on anything but a bridge session (CI, a PR, a time, or a VS
Code/terminal session give no turn end to hear), or on several sessions at once.

Persisted next to the DB (waits.json, like limits' limit_resume.json), so a
restart loses nothing. Best-effort: nothing here may raise into a turn.
"""

import json
import os
import re
import sys
import threading
import time

from bridge import config, store

_lock = threading.Lock()
_waits: dict = {}      # waiter sid -> {on, title, then, since, chat_id}
_loaded = False

# Words that don't say which session: "the git tab session" means "git tab".
_FILLER = {"the", "a", "an", "session", "sessions", "one", "that", "this", "which",
           "for", "on", "of", "and", "to"}

DONE = "⧖ **{title}** finished — done{took}.{said}\n\nYou were waiting to: {then}. Carry on."
FAILED = ("⧖ **{title}** failed — {error}.\n\nYou were waiting to: {then}. It didn't finish, "
          "so check before you go ahead.")
EARLY = ("⧖ The user resumed you before **{title}** finished (it is {state}).\n\n"
         "You were waiting to: {then}. Go ahead now, or call WaitForSession again to keep waiting.")


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "waits.json")


def _load_locked() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        with open(_path(), encoding="utf-8") as f:
            _waits.update(json.load(f) or {})
    except (OSError, ValueError):
        pass


def _save_locked() -> None:
    try:
        tmp = _path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_waits, f, indent=2)
        os.replace(tmp, _path())
    except OSError as e:
        print(f"[waits] persist failed: {e}", file=sys.stderr)


def _busy(chat_id: int) -> dict:
    """{sid: status} for this chat's bridge sessions that aren't idle."""
    from bridge import runner  # local import: runner<->waits cycle
    return runner.bridge_status(chat_id)


def get(sid: str) -> "dict | None":
    with _lock:
        _load_locked()
        w = _waits.get(sid)
        return dict(w) if w else None


def waiting(sid: "str | None") -> bool:
    return bool(sid) and get(sid) is not None


def drop(sid: str) -> bool:
    with _lock:
        _load_locked()
        if _waits.pop(sid, None) is None:
            return False
        _save_locked()
        return True


def active() -> dict:
    """Every live wait. One whose target or waiter was archived is dropped here:
    the session it waited on can't finish anymore."""
    with _lock:
        _load_locked()
        gone = [w for w, v in _waits.items()
                if any(not (s := store.get_session(x)) or s.get("archived") for x in (w, v["on"]))]
        for w in gone:
            _waits.pop(w)
        if gone:
            _save_locked()
        return {k: dict(v) for k, v in _waits.items()}


def _match(rows: list, words: str) -> list:
    w = words.strip().lower()
    by_id = [s for s in rows if s["id"] == w or (len(w) >= 6 and s["id"].startswith(w))]
    if by_id:
        return by_id
    toks = [t.replace("/", "-") for t in re.split(r"[^\w/.-]+", w) if t and t not in _FILLER]

    def hay(s: dict) -> str:
        where = os.path.basename((s.get("work_cwd") or s.get("cwd") or "").rstrip("/"))
        return f"{s.get('title') or ''} {where}".lower()
    return [s for s in rows if toks and all(t in hay(s) for t in toks)]


def _listing(rows: list, busy: dict) -> str:
    live = [s for s in rows if s["id"] in busy][:12]
    if not live:
        return "No other session is running right now, so there is nothing to wait on."
    return "Running now:\n" + "\n".join(
        f"- {s.get('title') or 'untitled'} · {busy[s['id']].get('state')} · id {s['id'][:8]}" for s in live)


def add(chat_id: int, waiter: str, words: str, then: str) -> str:
    """Record that `waiter` waits on the session `words` names. The answer is
    text for Claude, a refusal too."""
    words, then = (words or "").strip(), " ".join((then or "").split())[:500]
    busy = _busy(chat_id)
    rows = [s for s in store.list_sessions_all(chat_id) if s["id"] != waiter]
    if not words or words == "?":
        return _listing(rows, busy)
    if not then:
        return "Say what you will do when it finishes: `then` is required."
    hits = _match(rows, words)
    live = [s for s in hits if s["id"] in busy]
    if not live:
        if hits:
            return (f"{hits[0].get('title') or hits[0]['id'][:8]} isn't running anything. If it already "
                    "did what you need, carry on now.")
        return f'No session matches "{words}". ' + _listing(rows, busy)
    if len(live) > 1:
        return ("More than one session matches; call again with an id.\n"
                + _listing(live, busy))
    t = live[0]
    title = t.get("title") or t["id"][:8]
    with _lock:
        _load_locked()
        seen, cur = set(), t["id"]
        while cur in _waits and cur not in seen:
            seen.add(cur)
            cur = _waits[cur]["on"]
        if cur == waiter:
            return f"{title} is waiting on you; waiting on it back would deadlock. Do what it needs first."
        _waits[waiter] = {"on": t["id"], "title": title, "then": then,
                          "since": time.time(), "chat_id": chat_id}
        _save_locked()
    return (f"Waiting on {title} ({busy[t['id']].get('label') or busy[t['id']].get('state')}). "
            "End your turn now with one line saying what you are waiting for. The bridge "
            "wakes you when it finishes and tells you how it went. If the user sends you a "
            "prompt first, the wait ends; call WaitForSession again if you still need it.")


def _wake(waiter: str, w: dict, text: str, body: str) -> None:
    from bridge import queue_manager, runner  # local import: runner<->waits cycle
    sess = store.get_session(waiter) or {}
    queue_manager.enqueue(waiter, text=text, prompt=text, images=[], model=None, effort=None,
                          permission_mode=None, width=None, sel=[], surface="wait",
                          chat_id=w["chat_id"], project=sess.get("project") or "")
    runner.notify_woken(w["chat_id"], waiter, body)


def resume(sid: str) -> bool:
    """RESUME NOW: wake it before its target finishes."""
    w = get(sid)
    if not w or not drop(sid):
        return False
    st = (_busy(w["chat_id"]).get(w["on"]) or {}).get("state") or "idle"
    _wake(sid, w, EARLY.format(title=w["title"], state=st, then=w["then"]),
          f"resumed before {w['title']} finished")
    return True


def target_ended(job) -> None:
    """A turn ended done or failed. Wakes whoever waited on that session, unless
    it's busy again (its queue started the next prompt) or is waiting itself (a
    chain)."""
    try:
        from bridge import report, state  # local import: report pulls the store in
        sid = job.store_session_id
        if not sid or state.is_running(sid) or waiting(sid):
            return
        with _lock:
            _load_locked()
            woke = {w: v for w, v in _waits.items() if v["on"] == sid}
            for w in woke:
                _waits.pop(w)
            if woke:
                _save_locked()
        for w, v in woke.items():
            if job.status == "done":
                last = (job.result or (job.texts[-1] if job.texts else "")).strip().split("\n\n")[-1].strip()
                last = last if len(last) <= 400 else last[:399] + "…"
                took = f" in {report._dur(job.elapsed)}" if job.elapsed else ""
                _wake(w, v, DONE.format(title=v["title"], took=took, then=v["then"],
                                        said=f' It ended with: "{last}"' if last else ""),
                      f"{v['title']} finished")
            else:
                err = (job.error_msg or "the turn errored").strip()[:300]
                _wake(w, v, FAILED.format(title=v["title"], error=err, then=v["then"]),
                      f"{v['title']} failed")
    except Exception as e:  # noqa: BLE001 — never raise out of a turn's teardown
        print(f"[waits] wake failed: {e}", file=sys.stderr)
