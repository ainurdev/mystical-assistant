"""Multiple Claude logins as CLAUDE_CONFIG_DIR profiles.

Slot 1 is the ambient ~/.claude login and is never redirected. Slots 2+ live in
ROOT/<slot>/ as *thin overlays*: .credentials.json is a real file (that account's
tokens) and everything else is a symlink back to ~/.claude, so transcripts,
skills, plugins and settings stay shared. Sharing projects/ is what lets any
account --resume any session, and is why the bridge's six ~/.claude readers
(transcript_jsonl, machine, skills, agents, native, models) need no changes.

Every Claude turn stays a `claude` subprocess spawned by runner.py -- this is
per-profile rotation, not a token-pooling proxy.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

from bridge import usage

ROOT = os.path.expanduser(os.environ.get("ACCOUNTS_DIR", "~/.mystical/accounts"))
CLAUDE_HOME = os.path.expanduser("~/.claude")
# Identity (oauthAccount.emailAddress) lives OUTSIDE ~/.claude for the ambient
# login; CLAUDE_CONFIG_DIR relocates it *into* the profile dir for the others.
IDENTITY = os.path.expanduser("~/.claude.json")
DEFAULT_SLOT = 1

# Symlinked into every profile: state that is the *machine's*, not the account's.
# projects/ is the load-bearing one (shared transcripts → any account can
# --resume any session, and the bridge's transcript readers keep working).
# Deliberately NOT shared: .credentials.json and .claude.json, which are exactly
# what makes a slot a distinct login.
SHARED = ("projects", "skills", "plugins", "hooks", "sessions",
          "settings.json", "settings.local.json", "CLAUDE.md")
CREDENTIALS = ".credentials.json"

_lock = threading.Lock()


class NoLogin(Exception):
    """No ambient ~/.claude login to snapshot into a slot."""


class LoginFailed(Exception):
    """A browser sign-in into a slot did not produce credentials."""


def profile_dir(slot: int) -> str:
    return os.path.join(ROOT, str(slot))


def env_for(slot: "int | None") -> dict:
    """Env overrides pointing `claude` at this account's profile. The default
    slot returns {} -- it uses the ambient ~/.claude."""
    if not slot or int(slot) == DEFAULT_SLOT:
        return {}
    return {"CLAUDE_CONFIG_DIR": profile_dir(int(slot))}


def credentials_path(slot: "int | None") -> str:
    """Where this slot's OAuth tokens live."""
    home = CLAUDE_HOME if (not slot or int(slot) == DEFAULT_SLOT) \
        else profile_dir(int(slot))
    return os.path.join(home, CREDENTIALS)


def ensure_profile(slot: int) -> str:
    """Create (or repair) slot's overlay and return its profile dir. Idempotent:
    missing links are re-made, .credentials.json is never touched."""
    p = profile_dir(int(slot))
    os.makedirs(p, mode=0o700, exist_ok=True)
    for name in SHARED:
        target = os.path.join(CLAUDE_HOME, name)
        if not os.path.exists(target):
            continue                     # optional entry (e.g. settings.local.json)
        link = os.path.join(p, name)
        if os.path.islink(link):
            if os.path.realpath(link) == os.path.realpath(target):
                continue
            os.remove(link)              # repointed CLAUDE_HOME
        elif os.path.lexists(link):
            continue                     # a real file/dir here: leave it alone
        os.symlink(target, link)
    return p


# --- registry (ROOT/accounts.json) ------------------------------------------
# Slot 1 is implicit: it *is* ~/.claude, so it needs no entry and is listed
# whenever an ambient login exists. Only added slots are persisted.

def _registry_path() -> str:
    return os.path.join(ROOT, "accounts.json")


def _load() -> dict:
    try:
        with open(_registry_path()) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save(reg: dict) -> None:
    os.makedirs(ROOT, mode=0o700, exist_ok=True)
    try:
        with open(_registry_path(), "w") as f:
            json.dump(reg, f, indent=2)
    except OSError as e:
        print(f"[accounts] persist failed: {e}", file=sys.stderr)


def _email_at(path: str) -> "str | None":
    try:
        with open(path) as f:
            return (json.load(f).get("oauthAccount") or {}).get("emailAddress")
    except (OSError, ValueError):
        return None


def list_accounts() -> list:
    """Every known slot, lowest first. Slot 1 is the ambient login."""
    with _lock:
        reg = _load()
    out = []
    if os.path.exists(credentials_path(DEFAULT_SLOT)):
        out.append({"slot": DEFAULT_SLOT, "email": _email_at(IDENTITY),
                    "alias": None, "disabled": False, "default": True})
    for key, e in reg.items():
        if not str(key).isdigit() or int(key) == DEFAULT_SLOT:
            continue
        slot = int(key)
        # A profile's own .claude.json self-corrects after a re-login; the
        # registry's email is the fallback for a slot never used yet.
        live = _email_at(os.path.join(profile_dir(slot), ".claude.json"))
        out.append({"slot": slot, "email": live or e.get("email"),
                    "alias": e.get("alias"), "disabled": bool(e.get("disabled")),
                    "default": False})
    return sorted(out, key=lambda a: a["slot"])


def add(slot: "int | None" = None, alias: "str | None" = None) -> int:
    """Snapshot the current ~/.claude login into a slot and build its overlay.
    The user logs in with `claude /login` first; we only copy what's on disk."""
    src = credentials_path(DEFAULT_SLOT)
    if not os.path.exists(src):
        raise NoLogin(f"no login at {src} — run `claude /login` first")
    email = _email_at(IDENTITY)
    with _lock:
        reg = _load()
        if slot is None:
            slot = next(n for n in range(DEFAULT_SLOT + 1, 100)
                        if str(n) not in reg)
        slot = int(slot)
        if slot == DEFAULT_SLOT:
            raise ValueError("slot 1 is the ambient ~/.claude login")
        ensure_profile(slot)
        dst = credentials_path(slot)
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o600)
        reg[str(slot)] = {"email": email, "alias": alias, "disabled": False}
        _save(reg)
    return slot


# --- browser sign-in: add a *different* account without a terminal -----------
# add() can only copy the login that is already in ~/.claude, so a second
# account meant logging out, logging in as the other one, pressing ADD, then
# logging back. `claude auth login` reads CLAUDE_CONFIG_DIR like everything else
# does: aimed at an empty slot it prints an OAuth URL on stdout and waits for
# the code on stdin, and the credentials it writes land in the slot. The ambient
# login is never touched, so the two halves of this (begin_login → the user
# signs in in a browser → submit_login_code) are a complete add-an-account flow.

_LOGIN_ARGS = ("auth", "login", "--claudeai")
_OSC8 = re.compile(rb"\x1b]8;;(https://[^\x1b\x07]+)")   # terminal hyperlink target
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x1b][^\x1b\x07]*(?:\x1b\\|\x07)?")
_PROMPT = re.compile(r".*Paste code here[^>]*>\s*")      # the one prompt this flow hits
_pending: dict = {}                                      # slot -> _Login


class _Login:
    """One in-flight `claude auth login`, with its output drained off-thread so
    the half-line 'Paste code here >' prompt can't deadlock the pipe."""

    def __init__(self, slot: int, proc, alias: "str | None"):
        self.slot, self.proc, self.alias = slot, proc, alias
        self.buf = bytearray()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        fd = self.proc.stdout.fileno()
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            self.buf += chunk

    def url(self) -> "str | None":
        """The sign-in link, once the CLI has printed it."""
        m = _OSC8.search(bytes(self.buf))
        if m:
            return m.group(1).decode()
        # No hyperlink escapes: the CLI prints the URL as its own link text, so
        # the plain form arrives doubled and has to be cut back to one.
        text = _ANSI.sub("", bytes(self.buf).decode("utf-8", "replace"))
        m2 = re.search(r"https://\S+", text)
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

    def tail(self) -> str:
        """Last thing the CLI said, for an error message. Its code prompt ends
        without a newline, so a failure arrives glued to it: drop the prompt and
        keep the part worth showing."""
        text = _ANSI.sub("", bytes(self.buf).decode("utf-8", "replace"))
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        return _PROMPT.sub("", lines[-1]).strip() if lines else ""

    def close(self) -> None:
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                stream.close()
            except OSError:
                pass
        if self.proc.poll() is None:
            self.proc.kill()


def _free_slot(reg: dict) -> int:
    return next(n for n in range(DEFAULT_SLOT + 1, 100)
                if str(n) not in reg and n not in _pending)


def begin_login(alias: "str | None" = None, timeout: float = 30) -> dict:
    """Start a sign-in in the next free slot; returns {slot, url} for the user
    to open. Only one sign-in is ever in flight, so an abandoned one can't pile
    up child processes."""
    from bridge import runner                   # lazy: runner imports the world
    for slot in list(_pending):
        cancel_login(slot)
    with _lock:
        slot = _free_slot(_load())
    # An unregistered slot dir is spoil from an earlier attempt: wipe it, or a
    # stale .credentials.json would read as this sign-in succeeding.
    shutil.rmtree(profile_dir(slot), ignore_errors=True)
    ensure_profile(slot)
    proc = subprocess.Popen(
        [runner.claude_bin(), *_LOGIN_ARGS],
        env={**os.environ, "CLAUDE_CONFIG_DIR": profile_dir(slot),
             "BROWSER": "true"},                # the browser is the user's, not ours
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, bufsize=0)
    login = _Login(slot, proc, alias)
    _pending[slot] = login
    url = login.wait_url(timeout)
    if not url:
        detail = login.tail()
        cancel_login(slot)
        raise LoginFailed(detail or "`claude auth login` printed no sign-in link")
    return {"slot": slot, "url": url}


def submit_login_code(slot: int, code: str, timeout: float = 90) -> dict:
    """Hand the pasted code to the waiting sign-in and register the slot once
    its credentials land."""
    slot = int(slot)
    login = _pending.get(slot)
    if login is None:
        raise LoginFailed("that sign-in is no longer running — start it again")
    code = (code or "").strip()
    if not code:
        raise ValueError("paste the code from the sign-in page")
    try:
        login.proc.stdin.write(code.encode() + b"\n")
        login.proc.stdin.flush()
    except OSError:
        cancel_login(slot)
        raise LoginFailed("the sign-in exited before the code arrived")
    dst = credentials_path(slot)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            break
        if login.proc.poll() is not None:
            detail = login.tail()
            cancel_login(slot)
            raise LoginFailed(detail or "sign-in failed — check the code and retry")
        time.sleep(0.25)
    else:
        cancel_login(slot)
        raise LoginFailed("sign-in timed out — the code may have expired")
    _pending.pop(slot, None)
    login.close()
    email = _email_at(os.path.join(profile_dir(slot), ".claude.json"))
    with _lock:
        reg = _load()
        reg[str(slot)] = {"email": email, "alias": login.alias, "disabled": False}
        _save(reg)
    return {"slot": slot, "email": email}


def cancel_login(slot: int) -> None:
    """Abandon a sign-in and leave no half-made profile behind."""
    slot = int(slot)
    login = _pending.pop(slot, None)
    if login:
        login.close()
    with _lock:
        registered = str(slot) in _load()
    if not registered:
        shutil.rmtree(profile_dir(slot), ignore_errors=True)


def pending_login() -> "dict | None":
    """The sign-in waiting for a code, if any — so a reloaded dashboard can pick
    the flow back up instead of stranding the process."""
    for slot, login in _pending.items():
        return {"slot": slot, "url": login.url()}
    return None


def remove(slot: int) -> None:
    slot = int(slot)
    if slot == DEFAULT_SLOT:
        raise ValueError("slot 1 is the ambient ~/.claude login")
    cancel_login(slot)
    with _lock:
        reg = _load()
        reg.pop(str(slot), None)
        _save(reg)
    shutil.rmtree(profile_dir(slot), ignore_errors=True)


def _set_disabled(slot: int, value: bool) -> None:
    slot = int(slot)
    if slot == DEFAULT_SLOT:
        raise ValueError("slot 1 is the ambient ~/.claude login")
    with _lock:
        reg = _load()
        if str(slot) not in reg:
            raise ValueError(f"no account in slot {slot}")
        reg[str(slot)]["disabled"] = value
        _save(reg)


def disable(slot: int) -> None:
    """Hold a slot out of automatic rotation without forgetting its login."""
    _set_disabled(slot, True)


def enable(slot: int) -> None:
    _set_disabled(slot, False)


# --- pick(): which account takes the work ------------------------------------
# EXHAUSTED matches limits._reset_epoch's threshold: at >=99% the window is over
# and resuming there can only fail again.

EXHAUSTED = 99


def _used(meter: dict) -> "int | None":
    """Percent consumed of whichever window is closer to its limit. None when
    there is no readable meter -- no evidence of headroom is not headroom."""
    if not meter or not meter.get("available"):
        return None
    pcts = [b["percent"] for b in (meter.get("five_hour"), meter.get("seven_day"))
            if isinstance(b, dict) and b.get("percent") is not None]
    return max(pcts) if pcts else None


def _weekly_reset(meter: dict) -> float:
    """Epoch of this account's weekly reset; +inf when unknown, so an account
    with no weekly window never wins consume-first."""
    b = (meter or {}).get("seven_day") or {}
    return usage.resets_epoch(b.get("resets_at")) or float("inf")


def usage_for(slot: int) -> dict:
    return usage.get_usage(credentials_path(slot))


def headroom(slot: int) -> "int | None":
    """Percent of this account's tighter window still unspent; None when the
    meter is unreadable."""
    used = _used(usage_for(slot))
    return None if used is None else max(0, 100 - used)


def pick(exclude=(), strategy: str = "best") -> "int | None":
    """The slot that should take over, or None when nothing has headroom.

    best          -- most quota left (default)
    consume-first -- among accounts with room, the one whose weekly window
                     resets soonest, so perishable quota is spent first
    """
    skip = {int(s) for s in exclude}
    viable = []
    for a in list_accounts():
        if a["slot"] in skip or a["disabled"]:
            continue
        meter = usage_for(a["slot"])
        used = _used(meter)
        if used is None or used >= EXHAUSTED:
            continue
        viable.append((a["slot"], used, _weekly_reset(meter)))
    if not viable:
        return None
    if strategy == "consume-first":
        return min(viable, key=lambda v: (v[2], v[1], v[0]))[0]
    return min(viable, key=lambda v: (v[1], v[0]))[0]
