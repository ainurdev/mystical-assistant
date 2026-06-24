"""Dev server: a long-lived background process owned by the bridge."""

import os
import signal
import subprocess
import threading
import time
from collections import deque

from bridge import config, pubsub, state
from bridge.browser import rel
from bridge.telegram import send

# Dev-server logs are also teed to this file *inside the project* so a Claude
# session running in the same cwd can simply read it (e.g. `tail .mystical/dev.log`).
DEV_LOG_REL = os.path.join(".mystical", "dev.log")

_server_proc: subprocess.Popen | None = None
_server_log: deque = deque(maxlen=300)
_server_cmd: str | None = None
_server_dir: str | None = None
_server_logfile = None  # open file handle for DEV_LOG_REL, or None
_server_lock = threading.Lock()


def _server_alive() -> bool:
    return _server_proc is not None and _server_proc.poll() is None


def _open_logfile(cwd: str):
    """Open <cwd>/.mystical/dev.log (truncating) and self-ignore the dir from
    git. Best-effort: returns the file handle, or None if it can't be created."""
    try:
        d = os.path.join(cwd, ".mystical")
        os.makedirs(d, exist_ok=True)
        gi = os.path.join(d, ".gitignore")
        if not os.path.exists(gi):
            with open(gi, "w", encoding="utf-8") as f:
                f.write("*\n")  # the .mystical dir never shows up in git status
        return open(os.path.join(d, "dev.log"), "w", encoding="utf-8", buffering=1)
    except OSError:
        return None


def _close_logfile():
    global _server_logfile
    if _server_logfile is not None:
        try:
            _server_logfile.close()
        except OSError:
            pass
        _server_logfile = None


def _server_reader(proc: subprocess.Popen):
    if proc.stdout:
        for line in proc.stdout:
            line = line.rstrip("\n")
            _server_log.append(line)
            f = _server_logfile
            if f is not None:
                try:
                    f.write(line + "\n")
                except (OSError, ValueError):
                    pass
            pubsub.publish("logs", {"line": line})


def start_server(cmd: str, cwd: str) -> str:
    global _server_proc, _server_cmd, _server_dir, _server_logfile
    with _server_lock:
        if _server_alive():
            return (f"⚙️ Server already running (pid {_server_proc.pid}) in "
                    f"{rel(_server_dir)}: {_server_cmd}\nUse /server stop first.")
        _server_log.clear()
        _close_logfile()
        _server_logfile = _open_logfile(cwd)
        try:
            proc = subprocess.Popen(
                cmd, cwd=cwd, shell=True, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, bufsize=1,
                start_new_session=True)
        except Exception as e:  # noqa: BLE001
            return f"❌ Failed to start: {e}"
        _server_proc, _server_cmd, _server_dir = proc, cmd, cwd
        threading.Thread(target=_server_reader, args=(proc,), daemon=True).start()
        time.sleep(2)
        if proc.poll() is not None:
            tail = "\n".join(list(_server_log)[-15:]) or "(no output)"
            return f"❌ Server exited immediately (code {proc.returncode}):\n{tail}"
        return (f"✅ Server started (pid {proc.pid}) in {rel(cwd)}: {cmd}\n"
                f"/preview {config.PREVIEW_PORT} to open it · /logs to see output.")


def stop_server() -> str:
    global _server_proc
    with _server_lock:
        if not _server_alive():
            _server_proc = None
            return "No server is running."
        try:
            os.killpg(os.getpgid(_server_proc.pid), signal.SIGTERM)
            _server_proc.wait(timeout=8)
        except (ProcessLookupError, PermissionError):
            pass
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(_server_proc.pid), signal.SIGKILL)
        _server_proc = None
        _close_logfile()
        return "🛑 Server stopped."


def server_status() -> str:
    if _server_alive():
        return f"running (pid {_server_proc.pid}) in {rel(_server_dir)}: {_server_cmd}"
    if _server_proc is not None:
        return f"exited (code {_server_proc.returncode}): {_server_cmd}"
    return "not started"


def server_state() -> dict:
    """Structured status for the Mini App API."""
    if _server_alive():
        return {"status": "running", "cmd": _server_cmd,
                "dir": rel(_server_dir), "pid": _server_proc.pid}
    if _server_proc is not None:
        return {"status": "exited", "cmd": _server_cmd,
                "dir": rel(_server_dir) if _server_dir else None, "pid": None}
    return {"status": "not started", "cmd": None, "dir": None, "pid": None}


def log_tail(n: int = 200) -> list[str]:
    return list(_server_log)[-n:]


def handle_server(chat_id: int, arg: str):
    parts = arg.split(maxsplit=1)
    sub = parts[0] if parts else "start"
    rest = parts[1] if len(parts) > 1 else ""
    if sub == "stop":
        send(chat_id, stop_server())
    elif sub == "status":
        send(chat_id, "Server: " + server_status())
    elif sub in ("start", ""):
        cmd = rest or config.START_CMD
        send(chat_id, f"🚀 Starting in {rel(state.project_dir(chat_id))}: {cmd}")
        send(chat_id, start_server(cmd, state.project_dir(chat_id)))
    else:
        send(chat_id, f"🚀 Starting in {rel(state.project_dir(chat_id))}: {arg}")
        send(chat_id, start_server(arg, state.project_dir(chat_id)))


def handle_logs(chat_id: int, arg: str):
    try:
        n = int(arg) if arg else 40
    except ValueError:
        n = 40
    lines = log_tail(n)
    body = "\n".join(lines) if lines else "(no server output yet)"
    send(chat_id, f"📄 Last {len(lines)} log line(s):\n\n{body}")
