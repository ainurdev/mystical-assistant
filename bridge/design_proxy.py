"""Showing a running app or a public page in the design view, with the tools working on it.

The tools have to run inside the page, and a browser won't let the dashboard reach into another
site's frame. So the page comes through here: one small local server per site, which fetches from
the real address, adds the tools to its HTML and passes everything else along. Each proxy is its own
port, so its own origin. That's what lets the frame keep same-origin, which real apps need for
scripts, storage and hot reload, while staying out of the dashboard's reach. The tools then talk to
the dashboard by postMessage alone, as in a board's drafts, and what they say is treated as data.

It reaches two kinds of place: this machine, and public addresses. Your private network and cloud
metadata addresses are refused, and checked at every request, so a public name can't later turn into a
private one. A request has to arrive with the proxy's own Host, which is what stops a hostile page
using DNS rebinding to read a dev server through it. Headers that forbid framing (CSP, X-Frame-Options)
are removed, because being framed is the point. The dashboard's own cookie is never passed along.

ponytail: this serves one origin per proxy. Assets on a CDN load straight from there, which is fine,
but an app that signs in on another domain leaves the proxy at that point, and the tools with it.
Public sites often block or break like this. It's a viewer for pointing at things, not a browser.
It listens on loopback, so the phone can't open these. Stdlib only.
"""

import http.client
import ipaddress
import re
import select
import socket
import ssl
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IDLE_S = 3600
_DROP_REQUEST = {"host", "connection", "keep-alive", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "accept-encoding", "content-length"}
_DROP_RESPONSE = {"connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "content-security-policy",
                  "content-security-policy-report-only", "x-frame-options", "strict-transport-security", "cross-origin-opener-policy",
                  "cross-origin-embedder-policy", "cross-origin-resource-policy"}
_TEXT = re.compile(r"text/(html|css|javascript)|application/(javascript|json)|\+json", re.I)
_lock = threading.Lock()
_proxies: dict = {}


class Refused(ValueError):
    """A sentence for whoever asked: what to change."""


def normalize(url: str) -> str:
    """An address as typed: localhost:5173 is http, example.com is https."""
    v = str(url or "").strip()
    if not v:
        raise Refused("Give an address.")
    if not re.match(r"^[a-z][a-z0-9+.-]*://", v, re.I):
        host = v.split("/")[0].split(":")[0].lower()
        local = host in ("localhost", "0.0.0.0") or host.endswith(".localhost") or re.fullmatch(r"127(\.\d+){3}", host)
        v = f"{'http' if local else 'https'}://{v}"
    p = urllib.parse.urlparse(v)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise Refused("That isn't a web address.")
    return v


def reachable(host: str) -> bool:
    """This machine or the public internet, and nothing in between."""
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for i in infos:
        ip = ipaddress.ip_address(i[4][0].split("%")[0])
        if ip.is_unspecified:
            continue
        if not (ip.is_loopback or ip.is_global):
            return False
    return bool(infos)


def check(url: str) -> str:
    """The address, normalized, or Refused when it isn't somewhere this may go."""
    v = normalize(url)
    host = urllib.parse.urlparse(v).hostname
    if not reachable(host):
        raise Refused(f"{host} isn't this machine or a public address, or it doesn't exist.")
    return v


def answering(url: str, timeout: float = 3) -> bool:
    """Is something there? For telling an agent its dev server isn't up yet."""
    p = urllib.parse.urlparse(url)
    port = p.port or (443 if p.scheme == "https" else 80)
    try:
        with socket.create_connection((p.hostname, port), timeout=timeout):
            return True
    except OSError:
        return False


def _inject(html: str, script: str) -> str:
    tag = f"<script>window.__mysticalProxied=1;</script><script>{script}</script>"
    m = re.search(r"<head[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + tag + html[m.end():]
    m = re.search(r"<html[^>]*>", html, re.I)
    return html[:m.end()] + tag + html[m.end():] if m else tag + html


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _proxy(self):
        return self.server.proxy      # type: ignore[attr-defined]

    def _open(self):
        px = self._proxy()
        cls = http.client.HTTPSConnection if px["scheme"] == "https" else http.client.HTTPConnection
        return cls(px["host"], px["port"], timeout=60)

    def _fail(self, code: int, words: str) -> None:
        body = (f"<!doctype html><meta charset=utf-8><body style='font:15px system-ui;padding:32px;color:#444;background:#fff'><p>{words}</p>").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _handle(self):
        px = self._proxy()
        px["used"] = time.time()
        if self.headers.get("Host") != px["self_host"]:
            return self._fail(403, "This address only answers to itself.")
        if not reachable(px["host"]):
            return self._fail(403, f"{px['host']} isn't somewhere this can go.")
        if (self.headers.get("Upgrade") or "").lower() == "websocket":
            return self._tunnel()
        headers = {}
        for k, v in self.headers.items():
            low = k.lower()
            if low in _DROP_REQUEST:
                continue
            if low == "cookie":
                v = "; ".join(c for c in v.split(";") if not c.strip().lower().startswith(("hud-", "dash", "mystical")))
                if not v:
                    continue
            if low in ("origin", "referer"):
                v = v.replace(px["self"], px["origin"])
            headers[k] = v
        headers["Host"] = px["netloc"]
        headers["Accept-Encoding"] = "identity"
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        try:
            conn = self._open()
            conn.request(self.command, self.path, body=body, headers=headers)
            res = conn.getresponse()
        except (OSError, http.client.HTTPException) as e:
            return self._fail(502, f"Nothing's answering at {px['origin']}. If it's your dev server, it may not be running. ({e})")
        kind = res.getheader("Content-Type") or ""
        self.send_response(res.status, res.reason)
        out = []
        for k, v in res.getheaders():
            low = k.lower()
            if low in _DROP_RESPONSE:
                continue
            if low == "location":
                v = v.replace(px["origin"], px["self"])
            if low == "set-cookie":
                v = re.sub(r";\s*(domain=[^;]*|secure|samesite=[^;]*)", "", v, flags=re.I)
            out.append((k, v))
        for k, v in out:
            self.send_header(k, v)
        if self.command != "HEAD" and _TEXT.search(kind):
            data = res.read()
            text = data.decode("utf-8", errors="surrogateescape").replace(px["origin"], px["self"])
            if "html" in kind.lower():
                text = _inject(text, px["script"])
            data = text.encode("utf-8", errors="surrogateescape")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            # Streams as it comes: an event stream never ends, and a video needn't be held in memory.
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                while self.command != "HEAD":
                    chunk = res.read1(65536) if hasattr(res, "read1") else res.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except OSError:
                pass
        conn.close()

    def _tunnel(self):
        """Hot reload is a websocket: pass the bytes both ways."""
        px = self._proxy()
        try:
            up = socket.create_connection((px["host"], px["port"]), timeout=10)
            if px["scheme"] == "https":
                up = ssl.create_default_context().wrap_socket(up, server_hostname=px["host"])
        except OSError:
            return self._fail(502, "Nothing's answering.")
        lines = [f"{self.command} {self.path} HTTP/1.1", f"Host: {px['netloc']}"]
        for k, v in self.headers.items():
            if k.lower() == "host":
                continue
            lines.append(f"{k}: {v.replace(px['self'], px['origin']) if k.lower() == 'origin' else v}")
        up.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1", "replace"))
        client = self.connection
        self.close_connection = True
        pair = {client: up, up: client}
        try:
            while True:
                ready, _, _ = select.select(list(pair), [], [], 300)
                if not ready:
                    break
                for s in ready:
                    data = s.recv(65536)
                    if not data:
                        return
                    pair[s].sendall(data)
        except OSError:
            pass
        finally:
            up.close()

    def do_GET(self):
        self._handle()

    do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = do_GET


def _sweep(now: float) -> None:
    for key, px in list(_proxies.items()):
        if now - px["used"] > IDLE_S:
            px["server"].shutdown()
            px["server"].server_close()
            del _proxies[key]


def open_proxy(url: str, script: str) -> str:
    """The local address that shows this page, tools included."""
    v = check(url)
    p = urllib.parse.urlparse(v)
    origin = f"{p.scheme}://{p.netloc}"
    path = urllib.parse.urlunparse(("", "", p.path or "/", p.params, p.query, ""))
    with _lock:
        now = time.time()
        _sweep(now)
        px = _proxies.get(origin)
        if not px:
            server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
            server.daemon_threads = True
            port = server.server_address[1]
            px = {"server": server, "origin": origin, "netloc": p.netloc, "host": p.hostname, "scheme": p.scheme,
                  "port": p.port or (443 if p.scheme == "https" else 80), "self": f"http://127.0.0.1:{port}", "self_host": f"127.0.0.1:{port}", "used": now, "script": script}
            server.proxy = px      # type: ignore[attr-defined]
            threading.Thread(target=server.serve_forever, daemon=True, name=f"design-proxy-{port}").start()
            _proxies[origin] = px
        px["script"], px["used"] = script, now
    return px["self"] + path


def to_real(src_path: str, url: str) -> str:
    """What the address bar shows for where the frame has got to."""
    p = urllib.parse.urlparse(normalize(url))
    return f"{p.scheme}://{p.netloc}{src_path}"
