"""Managing this machine's MCP servers: add, remove, re-authenticate.

`claude` owns MCP state -- the server definitions in ~/.claude.json and
.mcp.json, the OAuth tokens in .credentials.json -- so every mutation here
shells out to its own `claude mcp` CLI rather than editing those files, the way
bridge/plugins.py does for plugins. An add from the dashboard is byte-identical
to one typed in a terminal, and there is no second source of truth to drift.

Reading the list is toolsets.servers(): it already runs `claude mcp list` behind
a stale-while-revalidate cache, and a session's per-tool switches key off the
same rows. A mutation invalidates that cache rather than keeping a second one.

Re-authenticating is the one thing that can't be a plain subprocess.
`claude mcp login --no-browser` prints an authorization URL and then waits for
the redirect URL on stdin -- and refuses outright when stdin is a pipe ("stdin
isn't a terminal, so authentication can't be completed here"), so it runs under
a pty. It also starts its own localhost callback listener, so opening the URL in
a browser on this machine usually completes the flow with nothing pasted back;
the paste box is the fallback for when the browser can't reach that port.

One login is in flight at a time, mirroring accounts.py: an abandoned one can't
pile up, and the panel only ever has one thing to show.

Same trust boundary as the rest of the dashboard -- a caller who can drive
Claude here can already run shell commands, so a stdio server that runs an
arbitrary command adds no capability. Nothing is shell-interpolated regardless:
every call is an argv list.
"""

import os
import pty
import re
import shlex
import subprocess
import threading
import time

from bridge import toolsets
from bridge.runner import claude_bin

# An add can clone/download nothing, but a health check on the way out can take
# seconds; a login is bounded by the human at the browser, not by this.
_TIMEOUT = 60
SCOPES = ("user", "local", "project")
TRANSPORTS = ("http", "sse", "stdio")

# The CLI writes its authorization link as an OSC-8 terminal hyperlink, whose
# plain-text half then arrives doubled. accounts.py has the twin of this for
# `claude auth login` -- deliberately not shared, so neither auth flow can break
# the other by tightening a regex.
_OSC8 = re.compile(rb"\x1b]8;;(https://[^\x1b\x07]+)")
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x1b][^\x1b\x07]*(?:\x1b\\|\x07)?")
_PROMPT = re.compile(r".*paste the redirect URL here:\s*")
_FAILED = "Couldn't complete authentication"

_login: "_Login | None" = None
_lock = threading.Lock()


def _run(*args: str) -> "tuple[int, str, str]":
    try:
        p = subprocess.run([claude_bin(), "mcp", *args],
                           capture_output=True, text=True, timeout=_TIMEOUT)
    except FileNotFoundError:
        return 127, "", "claude not found on PATH"
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as e:
        return 1, "", str(e)
    return p.returncode, p.stdout, p.stderr


def _act(*args: str) -> "tuple[bool, str]":
    """Run a mutation; the CLI's own last line is the error, verbatim."""
    rc, out, err = _run(*args)
    if rc == 0:
        toolsets.invalidate()
        return True, ""
    text = (err.strip() or out.strip() or f"exit {rc}")
    return False, text.splitlines()[-1][:300]


def _name(value: str) -> "str | None":
    """A server name that reaches argv. Nothing is shell-interpolated, so the
    only real hazard is a leading dash being read as a flag."""
    v = (value or "").strip()
    if not v or v.startswith("-") or len(v) > 200 or any(c.isspace() for c in v):
        return None
    return v


def servers(refresh: bool = False) -> list:
    return toolsets.servers(refresh=refresh)


def add(name: str, target: str, transport: str = "http",
        scope: str = "user") -> "tuple[bool, str]":
    """Add a server. `target` is a URL for http/sse, a command line for stdio."""
    n = _name(name)
    if not n:
        return False, "invalid name"
    if transport not in TRANSPORTS:
        return False, "invalid transport"
    if scope not in SCOPES:
        return False, "invalid scope"
    target = (target or "").strip()
    if not target or len(target) > 2000:
        return False, "invalid url or command"
    if transport == "stdio":
        try:
            argv = shlex.split(target)
        except ValueError as e:                      # unbalanced quotes
            return False, str(e)
        if not argv:
            return False, "invalid command"
        # ponytail: no -e/--header fields. `claude mcp add-json` is the escape
        # hatch for a server that needs env or auth headers; wire it up if one
        # ever does.
        return _act("add", "--scope", scope, n, "--", *argv)
    if not target.startswith(("http://", "https://")):
        return False, "url must start with http:// or https://"
    return _act("add", "--transport", transport, "--scope", scope, n, target)


def remove(name: str) -> "tuple[bool, str]":
    """Remove a server from whichever scope defines it. A plugin-bundled server
    isn't removable this way -- it comes with its plugin -- and the CLI says so."""
    n = _name(name)
    return _act("remove", n) if n else (False, "invalid name")


def logout(name: str) -> "tuple[bool, str]":
    """Drop stored OAuth credentials, so the next login starts clean."""
    n = _name(name)
    return _act("logout", n) if n else (False, "invalid name")


class _Login:
    """One in-flight `claude mcp login`, under a pty because the CLI refuses to
    authenticate when stdin is a pipe. Output is drained off-thread so the
    half-line 'paste the redirect URL here:' prompt can't fill the buffer and
    deadlock the child."""

    def __init__(self, name: str):
        self.name = name
        self.buf = bytearray()
        master, slave = pty.openpty()
        self.master = master
        try:
            self.proc = subprocess.Popen(
                [claude_bin(), "mcp", "login", name, "--no-browser"],
                stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        finally:
            os.close(slave)
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        while True:
            try:
                chunk = os.read(self.master, 4096)
            except OSError:                          # child closed the pty
                break
            if not chunk:
                break
            self.buf += chunk

    def url(self) -> "str | None":
        m = _OSC8.search(bytes(self.buf))
        if m:
            return m.group(1).decode()
        # No hyperlink escapes: the CLI prints the URL as its own link text, so
        # the plain form arrives doubled and has to be cut back to one.
        m2 = re.search(r"https://\S+", self.text())
        if not m2:
            return None
        url = m2.group(0)
        half = url.find("https://", len("https://"))
        return url[:half] if half > 0 else url

    def wait_url(self, timeout: float) -> "str | None":
        deadline = time.time() + timeout
        while time.time() < deadline:
            url = self.url()
            if url:
                return url
            if self.proc.poll() is not None:
                return self.url()
            time.sleep(0.1)
        return self.url()

    def text(self) -> str:
        return _ANSI.sub("", bytes(self.buf).decode("utf-8", "replace"))

    def tail(self) -> str:
        """Last thing the CLI said, for an error message. Its paste prompt ends
        without a newline, so a failure arrives glued to it."""
        lines = [ln.strip() for ln in self.text().splitlines() if ln.strip()]
        return _PROMPT.sub("", lines[-1]).strip() if lines else ""

    def done(self) -> bool:
        return self.proc.poll() is not None

    def ok(self) -> bool:
        """Exit code alone isn't enough -- the CLI prints "Couldn't complete
        authentication for …" and still leaves rc 0 on some paths."""
        return self.proc.returncode == 0 and _FAILED not in self.text()

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            os.close(self.master)
        except OSError:
            pass


def begin_login(name: str, timeout: float = 30) -> dict:
    """Start authentication and return {name, url} for the user to open. Any
    previous login is abandoned first: only one is ever in flight."""
    global _login
    n = _name(name)
    if not n:
        return {"error": "invalid name"}
    if not any(s["name"] == n for s in toolsets.servers()):
        return {"error": "no such server"}
    with _lock:
        if _login:
            _login.close()
        try:
            _login = _Login(n)
        except OSError as e:
            _login = None
            return {"error": str(e)}
        login = _login
    url = login.wait_url(timeout)
    if not url:
        with _lock:
            login.close()
            if _login is login:
                _login = None
        return {"error": login.tail() or "no authorization URL"}
    return {"name": n, "url": url}


def submit_login(redirect_url: str, timeout: float = 60) -> "tuple[bool, str]":
    """Hand the pasted redirect URL to the waiting CLI and wait for its verdict."""
    global _login
    with _lock:
        login = _login
    if not login:
        return False, "no sign-in in progress"
    text = (redirect_url or "").strip()
    if not text.startswith(("http://", "https://")) or len(text) > 4000:
        return False, "paste the full redirect URL, including ?code=…"
    try:
        os.write(login.master, text.encode() + b"\r")
    except OSError as e:
        return False, str(e)
    deadline = time.time() + timeout
    while time.time() < deadline and not login.done():
        time.sleep(0.2)
    if not login.done():
        return False, "timed out waiting for the server"
    ok = login.ok()
    err = "" if ok else (login.tail() or "authentication failed")
    _finish(login)
    return ok, err


def cancel_login() -> None:
    with _lock:
        login = _login
    if login:
        _finish(login)


def pending() -> "dict | None":
    """The in-flight login, if one is still waiting on the browser. A finished
    one is cleared here, so a login the browser completed on its own (via the
    CLI's localhost callback) stops showing as pending without a submit."""
    global _login
    with _lock:
        login = _login
    if not login:
        return None
    if login.done():
        _finish(login)
        return None
    return {"name": login.name, "url": login.url()}


def _finish(login: "_Login") -> None:
    global _login
    login.close()
    with _lock:
        if _login is login:
            _login = None
    toolsets.invalidate()
