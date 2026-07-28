"""Public tunnels.

Two uses:
  - the always-on Mini App panel tunnel: the *named* tunnel when one is configured,
    so the panel keeps one fixed hostname (https://config.PREVIEW_HOSTNAME) across
    restarts and the link in Telegram never rots. Spawned with open_panel_tunnel()
    and owned by the caller (so /preview never tears it down).
  - the preview tunnel for the dev server (/preview): an ephemeral quick tunnel,
    managed via module globals. Its hostname is throwaway, which is fine — the link
    is pasted fresh each time. The named tunnel can't be shared: two connectors on
    one tunnel with different ingress make routing a coin flip.
"""

import os
import re
import subprocess
import threading
import time

from bridge import config
from bridge.telegram import send

_TRYCF_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
_REGISTERED_RE = re.compile(r"Registered tunnel connection")
# After the connector registers, the edge needs a moment to propagate the route
# for the hostname (a cold route otherwise returns 1033 on the first request).
_EDGE_SETTLE = 5.0

_tunnel_proc: subprocess.Popen | None = None
_tunnel_url: str | None = None
_tunnel_port: int | None = None
_tunnel_lock = threading.Lock()


def _cf_env() -> dict:
    """The environment the tunnel client should run with: ours, minus every TUNNEL_*.

    run.sh exports the whole .env, and the tunnel client reads TUNNEL_* env vars as CLI
    flags — so our TUNNEL_ID/TUNNEL_NAME arrive as `--id`/`--name` and turn a
    quick tunnel into a named-tunnel run that fails on a missing origin cert.
    Both spawners pass their tunnel's identity explicitly (--url / --config), so
    nothing here needs them.
    """
    return {k: v for k, v in os.environ.items() if not k.startswith("TUNNEL_")}


def _spawn_tunnel(port: int):
    """Start the tunnel client, return (proc, url) or (None, None) on failure.

    A daemon watch thread scans stdout for the URL and then keeps draining the
    pipe for the process's lifetime, so the caller need not drain it.
    """
    try:
        proc = subprocess.Popen(
            [config.CLOUDFLARED_BIN, "tunnel", "--url", f"http://localhost:{port}"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            env=_cf_env())
    except FileNotFoundError:
        return None, None
    # A reader thread scans for the URL and keeps draining the pipe; we bound the
    # wait with an Event (mirrors _spawn_named). A blocking readline() here would
    # ignore the deadline until the client prints — and start_tunnel holds the
    # tunnel lock, so a silent/hung client would wedge every /preview request.
    found = {"url": None}
    ready = threading.Event()

    def _watch():
        assert proc.stdout is not None
        for line in proc.stdout:
            m = _TRYCF_RE.search(line)
            if m and not ready.is_set():
                found["url"] = m.group(0)
                ready.set()
        ready.set()   # stdout closed (process exited) without a URL — unblock

    threading.Thread(target=_watch, daemon=True).start()
    ready.wait(timeout=30)
    url = found["url"]
    if not url:
        proc.terminate()
        return None, None
    return proc, url


def open_quick_tunnel(port: int):
    """Start a standalone quick tunnel and return (proc, url). Caller owns the proc.
    _spawn_tunnel's watch thread already drains stdout, so nothing to do here."""
    return _spawn_tunnel(port)


def open_panel_tunnel(port: int):
    """Tunnel for the Mini App panel — named when configured, else quick.

    A quick tunnel mints a new hostname every run, which silently kills the panel
    link already baked into Telegram's menu button and every "Open Panel" button
    in past messages. The named tunnel's hostname is fixed, so those keep working.
    """
    if _named_configured():
        proc, info = _spawn_named(port)
        if proc:
            return proc, info
    return open_quick_tunnel(port)


def _write_config(port: int) -> str:
    """Write the tunnel client's ingress config pointing PREVIEW_HOSTNAME at `port`."""
    cfg = config.TUNNEL_CONFIG_FILE
    os.makedirs(os.path.dirname(cfg), exist_ok=True)
    with open(cfg, "w") as f:
        f.write(
            f"tunnel: {config.TUNNEL_ID}\n"
            f"credentials-file: {config.TUNNEL_CREDENTIALS_FILE}\n"
            "ingress:\n"
            f"  - hostname: {config.PREVIEW_HOSTNAME}\n"
            f"    service: http://localhost:{port}\n"
            "  - service: http_status:404\n")
    return cfg


def _spawn_named(port: int):
    """Run the named tunnel for `port`. Return (proc, url) once the connector has
    registered and the edge route has settled, else (None, reason) where reason is
    'missing-bin' or 'no-connection'.

    A watch thread scans stdout for the first 'Registered tunnel connection' line
    (the connector is up) and then keeps draining the pipe (so it never blocks). The
    public URL is the fixed PREVIEW_HOSTNAME; after readiness we wait _EDGE_SETTLE
    for the edge route to propagate before handing the URL back."""
    cfg = _write_config(port)
    try:
        proc = subprocess.Popen(
            [config.CLOUDFLARED_BIN, "tunnel", "--config", cfg, "run"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            env=_cf_env())
    except FileNotFoundError:
        return None, "missing-bin"

    ready = threading.Event()

    def _watch():
        assert proc.stdout is not None
        for line in proc.stdout:
            if _REGISTERED_RE.search(line):
                ready.set()
                break
        for _ in proc.stdout:  # keep draining so the pipe never fills
            pass

    threading.Thread(target=_watch, daemon=True).start()
    if not ready.wait(timeout=30):
        proc.terminate()
        return None, "no-connection"
    time.sleep(_EDGE_SETTLE)
    return proc, f"https://{config.PREVIEW_HOSTNAME}"


def _stop_tunnel_locked():
    global _tunnel_proc, _tunnel_url, _tunnel_port
    if _tunnel_proc and _tunnel_proc.poll() is None:
        _tunnel_proc.terminate()
        try:
            _tunnel_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _tunnel_proc.kill()
    _tunnel_proc = _tunnel_url = _tunnel_port = None


def _named_configured() -> bool:
    """A stable named tunnel is usable only if the hostname, id, and local
    credentials file are all present. Otherwise /preview uses a quick tunnel."""
    return bool(config.TUNNEL_ID and config.PREVIEW_HOSTNAME
                and os.path.isfile(config.TUNNEL_CREDENTIALS_FILE))


def start_tunnel(port: int):
    """Start the preview tunnel for `port` — an ephemeral throwaway-hostname quick
    tunnel (the named tunnel, when there is one, fronts the Mini App panel)."""
    if port in (config.MINIAPP_PORT, config.DASH_PORT):
        return (None, f"❌ Refusing to tunnel reserved port {port} "
                      "(Mini App / dashboard must never be public).")
    if not 1 <= port <= 65535:
        return (None, f"❌ Invalid port {port}.")
    global _tunnel_proc, _tunnel_url, _tunnel_port
    with _tunnel_lock:
        if _tunnel_proc and _tunnel_proc.poll() is None and _tunnel_url:
            if _tunnel_port == port:
                return _tunnel_url, f"🔗 Already live (port {port}):\n{_tunnel_url}"
            _stop_tunnel_locked()
        proc, url = open_quick_tunnel(port)
        if not proc or not url:
            if not _have_tunnel_client():
                return (None, "❌ Tunnel client not found. Run ./setup.sh to install it.")
            return (None, "❌ Couldn't establish a quick tunnel.")
        _tunnel_proc, _tunnel_url, _tunnel_port = proc, url, port
        return url, (f"🔗 Preview live (port {port}):\n{url}\n\n"
                     "⚠️ Public link — anyone with it can reach your server while "
                     "it's running. /preview stop when done.")


def _have_tunnel_client() -> bool:
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
