"""The Mystical browser: a real window on a site, where you pin comments and send them to a chat.

The design view frames a site through a proxy (bridge/design_proxy.py), and a real app breaks
there: its sign-in leaves the proxy's origin, and cookies don't reach a frame. So "open site X"
starts a visible Chromium on a profile of its own (sign-ins kept between runs, your everyday
browser untouched) with the comment extension (bridge/browser_ext) loaded. It is Playwright's
Chromium, Chrome for Testing: branded Google Chrome has ignored --load-extension since 137.

The extension talks to the small loopback server here, never the dashboard: the dashboard only
takes POSTs from its own origin, and an extension's origin isn't that. The server wants a secret
token (written into the extension's config.json, which only the extension and this machine can
read) and its own Host, the same DNS-rebinding guard the design proxy has. Its port and token
outlive a bridge restart, so a browser left open keeps working once the bridge is back. The
tray wears the theme the dashboard last saved (bridge/design_board.save_theme), from GET /theme.

A site remembers the chat that last opened it or was sent to: Send all goes there unless you pick another
running chat or a new one on the same project. Comments arrive as one turn of yours, tagged
"via Mystical browser", each with a crop of what it points at attached as comment-N.png.

shortcut: the opener is kept per origin, so two chats with tabs on one site share the last
opener (the menu still picks either); key it by tab once that bites.
shortcut: which window is up and what's pinned are only in memory, so after a bridge restart the
card says the window is down (Open again just adds a tab) until a pin changes; keep them on disk
if that confuses. Close quits only the browser this bridge started, every tab. Stdlib only.
"""

import glob
import hmac
import json
import os
import platform
import secrets
import shutil
import subprocess
import sys
import threading
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from bridge import config, design_board, store
from bridge.design_proxy import Refused, normalize

EXT_SRC = os.path.join(os.path.dirname(__file__), "browser_ext")
_MAX_BODY = 40 * 1024 * 1024
_MAX_COMMENTS = 30
_lock = threading.Lock()
_server: "ThreadingHTTPServer | None" = None
_procs: list = []
_pins: dict = {}      # page url -> pinned, not sent


def home() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "browser")


def _ext() -> str:
    return os.path.join(home(), "ext")


def _profile() -> str:
    return os.path.join(home(), "profile")


def chromium() -> "str | None":
    """Playwright's newest Chromium on this machine."""
    roots = [os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "",
             os.path.expanduser("~/Library/Caches/ms-playwright"), os.path.expanduser("~/.cache/ms-playwright")]
    found = []
    for root in filter(None, roots):
        for d in glob.glob(os.path.join(root, "chromium-*")):
            tail = d.rsplit("-", 1)[-1]
            if not tail.isdigit():
                continue
            for b in ("chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
                      "chrome-mac*/Chromium.app/Contents/MacOS/Chromium", "chrome-linux*/chrome"):
                found += [(int(tail), p) for p in glob.glob(os.path.join(d, b)) if os.access(p, os.X_OK)]
    return max(found)[1] if found else None


# ------- who opened what -------------------------------------------------------------

def _origin(url: str) -> str:
    p = urllib.parse.urlparse(url)
    return f"{p.scheme}://{p.netloc}".lower()


def _openers() -> dict:
    try:
        with open(os.path.join(home(), "openers.json")) as f:
            got = json.load(f)
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def _remember(url: str, sid: str) -> None:
    got = _openers()
    got[_origin(url)] = sid
    os.makedirs(home(), exist_ok=True)
    tmp = os.path.join(home(), "openers.json.tmp")
    with open(tmp, "w") as f:
        json.dump(got, f)
    os.replace(tmp, os.path.join(home(), "openers.json"))


def opener(url: str) -> "dict | None":
    sid = _openers().get(_origin(url))
    s = store.get_session(sid) if sid else None
    return s if s and not s.get("archived") else None


def _clean(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def _brief(s: dict) -> dict:
    return {"id": s["id"], "title": s.get("title") or "Untitled chat", "project": s.get("project") or ""}


# ------- the extension's server --------------------------------------------------------

def _config() -> dict:
    try:
        with open(os.path.join(_ext(), "config.json")) as f:
            got = json.load(f)
        if isinstance(got.get("port"), int) and isinstance(got.get("token"), str) and len(got["token"]) >= 32:
            return got
    except (OSError, ValueError):
        pass
    return {}


def _install(port: int, token: str) -> None:
    """The extension as shipped, plus this bridge's port and token. Chromium reads an
    unpacked extension's files from disk, so a new port reaches a browser already open."""
    os.makedirs(home(), exist_ok=True)
    tmp = _ext() + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(EXT_SRC, tmp)
    fd = os.open(os.path.join(tmp, "config.json"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"port": port, "token": token}, f)
    shutil.rmtree(_ext(), ignore_errors=True)
    os.replace(tmp, _ext())


def serve() -> int:
    """Start the extension's server (once), on the port it had before when it's free."""
    global _server
    with _lock:
        if _server:
            return _server.server_address[1]
        cfg = _config()
        token = cfg.get("token") or secrets.token_urlsafe(32)
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", cfg.get("port") or 0), _Handler)
        except OSError:
            srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        srv.token = token
        srv.daemon_threads = True
        port = srv.server_address[1]
        _install(port, token)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        _server = srv
        return port


def serve_if_used() -> None:
    """At boot: back up for a browser that may still be open, never for one never launched."""
    if _config():
        try:
            serve()
        except OSError as e:
            print(f"[site_browser] the extension's server didn't start: {e}", file=sys.stderr)


def stop_serving() -> None:
    global _server
    with _lock:
        if _server:
            _server.shutdown()
            _server.server_close()
            _server = None


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _out(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _allowed(self) -> bool:
        port = self.server.server_address[1]
        host_ok = self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}")
        tok = self.headers.get("X-Mystical-Token") or ""
        if host_ok and hmac.compare_digest(tok.encode(), self.server.token.encode()):
            return True
        self._out(403, {"error": "Not this browser's token."})
        return False

    def do_GET(self):
        if not self._allowed():
            return
        u = urllib.parse.urlparse(self.path)
        if u.path == "/theme":
            return self._out(200, design_board.theme())
        if u.path != "/chats":
            return self._out(404, {"error": "No such route."})
        self._out(200, chats((urllib.parse.parse_qs(u.query).get("url") or [""])[0]))

    def do_POST(self):
        if not self._allowed():
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 <= n <= _MAX_BODY:
                return self._out(413, {"error": "Too much to send at once."})
            body = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self._out(400, {"error": "That wasn't JSON."})
        try:
            if self.path == "/pins":
                return self._out(200, pinned(body))
            if self.path == "/send":
                return self._out(200, send(body))
        except (Refused, ValueError, TypeError) as e:
            return self._out(400, {"error": str(e) if isinstance(e, Refused) else "That request didn't make sense."})
        self._out(404, {"error": "No such route."})


# ------- what the extension asks ----------------------------------------------------------

def chats(url: str) -> dict:
    """Who Send all goes to by default, and the open chats it could go to instead."""
    o = opener(url) if url else None
    rows = store.list_sessions_all(config.DASH_CHAT_ID, include_archived=False)
    rows.sort(key=lambda r: r.get("updated") or 0, reverse=True)
    return {"opener": _brief(o) if o else None,
            "chats": [_brief(r) for r in rows if not o or r["id"] != o["id"]][:20]}


def pinned(body: dict) -> dict:
    url = str(body.get("url") or "")
    if url:
        with _lock:
            _pins[url] = max(0, int(body.get("count") or 0))
    return {"ok": True}


def state(sid: str, url: str = "") -> dict:
    """For the chat's BROWSER card: is the window up, what's pinned on that site and not sent,
    and whether Send all would come to this chat (sending elsewhere moves it)."""
    site = _origin(url) if url else ""
    with _lock:
        pins = sum(n for u, n in _pins.items() if site and _origin(u) == site)
        up = any(p.poll() is None for p in _procs)
    o = opener(url) if url else None
    return {"running": up, "pinned": pins, "to": None if not o or o["id"] == sid else _brief(o)["title"]}


def _prompt(url: str, comments: list, viewport: str) -> str:
    n = len(comments)
    lines = [f"{n} comment{'s' if n != 1 else ''} from the Mystical browser on {url}"
             + (f" (window {viewport})" if viewport else "") + ":", ""]
    for i, c in enumerate(comments, 1):
        lines.append(f"{i}. {c['text']}")
        if c.get("where"):
            lines.append(f"   at: {c['where']}")
        if c.get("crop"):
            lines.append(f"   picture: comment-{i}.png")
    lines += ["", "Apply these in the code. The site may be a deployed staging build, so say what you changed rather than "
              "expecting the page to update."]
    return "\n".join(lines)


def send(body: dict) -> dict:
    """Send all: every pinned comment as one turn, to the opener, another chat or a new one."""
    from bridge import profiles, queue_manager
    from bridge.miniapp.server import _save_images
    url = normalize(str(body.get("url") or ""))
    raw = body.get("comments")
    if not isinstance(raw, list) or not raw:
        raise Refused("Pin a comment first.")
    if len(raw) > _MAX_COMMENTS:
        raise Refused(f"Send at most {_MAX_COMMENTS} comments at once.")
    comments = []
    for c in raw:
        text = _clean(c.get("text"), 2000) if isinstance(c, dict) else ""
        if text:
            crop = str(c.get("crop") or "")
            comments.append({"text": text, "where": _clean(c.get("where"), 300),
                             "crop": crop if crop.startswith("data:image/png;base64,") else ""})
    if not comments:
        raise Refused("The comments are empty.")
    for c in [c for c in comments if c["crop"]][config.UPLOAD_MAX_COUNT:]:
        c["crop"] = ""      # a turn takes so many pictures; the rest go as words alone
    target = body.get("target") or "opener"
    o = opener(url)
    if target == "chat":
        dest = store.get_session(str(body.get("chat") or ""))
        if not dest or dest.get("chat_id") != config.DASH_CHAT_ID or dest.get("archived"):
            raise Refused("That chat isn't open any more.")
    elif target == "new":
        base = o or store.get_session(str(body.get("chat") or ""))
        if not base:
            raise Refused("No chat opened this site, so there's no project for a new one: pick a chat.")
        dest = store.create_session(config.DASH_CHAT_ID, base.get("project") or "", origin="browser",
                                    cwd=base.get("cwd"), profile_id=profiles.project_default(base.get("project") or ""))
        store.rename(dest["id"], f"Comments on {urllib.parse.urlparse(url).hostname}")
        dest = store.get_session(dest["id"])
    elif o:
        dest = o
    else:
        raise Refused("The chat that opened this site is gone: pick another.")
    job = uuid.uuid4().hex
    shots = [c["crop"].replace("data:image/png;", f"data:image/png;name=comment-{i}.png;", 1)
             for i, c in enumerate(comments, 1) if c["crop"]]
    try:
        paths = _save_images(job, shots)
    except ValueError as e:
        raise Refused(str(e)) from e
    prompt = _prompt(url, comments, _clean(body.get("viewport"), 20))
    project = dest.get("cwd") or os.path.join(config.BASE_PATH, (dest.get("project") or "").lstrip("/"))
    queue_manager.enqueue(dest["id"], text=prompt, prompt=prompt, images=paths, model=None, effort=None,
                          permission_mode=None, width=None, sel=[], surface="browser", chat_id=dest["chat_id"],
                          project=project, run_job_id=job, sent_by="browser")
    if target != "new":
        _remember(url, dest["id"])
    with _lock:
        _pins.pop(url, None)
    return {"chat": _brief(dest)}


# ------- the window ----------------------------------------------------------------------

def _no_screen() -> "str | None":
    if sys.platform == "darwin":
        return None
    if "microsoft" in platform.release().lower():
        return "WSL has no screen of its own to open a browser on yet."
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return "This machine has no desktop to open a browser on."
    return None


def _launch(args: list) -> None:
    binary = chromium()
    if not binary:
        raise Refused("No Chromium for the Mystical browser here. Install it with: npx playwright install chromium")
    p = subprocess.Popen([binary, f"--user-data-dir={_profile()}", f"--load-extension={_ext()}",
                          "--no-first-run", "--no-default-browser-check", *args],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    with _lock:
        _procs[:] = [q for q in _procs if q.poll() is None] + [p]


def open_site(sid: str, url: str) -> dict:
    """Open `url` in the Mystical browser for chat `sid`; a window already up gets a new tab."""
    url = normalize(url)
    why = _no_screen()
    if why:
        raise Refused(why)
    serve()
    _remember(url, sid)
    _launch([url])
    return {"url": url, "profile": _profile().replace(os.path.expanduser("~"), "~", 1)}


def front() -> None:
    """Bring the window forward (macOS); elsewhere a new window on the same profile.
    shortcut: `open -a` raises any running copy of that app, so a headed Playwright run on the same
    Chromium would come forward instead; find our window by its pid if that ever happens."""
    binary = chromium()
    app = binary and binary.split(".app/")[0] + ".app"
    if sys.platform == "darwin" and app and os.path.isdir(app):
        subprocess.run(["open", "-a", app], check=False, timeout=10)
    else:
        _launch([])


def close() -> bool:
    """Quit the browser this bridge started. False when there was none to quit."""
    with _lock:
        live = [p for p in _procs if p.poll() is None]
        _procs.clear()
        _pins.clear()
    for p in live:
        p.terminate()
    return bool(live)
