"""Where a Claude login's tokens live, read the way the CLI reads them.

Linux and Windows keep them in <config dir>/.credentials.json. macOS keeps them
in the login Keychain and writes that file only when the Keychain refuses (a
locked keychain over SSH), so a bridge that read just the file saw no login on
a Mac: no slot 1 in the Accounts list, COPY CURRENT LOGIN refusing with "no
login", and ADD ANOTHER ACCOUNT timing out while it waited for a file the CLI
never writes. Every reader of a credentials path goes through here instead.

The Keychain item is a generic password: account = the user name, service =
"Claude Code-credentials" with "-<first 8 hex of sha256(config dir)>" appended
when the CLI runs under CLAUDE_CONFIG_DIR -- which is how each account slot
gets an item of its own. The CLI reads and writes it through the `security`
tool, so the item's ACL already trusts `security` and our reads raise no
keychain prompt. For ~/.claude both the plain and the hashed name are tried:
CLI versions differ on whether the default dir gets a suffix, a machine can
hold both, and the one whose token expires later is the live login.

Writes copy the CLI too. The tokens go to `security -i` on stdin, hex-encoded
(-X), because an argv is readable by every process on the machine (`ps`). A
read-modify-write holds the lock the CLI takes around each of its own writes of
these tokens (<config dir>/.storage-write.lock, a proper-lockfile directory).
Without that lock, a running claude could refresh its token between our read
and our write, and we would put back the refresh token it had just rotated
out. That account would then log out at its next refresh.

Paths stay the identity of an account (usage caches per path, accounts.py keys
slots by path); on a Mac the path is just what the Keychain name derives from.
"""

import contextlib
import getpass
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata

KEYCHAIN = sys.platform == "darwin"       # tests flip this against a fake `security`
SERVICE = "Claude Code-credentials"
_TIMEOUT = 10                              # the CLI's own ceiling for `security`
_STDIN_MAX = 4032         # longest line the CLI hands `security -i`; past it, argv
_LOCK = ".storage-write.lock"             # the CLI's lock dir, beside the tokens
_STALE = 15               # seconds untouched before the CLI calls a holder dead
_LOCK_WAIT = 3.0          # a live holder only spans one write; past this, Busy


class Busy(Exception):
    """The CLI is writing this login's tokens right now."""


def _user() -> str:
    """The Keychain account the CLI files the item under: $USER, else the login
    name, and "claude-code-user" for a name outside [A-Za-z0-9._-]."""
    try:
        name = os.environ.get("USER") or getpass.getuser()
    except (OSError, KeyError):
        name = ""
    return name if re.fullmatch(r"[A-Za-z0-9._-]+", name) else "claude-code-user"


def services(path: str) -> list:
    """Keychain service names the CLI may keep this credentials file under:
    the dir-hashed one always, the plain one too for the default ~/.claude.
    The hash is of CLAUDE_CONFIG_DIR as given (no trailing slash, no realpath).
    The first is the one a write goes to: ~/.claude is only ever run with no
    CLAUDE_CONFIG_DIR, and that CLI reads the plain name."""
    d = unicodedata.normalize("NFC", os.path.dirname(path))
    hashed = f"{SERVICE}-{hashlib.sha256(d.encode()).hexdigest()[:8]}"
    if d == os.path.expanduser("~/.claude"):
        return [SERVICE, hashed]
    return [hashed]


def _security(*args, stdin: "bytes | None" = None) -> "subprocess.CompletedProcess | None":
    try:
        return subprocess.run(["security", *args], input=stdin, capture_output=True,
                              timeout=_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired):
        return None


def _expires(blob: bytes) -> float:
    try:
        return float((json.loads(blob).get("claudeAiOauth") or {}).get("expiresAt") or 0)
    except (ValueError, TypeError, AttributeError):
        return 0.0


def read(path: str) -> bytes:
    """The raw credentials JSON; b"" when there is no login."""
    if KEYCHAIN:
        found = []
        for svc in services(path):
            r = _security("find-generic-password", "-a", _user(), "-w", "-s", svc)
            if r and r.returncode == 0 and r.stdout.strip():
                found.append(r.stdout.strip())
        if found:
            return max(found, key=_expires)
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return b""


def parse(raw: bytes) -> dict:
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def load(path: str) -> dict:
    """read(), parsed; {} for no login or unreadable content."""
    return parse(read(path))


def _keychain_put(service: str, data: bytes) -> bool:
    """Add or replace the item the way the CLI does: the command on stdin with
    the tokens hex-encoded. Only a line too long for `security -i` goes in argv,
    as the CLI's own does."""
    user, payload = _user(), data.hex()
    line = f'add-generic-password -U -a "{user}" -s "{service}" -X "{payload}"\n'
    if len(line) <= _STDIN_MAX:
        r = _security("-i", stdin=line.encode())
    else:
        r = _security("add-generic-password", "-U", "-a", user, "-s", service,
                      "-X", payload)
    return bool(r) and r.returncode == 0


def write(path: str, data: bytes) -> None:
    """Store credentials where `claude` will read them for this config dir:
    the Keychain on a Mac, else -- or when the Keychain refuses -- the 0600
    file, the CLI's own fallback. The file side replaces atomically: a claude
    child reading a truncated JSON mid-write treats the login as corrupt."""
    if KEYCHAIN and _keychain_put(services(path)[0], data):
        return
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


@contextlib.contextmanager
def _storage_lock(path: str):
    """Hold the CLI's write lock for this login's tokens. proper-lockfile's
    protocol: the lock is a directory, made atomically and removed on release,
    and a holder refreshes its mtime while it lives, so one untouched for
    _STALE seconds died holding it and may be taken over."""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)         # the CLI makes the dir before locking too
    lock = os.path.join(d, _LOCK)
    deadline = time.time() + _LOCK_WAIT
    while True:
        try:
            os.mkdir(lock)
            break
        except FileExistsError:
            pass
        try:
            if time.time() - os.stat(lock).st_mtime > _STALE:
                os.rmdir(lock)
                continue
        except FileNotFoundError:
            continue                      # released in between: try again at once
        except OSError:
            pass                          # can't clear it: wait as for a live one
        if time.time() >= deadline:
            raise Busy(lock)
        time.sleep(0.05)
    try:
        yield
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass


def update(path: str, change) -> bool:
    """Read-modify-write a login's tokens under the CLI's own lock. `change`
    maps the parsed credentials to new ones, or to None when there is nothing
    to do, and runs twice (the check before locking, the write after), so it
    must be pure. Returns whether it wrote; Busy when the CLI holds the lock.
    Never creates or replaces unreadable credentials: no login means nothing to
    change, and a slot without one may have a sign-in in flight."""
    creds = load(path)
    if not creds or change(creds) is None:
        return False                      # the common case takes no lock at all
    with _storage_lock(path):
        creds = load(path)                # this copy, read under the lock, is the base
        new = change(creds) if creds else None
        if new is None:
            return False
        write(path, json.dumps(new, separators=(",", ":")).encode())
        return True


def forget(path: str) -> None:
    """Delete a login's tokens everywhere they could be. A removed account's
    refresh token has no business outliving the account."""
    if KEYCHAIN:
        for svc in services(path):
            _security("delete-generic-password", "-a", _user(), "-s", svc)
    try:
        os.remove(path)
    except OSError:
        pass
