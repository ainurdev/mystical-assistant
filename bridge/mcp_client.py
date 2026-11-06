"""The bridge as an MCP client: how a shared server's tools reach another agent.

An agent asks bridge/gateway.py for a tool, and the bridge makes the call itself, so
a server's key or token stays here and never enters a third-party CLI's environment
(safety rule 3 in docs/superpowers/specs/profiles-and-acp-agents.md). Tool results do
go to the agent, and so to its vendor: mcp_share decides who may have them.

Stdlib and a small subset: initialize, tools/list, tools/call, over stdio and over
streamable HTTP (a JSON or SSE answer, with Mcp-Session-Id kept). No resources or
prompts, nothing a server pushes. Connections are shared per server, started on
first use and closed when idle, because starting every server at session start is
measured seconds on each turn (runner._external_mcp's docstring).

ponytail: one call at a time per stdio server. A slow tool makes the next caller on
that server wait; a pool per server would lift it if that ever shows up.
"""

import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from itertools import count

PROTOCOL = "2025-06-18"
CALL_TIMEOUT = 50          # under Kimi Code's 60 s, so the agent hears our error, not its own
IDLE = 300


class McpError(Exception):
    pass


class NeedsLogin(McpError):
    """The server answered 401: it wants an OAuth login the bridge doesn't hold."""


class _Stdio:
    def __init__(self, d: dict):
        env = dict(os.environ)
        env.update({str(k): str(v) for k, v in (d.get("env") or {}).items()})
        self.proc = subprocess.Popen(
            [d["command"], *[str(a) for a in d.get("args") or []]], env=env, cwd=d.get("cwd") or None,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True)
        self.ids = count(1)

    def request(self, method: str, params: dict, timeout: float) -> dict:
        rid = next(self.ids)
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        out: dict = {}

        def read():
            while True:
                line = self.proc.stdout.readline()
                if not line:
                    return
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get("id") == rid and "method" not in msg:
                    out.update(msg)
                    return
        t = threading.Thread(target=read, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            self.close()
            raise McpError(f"{method}: no answer in {int(timeout)}s")
        if not out:
            raise McpError(f"{method}: the server exited")
        if out.get("error"):
            raise McpError(str(out["error"].get("message")))
        return out.get("result") or {}

    def notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _send(self, msg: dict) -> None:
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode())
            self.proc.stdin.flush()
        except (OSError, ValueError) as e:
            raise McpError(f"the server exited: {e}") from e

    def close(self) -> None:
        try:
            self.proc.kill()
            self.proc.wait(2)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def alive(self) -> bool:
        return self.proc.poll() is None


class _Http:
    def __init__(self, d: dict, token=None):
        self.url = d["url"]
        self.headers = {str(k): str(v) for k, v in (d.get("headers") or {}).items()}
        self.token = token             # () -> a bearer token or None (mcp_oauth)
        self.ids = count(1)
        self.session = None

    def request(self, method: str, params: dict, timeout: float) -> dict:
        rid = next(self.ids)
        msg = self._post({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}, timeout, rid)
        if msg.get("error"):
            raise McpError(str(msg["error"].get("message")))
        return msg.get("result") or {}

    def notify(self, method: str, params: dict) -> None:
        try:
            self._post({"jsonrpc": "2.0", "method": method, "params": params}, 15, None)
        except McpError:
            pass

    def _post(self, body: dict, timeout: float, rid) -> dict:
        headers = {"Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream", **self.headers}
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        bearer = self.token() if self.token else None
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                self.session = r.headers.get("Mcp-Session-Id") or self.session
                if rid is None:
                    return {}
                if "text/event-stream" in (r.headers.get("Content-Type") or ""):
                    return _from_sse(r, rid)
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise NeedsLogin("this server needs a login") from e
            raise McpError(f"HTTP {e.code}") from e
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise McpError(str(e)) from e

    def close(self) -> None:
        self.session = None

    def alive(self) -> bool:
        return True


def _from_sse(stream, rid) -> dict:
    for raw in stream:
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("data:"):
            try:
                msg = json.loads(line[5:].strip())
            except ValueError:
                continue
            if msg.get("id") == rid:
                return msg
    raise McpError("the stream ended with no answer")


class Client:
    """One server's connection, opened on first use."""

    def __init__(self, definition: dict, token=None):
        self.d, self.token = definition, token
        self.lock = threading.Lock()
        self.conn = None
        self.used = time.monotonic()

    def _open(self):
        if self.conn is not None and self.conn.alive():
            return self.conn
        http = self.d.get("url")
        conn = _Http(self.d, self.token) if http else _Stdio(self.d)
        try:
            conn.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                        "clientInfo": {"name": "mystical", "version": "1"}}, 30)
            conn.notify("notifications/initialized", {})
        except Exception:
            conn.close()
            raise
        self.conn = conn
        return conn

    def tools(self) -> list:
        with self.lock:
            self.used = time.monotonic()
            return self._open().request("tools/list", {}, 30).get("tools") or []

    def call(self, name: str, args: dict) -> dict:
        with self.lock:
            self.used = time.monotonic()
            return self._open().request("tools/call", {"name": name, "arguments": args}, CALL_TIMEOUT)

    def close_if_idle(self) -> None:
        with self.lock:
            if self.conn is not None and time.monotonic() - self.used > IDLE:
                self.conn.close()
                self.conn = None

    def close(self) -> None:
        with self.lock:
            if self.conn is not None:
                self.conn.close()
                self.conn = None
