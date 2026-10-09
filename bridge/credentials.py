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

Paths stay the identity of an account (usage caches per path, accounts.py keys
slots by path); on a Mac the path is just what the Keychain name derives from.
"""

import getpass
import hashlib
import json
import os
import subprocess
import sys
import unicodedata

KEYCHAIN = sys.platform == "darwin"       # tests flip this against a fake `security`
SERVICE = "Claude Code-credentials"
_TIMEOUT = 10                              # the CLI's own ceiling for `security`


def _user() -> str:
    # ponytail: the CLI substitutes "claude-code-user" for a user name its
    # regex rejects; a name that odd would miss the item until this mirrors it.
    return os.environ.get("USER") or getpass.getuser()


def services(path: str) -> list:
    """Keychain service names the CLI may keep this credentials file under:
    the dir-hashed one always, the plain one too for the default ~/.claude.
    The hash is of CLAUDE_CONFIG_DIR as given (no trailing slash, no realpath)."""
    d = unicodedata.normalize("NFC", os.path.dirname(path))
    hashed = f"{SERVICE}-{hashlib.sha256(d.encode()).hexdigest()[:8]}"
    if d == os.path.expanduser("~/.claude"):
        return [SERVICE, hashed]
    return [hashed]


def _security(*args) -> "subprocess.CompletedProcess | None":
    try:
        return subprocess.run(["security", *args], capture_output=True, timeout=_TIMEOUT)
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


def write(path: str, data: bytes) -> None:
    """Store credentials where `claude` will read them for this config dir:
    the Keychain on a Mac, else -- or when the Keychain refuses -- the 0600
    file, the CLI's own fallback. The file side replaces atomically: a claude
    child reading a truncated JSON mid-write treats the login as corrupt."""
    if KEYCHAIN:
        r = _security("add-generic-password", "-U", "-a", _user(), "-s",
                      services(path)[-1], "-w", data.decode("utf-8", "replace"))
        if r and r.returncode == 0:
            return
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


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
