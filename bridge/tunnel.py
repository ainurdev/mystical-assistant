"""cloudflared quick tunnels.

Two uses:
  - the preview tunnel for the dev server (/preview), managed via module globals
  - the always-on Mini App tunnel, spawned with open_quick_tunnel() and owned by
    the caller (so /preview never tears it down)
"""

import re
import subprocess
import threading
import time

from bridge import config
from bridge.telegram import send

_TRYCF_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

_tunnel_proc: subprocess.Popen | None = None
_tunnel_url: str | None = None
_tunnel_port: int | None = None
_tunnel_lock = threading.Lock()


def _drain(proc: subprocess.Popen):
    if proc.stdout:
        for _ in proc.stdout:
            pass


def _spawn_tunnel(port: int):
    """Start cloudflared, return (proc, url) or (None, None) on failure.

    The returned proc still has an open stdout pipe; the caller must drain it
    (e.g. via a _drain thread) to avoid blocking once the buffer fills.
    """
    try:
        proc = subprocess.Popen(
            [config.CLOUDFLARED_BIN, "tunnel", "--url", f"http://localhost:{port}"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    except FileNotFoundError:
        return None, None
    url, deadline = None, time.time() + 30
    assert proc.stdout is not None
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                break
            continue
        m = _TRYCF_RE.search(line)
        if m:
            url = m.group(0)
            break
    if not url:
        proc.terminate()
        return None, None
    return proc, url


def open_quick_tunnel(port: int):
    """Start a standalone quick tunnel and return (proc, url). Caller owns the proc."""
    proc, url = _spawn_tunnel(port)
    if proc and url:
        threading.Thread(target=_drain, args=(proc,), daemon=True).start()
    return proc, url


def _stop_tunnel_locked():
    global _tunnel_proc, _tunnel_url, _tunnel_port
    if _tunnel_proc and _tunnel_proc.poll() is None:
        _tunnel_proc.terminate()
        try:
            _tunnel_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _tunnel_proc.kill()
    _tunnel_proc = _tunnel_url = _tunnel_port = None


def start_tunnel(port: int):
    global _tunnel_proc, _tunnel_url, _tunnel_port
    with _tunnel_lock:
        if _tunnel_proc and _tunnel_proc.poll() is None and _tunnel_url:
            if _tunnel_port == port:
                return _tunnel_url, f"🔗 Already live:\n{_tunnel_url}"
            _stop_tunnel_locked()
        proc, url = _spawn_tunnel(port)
        if not proc:
            if not _which_cloudflared():
                return (None, "❌ `cloudflared` not found. Install it first.")
            return (None, f"❌ Couldn't get a tunnel URL. Is something running on "
                          f"port {port}? (A config.yml in ~/.cloudflared blocks "
                          "quick tunnels.)")
        _tunnel_proc, _tunnel_url, _tunnel_port = proc, url, port
        threading.Thread(target=_drain, args=(proc,), daemon=True).start()
        return url, (f"🔗 Preview live (port {port}):\n{url}\n\n"
                     "⚠️ Public link — anyone with it can reach your server. "
                     "/preview stop when done.")


def _which_cloudflared() -> bool:
    import shutil
    return shutil.which(config.CLOUDFLARED_BIN) is not None


def stop_tunnel() -> str:
    with _tunnel_lock:
        if not (_tunnel_proc and _tunnel_proc.poll() is None):
            return "No preview tunnel is running."
        _stop_tunnel_locked()
        return "🛑 Preview tunnel stopped."


def tunnel_state() -> dict:
    if _tunnel_proc and _tunnel_proc.poll() is None and _tunnel_url:
        return {"url": _tunnel_url, "port": _tunnel_port}
    return {"url": None, "port": None}


def handle_preview(chat_id: int, arg: str):
    if arg == "stop":
        send(chat_id, stop_tunnel())
        return
    try:
        port = int(arg) if arg else config.PREVIEW_PORT
    except ValueError:
        send(chat_id, "Usage: /preview [port]  or  /preview stop")
        return
    send(chat_id, f"🚇 Starting tunnel to localhost:{port}…")
    _, message = start_tunnel(port)
    send(chat_id, message)
