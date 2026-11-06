"""wait_for: a session that wakes when a time passes, a PR's checks end, or a port answers.

bridge/waits.py waits on another session, because the bridge hears a turn end. These are
things it has to go and look at, so one thread looks every POLL_S while any are waiting.
The wake-up goes on the session's queue, as a wait's does, so PAUSE holds it. A prompt from
you ends the wait (runner.start_streaming_job drops it), the same rule as waits.py.

Persisted next to the DB, so a restart keeps them. Capped at MAX_S: past that the agent is
told nothing happened rather than waiting forever. Best-effort: nothing here may raise
into a turn. Stdlib only, plus `gh`, which the bridge already uses for PRs.
"""

import json
import os
import re
import socket
import subprocess
import sys
import threading
import time

from bridge import config, store

POLL_S = 20
MAX_S = 24 * 3600
_lock = threading.Lock()
_waits: dict = {}
_loaded = False
_thread: "threading.Thread | None" = None


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "timed_waits.json")


def _load() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        with open(_path(), encoding="utf-8") as f:
            _waits.update(json.load(f) or {})
    except (OSError, ValueError):
        pass


def _save() -> None:
    try:
        tmp = _path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_waits, f, indent=2)
        os.replace(tmp, _path())
    except OSError as e:
        print(f"[timed_waits] persist: {e}", file=sys.stderr)


def add(s: dict, a: dict) -> str:
    kind, then = str(a.get("kind") or ""), " ".join(str(a.get("then") or "").split())[:500]
    if not then:
        return "Say what you'll do when it happens: `then` is required."
    w = {"chat_id": s["chat_id"], "kind": kind, "then": then, "since": time.time(), "cwd": s.get("work_cwd") or s.get("cwd")}
    if kind == "time":
        secs = int(a.get("seconds") or 0)
        if not 1 <= secs <= MAX_S:
            return f"seconds must be 1-{MAX_S}."
        w["at"] = time.time() + secs
        what = f"{secs} s from now"
    elif kind == "pr":
        pr = str(a.get("pr") or "").strip()
        if not re.fullmatch(r"\d+|https://github\.com/[\w.-]+/[\w.-]+/pull/\d+", pr):
            return "pr must be a number or a github.com pull request URL."
        w["pr"] = pr
        what = f"PR {pr}'s checks to finish"
    elif kind == "port":
        port = int(a.get("port") or 0)
        if not 1 <= port <= 65535:
            return "port must be 1-65535."
        w["port"] = port
        what = f"port {port} to answer"
    else:
        return "kind must be time, pr or port."
    with _lock:
        _load()
        _waits[s["id"]] = w
        _save()
    _ensure_thread()
    return f"Waiting for {what}. End your turn now with one line. If the user sends a prompt first, the wait ends."


def drop(sid: str) -> None:
    with _lock:
        _load()
        if _waits.pop(sid, None) is not None:
            _save()


def pending(sid: str) -> "dict | None":
    with _lock:
        _load()
        w = _waits.get(sid)
        return dict(w) if w else None


def _pr_state(w: dict) -> "str | None":
    """pass, fail or None while running."""
    try:
        p = subprocess.run(["gh", "pr", "checks", w["pr"], "--json", "bucket"], capture_output=True, text=True,
                           timeout=30, cwd=w.get("cwd") or None)
        rows = json.loads(p.stdout or "[]")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    buckets = {r.get("bucket") for r in rows}
    if not rows or "pending" in buckets:
        return None
    return "fail" if "fail" in buckets or "cancel" in buckets else "pass"


def _done(w: dict) -> "str | None":
    """What happened, or None if it hasn't. Called off the lock."""
    if time.time() - w["since"] > MAX_S:
        return "That didn't happen within a day, so the wait ended."
    if w["kind"] == "time":
        return "The time you asked for has passed." if time.time() >= w["at"] else None
    if w["kind"] == "port":
        try:
            with socket.create_connection(("127.0.0.1", w["port"]), timeout=1):
                return f"Port {w['port']} is answering."
        except OSError:
            return None
    state = _pr_state(w)
    return None if state is None else f"PR {w['pr']}'s checks finished: {'all passed' if state == 'pass' else 'some failed'}."


def _wake(sid: str, w: dict, said: str) -> None:
    from bridge import queue_manager
    sess = store.get_session(sid)
    if not sess or sess.get("archived"):
        return
    text = f"⧖ {said}\n\nYou were waiting to: {w['then']}. Carry on."
    queue_manager.enqueue(sid, text=text, prompt=text, images=[], model=None, effort=None, permission_mode=None,
                          width=None, sel=[], surface="wait", chat_id=w["chat_id"],
                          project=sess.get("cwd") or sess.get("project") or "")


def _tick() -> None:
    with _lock:
        _load()
        items = list(_waits.items())
    for sid, w in items:
        try:
            said = _done(w)
        except Exception as e:  # noqa: BLE001
            print(f"[timed_waits] {e!r}", file=sys.stderr)
            continue
        if said:
            drop(sid)
            try:
                _wake(sid, w, said)
            except Exception as e:  # noqa: BLE001
                print(f"[timed_waits] wake: {e!r}", file=sys.stderr)


def _loop() -> None:
    while True:
        time.sleep(POLL_S)
        _tick()


def _ensure_thread() -> None:
    global _thread
    with _lock:
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(target=_loop, name="timed-waits", daemon=True)
            _thread.start()


def resume() -> None:
    """Boot: keep watching what a restart left."""
    with _lock:
        _load()
        any_left = bool(_waits)
    if any_left:
        _ensure_thread()
