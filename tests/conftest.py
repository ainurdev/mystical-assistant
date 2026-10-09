"""Test-suite fixtures + environment isolation.

CRITICAL: bridge/config.py reads every setting from os.environ AT IMPORT TIME and
freezes it into module constants. So the test environment must be pinned HERE —
in conftest, which pytest imports before any test module (and therefore before
the first `import bridge.config`) — not in each test file's preamble, where a
value leaking from the developer's shell (they run the bridge from it) would win
and, worse, point tests at the real ~/.bridge_state DB and the real chat-id
allow-list. We hard-assign (not setdefault) so a shell value can never leak in.
"""

import json
import os
import shutil
import sys
import tempfile

import pytest

# Every mkdtemp() below and in the tests lands under one root that the session
# removes when it ends (pytest_sessionfinish). The suite used to leave ~3,400
# files in /tmp per run, and on 2026-10-06 parallel runs filled the tmpfs's
# inodes, so anything on the machine needing a temp file (the live bridge too)
# failed. TMPDIR covers the subprocesses the tests spawn.
_TMP_ROOT = tempfile.mkdtemp(prefix="mystical-tests-")
tempfile.tempdir = _TMP_ROOT
os.environ["TMPDIR"] = _TMP_ROOT

# The bridge package lives at the repo root (parent of tests/); put it on the
# path once so every test module imports `bridge` without its own sys.path hack.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Pin the security-relevant env before bridge.config is imported anywhere.
os.environ["TELEGRAM_BOT_TOKEN"] = "12345:TESTTOKEN"
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["DASH_TOKEN"] = "test-dash-token"     # non-empty → the CSRF gate is ON
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "bridge-test.db")
# The MCP allowlist seeds default_disabled_tools(); the bridge exports .env into
# the shells it hosts, so an unpinned value flips that default under the very
# sessions that run this suite (tests patch config.MCP_SERVERS when they want one).
os.environ["MCP_SERVERS"] = ""
# Hard-pin a canonical project root before config freezes it, so within_base()
# is deterministic suite-wide (config.BASE_PATH is read once, at first import).
# Tests that assert on containment should build fixtures under config.BASE_PATH.
os.environ["BASE_PATH"] = tempfile.mkdtemp()
# Same freeze-at-import rule for the file that holds real credentials: a test
# module importing bridge.accounts before its own preamble runs would
# otherwise write account profiles into the developer's actual ~/.mystical.
os.environ["ACCOUNTS_DIR"] = os.path.join(tempfile.mkdtemp(), "accounts")
# Backstop: a regression once reached the real `claude` binary during a test
# run, against the developer's live login, and refreshed
# ~/.claude/.credentials.json twice. Pin an absolute path that cannot exist:
# runner.claude_bin() returns an absolute override as-is, unchecked
# (bridge/runner.py ~206-226), so any test that regresses into spawning claude
# fails fast with "`claude` not found" instead of running the real CLI.
# toolsets._fill catches the OSError and returns [].
os.environ["CLAUDE_BIN"] = os.path.join(tempfile.mkdtemp(), "no-real-claude")

# bridge/credentials.py decides KEYCHAIN from sys.platform at import, so on a Mac
# every test that touches a login ran the real `security` against the
# developer's login Keychain: reading their live tokens, and leaving an item
# behind for every slot a test wrote (2026-10-09: 68 of them in one afternoon).
# Off for the whole suite; the fake_keychain fixture turns it back on against
# the stand-in `security` below.
from bridge import credentials  # noqa: E402
credentials.KEYCHAIN = False

# Claude Code's live-session registry is a path frozen at import in bridge.machine,
# with no env knob. native.scan() now indexes what that registry lists, so leave it
# pointed at the developer's real ~/.claude/sessions and the suite would index the
# very sessions running it. Empty temp dir; a test that wants rows writes them there.
from bridge import machine  # noqa: E402
machine.SESSIONS_DIR = tempfile.mkdtemp()

# Same story for ~/.claude.json: toolsets merges other projects' local-scope MCP
# servers straight from it, and the path is frozen at import with no env knob.
# Point it at a file that doesn't exist so the suite never reads the real one.
from bridge import toolsets  # noqa: E402
toolsets.CLAUDE_JSON = os.path.join(tempfile.mkdtemp(), "claude.json")

# bridge/acp_agents.py freezes three paths in the developer's real home at
# import time, with no env knob: ACCOUNTS_FILE, OPTIONS_FILE, HOMES. A test
# that triggers remember_options()/add_account() without its own monkeypatch
# would write agent accounts, options and homes into the real ~/.mystical.
from bridge import acp_agents  # noqa: E402
_acp_tmp = tempfile.mkdtemp()
acp_agents.ACCOUNTS_FILE = os.path.join(_acp_tmp, "agent-accounts.json")
acp_agents.OPTIONS_FILE = os.path.join(_acp_tmp, "acp-options.json")
acp_agents.HOMES = os.path.join(_acp_tmp, "agent-homes")

# A profiles.json one test leaves behind would bind every later test's new
# sessions to its first profile (profiles.default_profile), so each test gets
# an empty list and no picked default.
from bridge import profiles, store  # noqa: E402


@pytest.fixture(autouse=True)
def _no_profiles(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "conftest-profiles.json"))
    try:
        store.set_setting(profiles.DEFAULT_KEY, None)
    except Exception:  # noqa: BLE001 - a test that never ran store.init()
        pass

# An empty selection is not a failure. pytest counts session.testscollected AFTER
# -k/-m deselection (_pytest/main.py:870), so a filter that matches nothing lands
# on the same `testscollected == 0` branch as a bad path or a file with no tests
# and exits 5 (main.py:376). Only the second kind is worth failing over. Counting
# deselections tells them apart, and wrap_session returns session.exitstatus
# *after* pytest_sessionfinish runs, so reassigning it here is honoured.
# ponytail: any deselection counts, so --lf/--stepwise with nothing left to re-run
# also exits 0. Gate on config.option.keyword/markexpr if that ever bites.
_deselected = 0


def pytest_deselected(items):
    global _deselected
    _deselected += len(items)


def pytest_sessionfinish(session, exitstatus):
    if exitstatus == 5 and _deselected:      # 5 == ExitCode.NO_TESTS_COLLECTED
        session.exitstatus = 0
    # ponytail: a killed run (SIGKILL, power) still leaves its root behind;
    # it's one dir named mystical-tests-*, so a stale sweep is easy if it adds up.
    shutil.rmtree(_TMP_ROOT, ignore_errors=True)


# --- a stand-in macOS Keychain --------------------------------------------------
# bridge/credentials.py reads a Mac's login through the `security` tool, as the
# CLI does. This `security` speaks the three generic-password verbs both use,
# backed by one JSON file, so the macOS paths run on Linux: the suite can't
# reach a real Keychain, and must never touch one. It takes them in argv or, as
# `security -i`, one per line on stdin, with the secret as -w text or -X hex;
# every argv it is run with is logged, since an argv is what `ps` shows.

_FAKE_SECURITY = """#!/usr/bin/env python3
import json, os, shlex, sys
store = os.environ["FAKE_KEYCHAIN"]
with open(store + ".argv", "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")

def run(verb, args):
    items = json.load(open(store)) if os.path.exists(store) else {}
    opt = lambda flag: args[args.index(flag) + 1] if flag in args else ""
    key = opt("-a") + "\\0" + opt("-s")
    if verb == "find-generic-password":
        if key not in items:
            sys.stderr.write("security: SecKeychainSearchCopyNext: The specified item "
                             "could not be found in the keychain.\\n")
            return 44
        sys.stdout.write(items[key] + "\\n")
    elif verb == "add-generic-password":
        if key in items and "-U" not in args:
            return 45                     # errSecDuplicateItem
        items[key] = bytes.fromhex(opt("-X")).decode() if "-X" in args else opt("-w")
        json.dump(items, open(store, "w"))
    elif verb == "delete-generic-password":
        if key not in items:
            return 44
        del items[key]
        json.dump(items, open(store, "w"))
    else:
        return 2
    return 0

if sys.argv[1:] == ["-i"]:
    status = 0
    for line in sys.stdin:
        words = shlex.split(line)
        if words:
            status = run(words[0], words[1:])
    sys.exit(status)
sys.exit(run(sys.argv[1], sys.argv[2:]))
"""


class FakeKeychain:
    def __init__(self, store):
        self.store = store

    def _items(self) -> dict:
        return json.load(open(self.store)) if os.path.exists(self.store) else {}

    def argvs(self) -> list:
        """Every argv the stand-in `security` has been run with."""
        log = self.store + ".argv"
        return [json.loads(ln) for ln in open(log)] if os.path.exists(log) else []

    def get(self, service: str) -> "str | None":
        return self._items().get(self._key(service))

    def put(self, service: str, text: str) -> None:
        items = self._items()
        items[self._key(service)] = text
        json.dump(items, open(self.store, "w"))

    @staticmethod
    def _key(service: str) -> str:
        from bridge import credentials
        return credentials._user() + "\0" + service


@pytest.fixture
def fake_keychain(monkeypatch):
    """Flip bridge.credentials into its macOS mode against a fake `security`
    on PATH. Yields a FakeKeychain to seed and inspect items by service name."""
    from bridge import credentials
    d = tempfile.mkdtemp()
    script = os.path.join(d, "security")
    with open(script, "w") as f:
        f.write(_FAKE_SECURITY)
    os.chmod(script, 0o755)
    monkeypatch.setenv("PATH", d + os.pathsep + os.environ.get("PATH", ""))
    monkeypatch.setenv("FAKE_KEYCHAIN", os.path.join(d, "keychain.json"))
    monkeypatch.setattr(credentials, "KEYCHAIN", True)
    return FakeKeychain(os.path.join(d, "keychain.json"))
