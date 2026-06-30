"""Interactive PTY-backed terminals for the dashboard, keyed by id.

Each instance is a real shell running in a project (or worktree) directory, wired
to a pseudo-terminal so curses apps, line editing and ANSI all work. Output from
the PTY master is fanned out to every attached websocket; keystrokes and resize
events flow back in. Multiple instances run concurrently.

Same trust boundary as the rest of the dashboard (a caller who can drive Claude
here can already run shell commands), so this exposes that capability rather than
adding a new one. Stdlib only; Unix-only (PTY).
"""

import fcntl
import os
import pty
import signal
import struct
import termios
import threading
import time
import uuid

from bridge.browser import rel

# Hard cap on concurrent terminals (runaway guard). Reap a terminal with no
# attached socket after this many idle seconds — long enough that a build started
# in it survives closing the modal, short enough that orphans don't pile up.
MAX_TERMS = 12
IDLE_REAP = 1800
_DEFAULT_SHELL = os.environ.get("SHELL") or "/bin/bash"

_terms: "dict[str, Term]" = {}
_lock = threading.Lock()


def _rel(path: str) -> str:
    try:
        return rel(path)
    except Exception:  # noqa: BLE001
        return path


class Term:
    def __init__(self, cwd: str, project: str, cols: int, rows: int):
        self.id = uuid.uuid4().hex[:12]
        self.cwd = cwd
        self.project = project
        self.cols = cols
        self.rows = rows
        self.created = time.time()
        self.alive = True
        self.last_detached = 0.0
        self._subs: set = set()                  # {(send, on_close)}
        self._subs_lock = threading.Lock()

        self.pid, self.master = pty.fork()
        if self.pid == 0:                        # child: become the shell
            try:
                os.chdir(cwd)
            except OSError:
                pass
            shell = _DEFAULT_SHELL
            try:
                os.execvp(shell, [os.path.basename(shell), "-i"])
            except OSError:
                os._exit(127)
        self._set_winsize(cols, rows)
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _set_winsize(self, cols: int, rows: int) -> None:
        try:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ,
                        struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

    def _read_loop(self) -> None:
        while True:
            try:
                data = os.read(self.master, 4096)
            except OSError:
                data = b""
            if not data:
                break
            with self._subs_lock:
                subs = list(self._subs)
            for send, _ in subs:
                try:
                    send(data)
                except Exception:  # noqa: BLE001
                    pass
        self.alive = False
        with self._subs_lock:
            subs = list(self._subs)
        for _, on_close in subs:
            if on_close:
                try:
                    on_close()
                except Exception:  # noqa: BLE001
                    pass
        # Shell exited on its own (e.g. `exit`/Ctrl-D): drop it so reconnects 404,
        # close the master, and reap the child (no zombie).
        try:
            os.close(self.master)
        except OSError:
            pass
        with _lock:
            _terms.pop(self.id, None)
        self._reap()

    def _reap(self) -> None:
        for _ in range(15):
            try:
                pid, _ = os.waitpid(self.pid, os.WNOHANG)
                if pid:
                    return
            except OSError:
                return
            time.sleep(0.02)
        try:
            os.killpg(os.getpgid(self.pid), signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass


def create(cwd: str, project: str = "", cols: int = 80, rows: int = 24) -> dict:
    """Spawn a shell in ``cwd``, tagged with ``project`` for grouping."""
    with _lock:
        if len(_terms) >= MAX_TERMS:
            return {"error": f"terminal limit reached ({MAX_TERMS})"}
        try:
            t = Term(cwd, project, cols, rows)
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}
        _terms[t.id] = t
    return {"id": t.id, "project": project, "cwd_rel": _rel(cwd)}


def info(project: "str | None" = None) -> list:
    """Live terminals, optionally filtered to those tagged with ``project``."""
    with _lock:
        terms = list(_terms.values())
    out = []
    for t in terms:
        if project is not None and t.project != project:
            continue
        out.append({"id": t.id, "project": t.project, "cwd_rel": _rel(t.cwd),
                    "cols": t.cols, "rows": t.rows, "created": t.created,
                    "alive": t.alive})
    return out


def attach(tid: str, send, on_close=None):
    """Register a sink for this terminal's output. Returns a token for detach()."""
    t = _terms.get(tid)
    if not t:
        return None
    sub = (send, on_close)
    with t._subs_lock:
        t._subs.add(sub)
    t.last_detached = 0.0
    return sub


def detach(tid: str, sub) -> None:
    t = _terms.get(tid)
    if not t or sub is None:
        return
    with t._subs_lock:
        t._subs.discard(sub)
        empty = not t._subs
    if empty:
        t.last_detached = time.time()


def write(tid: str, data: bytes) -> bool:
    t = _terms.get(tid)
    if not t or not t.alive:
        return False
    try:
        os.write(t.master, data)
        return True
    except OSError:
        return False


def resize(tid: str, cols: int, rows: int) -> bool:
    t = _terms.get(tid)
    if not t:
        return False
    t.cols, t.rows = cols, rows
    t._set_winsize(cols, rows)
    return True


def close(tid: str) -> dict:
    with _lock:
        t = _terms.pop(tid, None)
    if not t:
        return {"ok": False, "error": "no such terminal"}
    t.alive = False
    try:
        os.killpg(os.getpgid(t.pid), signal.SIGHUP)
    except OSError:
        pass
    try:
        os.close(t.master)
    except OSError:
        pass
    threading.Thread(target=t._reap, daemon=True).start()
    return {"ok": True}


def _reaper_loop() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with _lock:
            terms = list(_terms.values())
        for t in terms:
            with t._subs_lock:
                idle = not t._subs
            if (not t.alive) or (idle and t.last_detached and now - t.last_detached > IDLE_REAP):
                close(t.id)


threading.Thread(target=_reaper_loop, daemon=True).start()
