"""Ad-hoc shell commands run in the active project's directory and streamed to
every surface — a direct remote terminal.

Same trust boundary as the rest of the bridge: a caller who can drive Claude here
can already run commands (dashboard/Mini App sessions default to bypassPermissions),
so this surfaces that capability rather than adding a new one. One command runs at
a time; its merged stdout/stderr streams live (pubsub "shell" topic + a cursor-keyed
ring buffer for polling clients) and can be killed. Stdlib only.
"""

import os
import signal
import subprocess
import threading
from collections import deque

from bridge import pubsub
from bridge.browser import rel

# Cap a runaway command (a hung process with no output). Generous; an explicit
# kill is the normal stop. Override via env.
SHELL_TIMEOUT = int(os.environ.get("SHELL_TIMEOUT", "900"))

_proc: subprocess.Popen | None = None
_cmd: str | None = None
_dir: str | None = None
_status = "idle"          # idle | running | done | error | killed
_code: int | None = None
_lock = threading.Lock()
_lines: deque = deque(maxlen=2000)   # (seq, text)
_seq = 0


def _append(text: str) -> None:
    global _seq
    # Under _lock: the reader thread appends while snapshot() iterates _lines;
    # an unlocked mutation raises "deque mutated during iteration" (flaky 500s).
    with _lock:
        _seq += 1
        seq = _seq
        _lines.append((seq, text))
    pubsub.publish("shell", {"seq": seq, "line": text})


def alive() -> bool:
    return _proc is not None and _proc.poll() is None


def _reader(proc: subprocess.Popen) -> None:
    global _status, _code
    if proc.stdout:
        for line in proc.stdout:
            _append(line.rstrip("\n"))
    proc.wait()
    with _lock:
        if _status == "running":
            _status = "error" if proc.returncode else "done"
        _code = proc.returncode
    _append(f"— exited (code {proc.returncode}) —")


def _kill_proc(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=5)
    except (ProcessLookupError, PermissionError):
        pass
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.wait(timeout=5)      # reap, so the killed child isn't left a zombie
        except (OSError, subprocess.TimeoutExpired):
            pass


def _watchdog(proc: subprocess.Popen) -> None:
    try:
        proc.wait(timeout=SHELL_TIMEOUT)
    except subprocess.TimeoutExpired:
        _kill_proc(proc)


def run(cwd: str, command: str) -> dict:
    """Start `command` in `cwd`. Refuses if a command is already running."""
    global _proc, _cmd, _dir, _status, _code
    command = (command or "").strip()
    if not command:
        return {"ok": False, "error": "empty command"}
    with _lock:
        if alive():
            return {"ok": False, "error": "a command is already running"}
        _cmd, _dir, _status, _code = command, cwd, "running", None
        try:
            proc = subprocess.Popen(
                command, cwd=cwd, shell=True, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, bufsize=1,
                start_new_session=True)
        except Exception as e:  # noqa: BLE001
            _status = "error"
            return {"ok": False, "error": str(e)}
        _proc = proc
    _append(f"$ {command}")
    threading.Thread(target=_reader, args=(proc,), daemon=True).start()
    threading.Thread(target=_watchdog, args=(proc,), daemon=True).start()
    return {"ok": True}


def kill() -> dict:
    global _status
    with _lock:
        p = _proc
        if not (p is not None and p.poll() is None):
            return {"ok": False, "error": "nothing running"}
        _status = "killed"
    _kill_proc(p)
    return {"ok": True}


def snapshot(cursor: int = 0) -> dict:
    """Current status + output lines with seq > cursor (cursor-keyed polling)."""
    with _lock:
        lines = [{"seq": s, "line": t} for (s, t) in _lines if s > cursor]
        return {"status": _status, "cmd": _cmd, "running": alive(),
                "dir": rel(_dir) if _dir else None, "code": _code,
                "lines": lines, "cursor": _seq}
