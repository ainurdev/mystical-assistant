"""bridge/credentials.py: one reader for a login's tokens on every platform.

Linux and Windows keep them in <config dir>/.credentials.json. macOS keeps them
in the Keychain under a service name derived from the config dir and writes
the file only as a fallback, so a bridge that reads just the file sees no
login on a Mac (2026-10-09: "adding a new account isn't recognised").
"""

import hashlib
import json
import os
import tempfile
import time

import pytest

from bridge import credentials


def _hashed(config_dir: str) -> str:
    return "Claude Code-credentials-" + hashlib.sha256(config_dir.encode()).hexdigest()[:8]


def test_keychain_service_names_follow_the_cli():
    """Default dir: the plain name and the dir-hashed one (CLI versions differ).
    Any other dir, i.e. CLAUDE_CONFIG_DIR: only the hashed one."""
    home = os.path.expanduser("~/.claude")
    assert credentials.services(os.path.join(home, ".credentials.json")) == [
        "Claude Code-credentials", _hashed(home)]
    slot = "/Users/x/.mystical/accounts/2"
    assert credentials.services(slot + "/.credentials.json") == [_hashed(slot)]


def test_off_macos_the_file_is_the_only_store():
    p = os.path.join(tempfile.mkdtemp(), ".credentials.json")
    assert credentials.read(p) == b""
    assert credentials.load(p) == {}
    credentials.write(p, b'{"claudeAiOauth": {"accessToken": "t"}}')
    assert credentials.load(p)["claudeAiOauth"]["accessToken"] == "t"
    assert os.stat(p).st_mode & 0o777 == 0o600
    credentials.forget(p)
    assert not os.path.exists(p)


def test_on_macos_the_keychain_holds_the_login(fake_keychain):
    d = tempfile.mkdtemp()
    p = os.path.join(d, ".credentials.json")
    credentials.write(p, b'{"claudeAiOauth": {"accessToken": "kc"}}')
    assert not os.path.exists(p)                      # it went to the Keychain
    assert "kc" in fake_keychain.get(_hashed(d))
    assert credentials.load(p)["claudeAiOauth"]["accessToken"] == "kc"
    credentials.forget(p)
    assert fake_keychain.get(_hashed(d)) is None
    assert credentials.read(p) == b""


def test_on_macos_the_file_stands_in_when_the_keychain_has_nothing(fake_keychain):
    """The CLI's own fallback (a locked Keychain over SSH) must still be read."""
    p = os.path.join(tempfile.mkdtemp(), ".credentials.json")
    with open(p, "w") as f:
        f.write('{"claudeAiOauth": {"accessToken": "file"}}')
    assert credentials.load(p)["claudeAiOauth"]["accessToken"] == "file"


def test_on_macos_the_fresher_of_two_items_is_the_live_login(fake_keychain):
    """~/.claude can hold both the plain and the hashed item (a CLI upgrade
    left the old one behind): the one whose token expires later is current."""
    home = os.path.expanduser("~/.claude")
    p = os.path.join(home, ".credentials.json")
    fake_keychain.put("Claude Code-credentials",
                      json.dumps({"claudeAiOauth": {"accessToken": "old", "expiresAt": 1}}))
    fake_keychain.put(_hashed(home),
                      json.dumps({"claudeAiOauth": {"accessToken": "new", "expiresAt": 2}}))
    assert credentials.load(p)["claudeAiOauth"]["accessToken"] == "new"


def test_on_macos_the_tokens_never_ride_in_an_argv(fake_keychain):
    """Every process on the machine can read another's argv (`ps`). The CLI
    hands `security` the tokens on stdin, hex-encoded, and so do we."""
    d = tempfile.mkdtemp()
    p = os.path.join(d, ".credentials.json")
    credentials.write(p, b'{"claudeAiOauth": {"accessToken": "sk-secret"}}')
    assert "sk-secret" in fake_keychain.get(_hashed(d))
    for argv in fake_keychain.argvs():
        seen = " ".join(argv)
        assert "sk-secret" not in seen and b"sk-secret".hex() not in seen


def test_on_macos_the_default_login_is_written_where_the_cli_reads_it(fake_keychain, monkeypatch):
    """~/.claude runs with no CLAUDE_CONFIG_DIR, and that CLI reads the plain
    service name. Under the hashed one, nothing would ever read the item."""
    monkeypatch.setenv("HOME", tempfile.mkdtemp())
    home = os.path.expanduser("~/.claude")
    credentials.write(os.path.join(home, ".credentials.json"),
                      b'{"claudeAiOauth": {"accessToken": "t"}}')
    assert fake_keychain.get("Claude Code-credentials") is not None
    assert fake_keychain.get(_hashed(home)) is None


def test_keychain_account_name_follows_the_cli(monkeypatch):
    """The CLI files the item under $USER, or "claude-code-user" when the name
    has a character outside [A-Za-z0-9._-]. Under any other name, the item is
    invisible to whichever side used the wrong one."""
    monkeypatch.setenv("USER", "first.last-2")
    assert credentials._user() == "first.last-2"
    monkeypatch.setenv("USER", "José")
    assert credentials._user() == "claude-code-user"


def test_update_holds_the_clis_lock_and_takes_over_a_dead_holders(monkeypatch):
    """The CLI writes these tokens under <dir>/.storage-write.lock (a token
    refresh among them). A merge outside it could undo a refresh that landed
    between our read and our write."""
    monkeypatch.setattr(credentials, "_LOCK_WAIT", 0.2)
    d = tempfile.mkdtemp()
    p = os.path.join(d, ".credentials.json")
    credentials.write(p, b'{"claudeAiOauth": {"accessToken": "t"}}')
    lock = os.path.join(d, ".storage-write.lock")
    add = lambda c: {**c, "mcpOAuth": {"x": {}}}  # noqa: E731

    os.mkdir(lock)                                    # a claude mid-write
    assert credentials.update(p, lambda c: None) is False, "nothing to do: no wait"
    with pytest.raises(credentials.Busy):
        credentials.update(p, add)
    assert "mcpOAuth" not in credentials.load(p)

    old = time.time() - 60
    os.utime(lock, (old, old))                        # ...that died holding it
    assert credentials.update(p, add) is True
    assert credentials.load(p)["mcpOAuth"] == {"x": {}}
    assert credentials.load(p)["claudeAiOauth"]["accessToken"] == "t"
    assert not os.path.exists(lock), "released once written"


def test_update_never_creates_a_login():
    """No credentials can mean a sign-in in flight: writing some would read as
    that sign-in succeeding."""
    p = os.path.join(tempfile.mkdtemp(), ".credentials.json")
    assert credentials.update(p, lambda c: {**c, "mcpOAuth": {}}) is False
    assert credentials.read(p) == b""
