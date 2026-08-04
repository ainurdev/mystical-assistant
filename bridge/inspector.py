"""A see-through proxy in front of the Anthropic API, for the runs the bridge
starts.

`claude` honours ANTHROPIC_BASE_URL, so pointing a run at a local port puts every
request it makes — including the streamed SSE — where we can read it. Nothing is
rewritten: bytes go up and come back verbatim, header for header, so a run
through the inspector behaves exactly like one without it.

Off by default. It is on the critical path of every turn it watches, and a turn
that dies because its inspector died is a bad trade for a log nobody asked for.

Credentials are never recorded: the authorization / x-api-key / cookie headers
are dropped before an entry is stored, not masked at render time.
"""

import http.server
import json
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
import zlib
from collections import deque

UPSTREAM = "https://api.anthropic.com"

# Kept small on purpose: a long turn is thousands of SSE frames, and this is a
# debugging window, not an archive.
MAX_ENTRIES = 200
BODY_PREVIEW = 4000

_SECRET = {"authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"}
# Hop-by-hop headers belong to this connection, not the one we open upstream.
_HOP = {"host", "connection", "keep-alive", "transfer-encoding", "upgrade",
        "proxy-connection", "te", "trailer", "content-length"}

_entries: "deque[dict]" = deque(maxlen=MAX_ENTRIES)
_lock = threading.Lock()
_server: "http.server.ThreadingHTTPServer | None" = None
_seq = 0


def entries() -> list[dict]:
    with _lock:
        return list(_entries)


def clear() -> None:
    with _lock:
        _entries.clear()


def running() -> bool:
    return _server is not None


def base_url() -> "str | None":
    """What to hand a child as ANTHROPIC_BASE_URL, or None when off."""
    s = _server
    return f"http://127.0.0.1:{s.server_address[1]}" if s else None


def _safe_headers(items) -> dict:
    return {k: v for k, v in items if k.lower() not in _SECRET}


def _summarize_request(body: bytes) -> dict:
    """The few fields that say what a call actually asked for. A request body is
    the whole conversation — storing it would mean storing the transcript twice."""
    try:
        d = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return {}
    msgs = d.get("messages") or []
    sysblocks = d.get("system")
    if isinstance(sysblocks, list):
        syslen = sum(len(b.get("text", "")) for b in sysblocks if isinstance(b, dict))
    else:
        syslen = len(sysblocks or "")
    return {"model": d.get("model"), "max_tokens": d.get("max_tokens"),
            "stream": bool(d.get("stream")), "messages": len(msgs),
            "tools": len(d.get("tools") or []), "system_chars": syslen,
            "thinking": bool(d.get("thinking"))}


def _decode(raw: bytes, encoding: str) -> bytes:
    """The API gzips its SSE stream. The child gets the compressed bytes it was
    sent — only our own copy is inflated, so nothing about the exchange changes.
    A copy cut short by the capture cap still inflates as far as it goes."""
    enc = (encoding or "").lower()
    if "gzip" not in enc and "deflate" not in enc:
        return raw
    wbits = 16 + zlib.MAX_WBITS if "gzip" in enc else zlib.MAX_WBITS
    try:
        return zlib.decompressobj(wbits).decompress(raw)
    except zlib.error:
        return b""


def _summarize_sse(chunks: list[bytes]) -> dict:
    """Event-type counts and the usage/stop_reason the stream reported. The text
    itself is already in the transcript."""
    events: dict[str, int] = {}
    usage = None
    stop = None
    for line in b"".join(chunks).split(b"\n"):
        if line.startswith(b"event: "):
            name = line[7:].decode("utf-8", "replace").strip()
            events[name] = events.get(name, 0) + 1
        elif line.startswith(b"data: "):
            try:
                d = json.loads(line[6:])
            except ValueError:
                continue
            if not isinstance(d, dict):
                continue
            u = d.get("usage") or (d.get("message") or {}).get("usage")
            if isinstance(u, dict):
                usage = {**(usage or {}), **u}
            sr = d.get("delta", {}).get("stop_reason") if isinstance(d.get("delta"), dict) else None
            stop = sr or d.get("stop_reason") or stop
    return {"events": events, "usage": usage, "stop_reason": stop}


def _record(entry: dict) -> None:
    global _seq
    with _lock:
        _seq += 1
        entry["seq"] = _seq
        _entries.append(entry)


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mystical-inspector"

    def log_message(self, *_args):
        pass                                    # the entries list is the log

    def _proxy(self):
        started = time.time()
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        headers = {k: v for k, v in self.headers.items() if k.lower() not in _HOP}
        req = urllib.request.Request(UPSTREAM + self.path, data=body or None,
                                     headers=headers, method=self.command)
        entry = {"ts": started, "method": self.command, "path": self.path,
                 "request": _summarize_request(body),
                 "request_headers": _safe_headers(self.headers.items()),
                 "request_bytes": len(body)}
        try:
            # No default timeout: a long thinking turn legitimately holds the
            # connection open for minutes before the first byte.
            resp = urllib.request.urlopen(req, context=ssl.create_default_context())
        except urllib.error.HTTPError as e:
            err = e.read()
            entry.update(status=e.code, ms=int((time.time() - started) * 1000),
                         error=_decode(err, e.headers.get("Content-Encoding", ""))
                         [:BODY_PREVIEW].decode("utf-8", "replace"),
                         response_bytes=len(err))
            _record(entry)
            self._send(e.code, _safe_headers(e.headers.items()), err)
            return
        except OSError as e:
            entry.update(status=0, ms=int((time.time() - started) * 1000),
                         error=f"{type(e).__name__}: {e}", response_bytes=0)
            _record(entry)
            self.send_error(502, "upstream unreachable")
            return

        out_headers = [(k, v) for k, v in resp.headers.items()
                       if k.lower() not in _HOP]
        self.send_response(resp.status)
        for k, v in out_headers:
            self.send_header(k, v)
        # The upstream length is unknown while streaming, so the response is
        # chunked back to the child rather than buffered to get one.
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        chunks: list[bytes] = []
        total = 0
        first_byte = None
        try:
            while True:
                buf = resp.read(8192)
                if not buf:
                    break
                if first_byte is None:
                    first_byte = int((time.time() - started) * 1000)
                total += len(buf)
                if sum(len(c) for c in chunks) < 512_000:
                    chunks.append(buf)
                self.wfile.write(b"%X\r\n%s\r\n" % (len(buf), buf))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            entry["aborted"] = True
        finally:
            resp.close()

        entry.update(status=resp.status, ms=int((time.time() - started) * 1000),
                     ttfb_ms=first_byte, response_bytes=total,
                     response_headers=_safe_headers(resp.headers.items()))
        raw = _decode(b"".join(chunks), resp.headers.get("Content-Encoding", ""))
        if "event-stream" in resp.headers.get("Content-Type", ""):
            entry["sse"] = _summarize_sse([raw])
        else:
            entry["body"] = raw[:BODY_PREVIEW].decode("utf-8", "replace")
        _record(entry)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _proxy

    def do_HEAD(self):
        self._proxy()

    def _send(self, status: int, headers: dict, body: bytes):
        self.send_response(status)
        for k, v in headers.items():
            if k.lower() not in _HOP:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start() -> str:
    """Bring the proxy up on a free loopback port; returns its base URL."""
    global _server
    if _server is None:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        _server = srv
    return base_url()


def stop() -> None:
    global _server
    srv, _server = _server, None
    if srv is not None:
        srv.shutdown()
        srv.server_close()


def _free_port() -> int:                        # used by tests
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
