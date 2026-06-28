"""Shared mutable state and locks, used by both the bot and the Mini App.

Reassignable module attributes (miniapp_url, miniapp_tunnel_proc) are accessed
and mutated as ``state.X`` from other modules.
"""

import threading

from bridge import config

active: dict[int, str] = {}      # chat_id -> selected project path
browse: dict[int, str] = {}      # chat_id -> current browser directory

# Per-session run registry. A session may hold only ONE in-flight turn at a time
# (two concurrent --resume on the same Claude session would corrupt its
# transcript), but DIFFERENT sessions run concurrently — so a turn started on one
# surface no longer blocks every other surface/project.
_run_locks: dict[str, threading.Lock] = {}
_run_guard = threading.Lock()
_run_chats: dict[str, int] = {}            # session id -> chat that owns the in-flight turn

miniapp_url: str | None = None             # current public Mini App URL
miniapp_tunnel_proc = None                 # subprocess.Popen for the Mini App tunnel


def acquire_run(session_id: str, chat_id: int) -> bool:
    """Claim the single run slot for one session (non-blocking). Returns False if
    that session already has an in-flight turn; different sessions never contend."""
    with _run_guard:
        lock = _run_locks.setdefault(session_id, threading.Lock())
    if not lock.acquire(blocking=False):
        return False
    with _run_guard:
        _run_chats[session_id] = chat_id
    return True


def release_run(session_id: str) -> None:
    """Free a session's run slot. Safe to call for a slot that isn't held."""
    with _run_guard:
        lock = _run_locks.get(session_id)
        _run_chats.pop(session_id, None)
    if lock is not None and lock.locked():
        lock.release()


def is_running(session_id: str) -> bool:
    with _run_guard:
        return session_id in _run_chats


def running_chats() -> set[int]:
    """Chats that currently own at least one in-flight turn."""
    with _run_guard:
        return set(_run_chats.values())


def any_running() -> bool:
    with _run_guard:
        return bool(_run_chats)


def project_dir(chat_id: int) -> str:
    """The directory Claude runs in for a chat: selected project, else default/base."""
    return active.get(chat_id) or config.DEFAULT_PROJECT or config.BASE_PATH


def project_key(chat_id: int) -> str:
    """Canonical per-project session key: the active project's path relative to
    BASE_PATH (e.g. "/" or "/org/repo"). Used to key store sessions by project."""
    from bridge.browser import rel  # lazy: browser imports state
    return rel(project_dir(chat_id))
