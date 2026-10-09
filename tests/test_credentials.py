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
