"""Getting an agent ready without a terminal: fetching its pinned package, and
signing an account in from Settings.

Fetch. A preset run through `npx -y <pkg>@<pin>` downloads that pin on first
use. Kimi Code is ~50 MB, which would land inside the first turn or TEST and
look like a hang. warm() runs the preset's `warm` command (its --version) once
per boot, off-thread, so a fresh install and every upgrade (a pin bump arrives
with the pull, and the update restarts the bridge) fetch it before anyone asks.
fetch_state() is what the AGENTS section shows while it runs or after it failed.

Login. A preset with a `login_cmd` signs in through its own CLI's device-code
flow (rule 2: the bridge never reads the token, the CLI writes it into the
account's home). The flow prints a URL and a code and waits; we relay those two
to the page, the user approves on any device, the CLI exits 0, and a TEST runs
so the pickers get the account's models. The CLI also tries to open a browser
on this machine; the child's PATH starts with NOOPEN, whose `xdg-open` and
`open` do nothing, because the user is usually on a phone and a window popping
up on the desk is wrong (BROWSER=true covers xdg-open's own fallbacks).

One login per (agent, account) at a time; starting one again returns the
running one. A login nobody finishes is killed after LOGIN_TIMEOUT.

Stdlib only.
"""

import collections
import os
import re
import signal
import subprocess
import threading
import time

from bridge import acp_agents

LOGIN_TIMEOUT = 15 * 60
FETCH_TIMEOUT = 15 * 60
NOOPEN = os.path.expanduser("~/.mystical/agent-noopen")

_URL = re.compile(r"https?://\S+")
_CODE = re.compile(r"enter code:\s*(\S+)", re.I)

_lock = threading.Lock()
_start_lock = threading.Lock()   # check-then-spawn: two quick LOG IN clicks start one CLI
_fetch: dict = {}      # preset id -> {"state": running|ok|error, "error"?}
_logins: dict = {}     # (agent, account) -> _Login


# --- fetch ------------------------------------------------------------------------

def fetch_state(agent_id) -> "dict | None":
    with _lock:
        st = _fetch.get(agent_id)
        return dict(st) if st else None


def _fetch_one(p: dict) -> None:
    cmd = p["warm"]
    exe = acp_agents._resolve(cmd[0])
    try:
        r = subprocess.run([exe, *cmd[1:]], env=acp_agents.env_for(p, None),
                           cwd=os.path.expanduser("~"), stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=FETCH_TIMEOUT)
        st = {"state": "ok"} if r.returncode == 0 else \
            {"state": "error", "error": _tail(r.stdout + r.stderr) or f"exit {r.returncode}"}
    except subprocess.TimeoutExpired:
        st = {"state": "error", "error": f"download took over {FETCH_TIMEOUT // 60} min"}
    except OSError as e:
        st = {"state": "error", "error": str(e)}
    with _lock:
        _fetch[p["id"]] = st
    if st["state"] == "error":
        print(f"[acp] {p['label']} fetch failed: {st['error']}")


def warm() -> None:
    """At boot: fetch every pinned preset whose launcher is here. Never blocks."""
    for p in acp_agents.PRESETS:
        if not p.get("warm") or not acp_agents._resolve(p["warm"][0]):
            continue
        with _lock:
            if (_fetch.get(p["id"]) or {}).get("state") == "running":
                continue
            _fetch[p["id"]] = {"state": "running"}
        threading.Thread(target=_fetch_one, args=(p,), daemon=True,
                         name=f"acp-fetch-{p['id']}").start()


# --- login ------------------------------------------------------------------------

def _tail(text: str, n: int = 4) -> str:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    return "\n".join(lines[-n:])[:600]


def _noopen() -> str:
    os.makedirs(NOOPEN, mode=0o700, exist_ok=True)
    for name in ("xdg-open", "open"):
        path = os.path.join(NOOPEN, name)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as f:
                f.write("#!/bin/sh\n# acp_setup: a login's browser opens on the user's phone, not here\nexit 0\n")
            os.chmod(path, 0o755)
    return NOOPEN


class _Login:
    def __init__(self, p: dict, acct: str):
        self.p, self.acct = p, acct
        self.state, self.url, self.code, self.error = "starting", None, None, None
        self.models = None
        self.cancelled = False
        self.started = time.time()
        self.lines = collections.deque(maxlen=12)
        env = acp_agents.env_for(p, acct or None)
        env["PATH"] = _noopen() + os.pathsep + env.get("PATH", "")
        env["BROWSER"] = "true"
        cmd = p["login_cmd"]
        exe = acp_agents._resolve(cmd[0]) or cmd[0]
        self.proc = subprocess.Popen([exe, *cmd[1:]], env=env, cwd=os.path.expanduser("~"),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        self.timer = threading.Timer(LOGIN_TIMEOUT, self.kill)
        self.timer.daemon = True
        self.timer.start()
        threading.Thread(target=self._read, daemon=True, name=f"acp-login-{p['id']}").start()

    def kill(self) -> None:
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    def _read(self) -> None:
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            self.lines.append(line)
            with _lock:
                if not self.url and (m := _URL.search(line)):
                    self.url = m.group(0)
                if not self.code and (m := _CODE.search(line)):
                    self.code = m.group(1)
                if self.url and self.state == "starting":
                    self.state = "waiting"
        rc = self.proc.wait()
        self.timer.cancel()
        with _lock:
            if self.cancelled:
                self.state = "cancelled"
                return
            if rc != 0:
                self.state = "error"
                timed_out = time.time() - self.started >= LOGIN_TIMEOUT
                self.error = ("Nobody approved the login in time." if timed_out
                              else _tail("\n".join(self.lines)) or f"login exited {rc}")
                return
            self.state = "testing"
        # Signed in: TEST it once, so the model and mode pickers fill for this account.
        res, _ = acp_agents.api_test({"agent": self.p["id"], "account": self.acct})
        with _lock:
            if res.get("ok"):
                self.state, self.models = "ok", len((res.get("options") or {}).get("model") or [])
            else:
                self.state, self.error = "error", f"Signed in, but the test failed: {res.get('error')}"

    def view(self) -> dict:
        out = {"state": self.state, "url": self.url, "code": self.code}
        if self.error:
            out["error"] = self.error
        if self.models is not None:
            out["models"] = self.models
        return out


def _check(agent, acct) -> "tuple[dict | None, str | None]":
    p = acp_agents.preset(agent)
    if p is None:
        return None, f"unknown agent {agent!r}"
    if not p.get("login_cmd"):
        return None, f"{p['label']} can't sign in from here. {acp_agents.login_hint(p, acct or None)}"
    if acct:
        a = acp_agents.account(acct)
        if not a or a["agent"] != p["id"]:
            return None, "no such account"
        if a["kind"] != "home":
            return None, "an API key account has nothing to sign in"
    if not acp_agents._resolve(p["login_cmd"][0]):
        return None, f"{p['label']} isn't installed here. Install: {p['install']}"
    return p, None


def start(agent: str, acct: str) -> dict:
    p, problem = _check(agent, acct)
    if problem:
        raise ValueError(problem)
    key = (agent, acct)
    with _start_lock:
        with _lock:
            cur = _logins.get(key)
            if cur and cur.state in ("starting", "waiting", "testing"):
                return cur.view()
        login = _Login(p, acct)
        with _lock:
            _logins[key] = login
            return login.view()


def status(agent: str, acct: str) -> dict:
    with _lock:
        cur = _logins.get((agent, acct))
        return cur.view() if cur else {"state": "idle"}


def cancel(agent: str, acct: str) -> dict:
    with _lock:
        cur = _logins.get((agent, acct))
        if not cur or cur.state not in ("starting", "waiting"):
            return cur.view() if cur else {"state": "idle"}
        cur.cancelled = True
    cur.kill()
    return {"state": "cancelled"}


def api_login(body: dict) -> "tuple[dict, int]":
    """POST …/acp/login: {action: start|status|cancel, agent, account}."""
    agent, acct = str(body.get("agent") or ""), str(body.get("account") or "")
    action = body.get("action")
    try:
        if action == "start":
            return start(agent, acct), 200
        if action == "status":
            return status(agent, acct), 200
        if action == "cancel":
            return cancel(agent, acct), 200
    except ValueError as e:
        return {"error": str(e)}, 400
    except OSError as e:
        return {"error": f"couldn't start the login: {e}"}, 500
    return {"error": "action must be start, status or cancel"}, 400
