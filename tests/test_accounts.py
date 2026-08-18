"""Unit tests for multi-account profile overlays (bridge/accounts.py).

A profile is a CLAUDE_CONFIG_DIR: its own .credentials.json, everything else
symlinked back to ~/.claude so transcripts/skills/settings stay shared. Env is
pinned before importing the package so config picks it up.
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["ACCOUNTS_DIR"] = os.path.join(tempfile.mkdtemp(), "accounts")

from bridge import accounts  # noqa: E402


def test_env_for_default_account_sets_no_config_dir():
    """Slot 1 is the ambient ~/.claude login — it must not be redirected."""
    assert accounts.env_for(1) == {}


def test_env_for_slot_points_claude_at_that_profile():
    env = accounts.env_for(2)
    assert env["CLAUDE_CONFIG_DIR"] == accounts.profile_dir(2)
    assert accounts.profile_dir(2).endswith(os.path.join("accounts", "2"))


def test_env_for_none_is_the_default_account():
    assert accounts.env_for(None) == {}


# --- overlay construction ---------------------------------------------------

def _fake_claude_home():
    """A stand-in ~/.claude with the entries a profile shares. Returns its path;
    accounts.CLAUDE_HOME is repointed at it."""
    home = tempfile.mkdtemp()
    for d in ("projects", "skills", "plugins", "hooks", "sessions"):
        os.makedirs(os.path.join(home, d), exist_ok=True)
    for f in ("settings.json", "CLAUDE.md"):
        with open(os.path.join(home, f), "w") as fh:
            fh.write("{}")
    with open(os.path.join(home, ".credentials.json"), "w") as fh:
        fh.write('{"claudeAiOauth": {"accessToken": "live-token"}}')
    accounts.CLAUDE_HOME = home
    return home


def test_ensure_profile_symlinks_shared_state_back_to_claude_home():
    home = _fake_claude_home()
    p = accounts.ensure_profile(2)
    for name in ("projects", "skills", "plugins", "settings.json", "CLAUDE.md"):
        link = os.path.join(p, name)
        assert os.path.islink(link), f"{name} must be shared by symlink"
        assert os.path.realpath(link) == os.path.realpath(
            os.path.join(home, name))


def test_ensure_profile_keeps_credentials_a_real_file():
    """Sharing tokens would defeat the whole point — every slot is one login."""
    _fake_claude_home()
    p = accounts.ensure_profile(3)
    creds = os.path.join(p, ".credentials.json")
    assert not os.path.islink(creds)


def test_ensure_profile_repairs_a_missing_link_without_touching_credentials():
    _fake_claude_home()
    p = accounts.ensure_profile(4)
    with open(os.path.join(p, ".credentials.json"), "w") as fh:
        fh.write('{"claudeAiOauth": {"accessToken": "slot4-token"}}')
    os.remove(os.path.join(p, "projects"))

    accounts.ensure_profile(4)

    assert os.path.islink(os.path.join(p, "projects")), "link not repaired"
    with open(os.path.join(p, ".credentials.json")) as fh:
        assert "slot4-token" in fh.read(), "credentials were clobbered"


def test_ensure_profile_skips_entries_absent_from_claude_home():
    """settings.local.json is optional — a profile must not link a dangling name."""
    home = _fake_claude_home()
    assert not os.path.exists(os.path.join(home, "settings.local.json"))
    p = accounts.ensure_profile(5)
    assert not os.path.lexists(os.path.join(p, "settings.local.json"))


# --- registry: add / list / remove / disable ---------------------------------

def _fresh_root():
    """Point ROOT at an empty dir so each registry test starts blank."""
    accounts.ROOT = os.path.join(tempfile.mkdtemp(), "accounts")
    return accounts.ROOT


def _fake_identity(email="me@example.com", mcp=None):
    """Stand-in ~/.claude.json (identity lives OUTSIDE ~/.claude)."""
    path = os.path.join(tempfile.mkdtemp(), ".claude.json")
    data = {"oauthAccount": {"emailAddress": email}}
    if mcp is not None:
        data["mcpServers"] = mcp
    with open(path, "w") as fh:
        json.dump(data, fh)
    accounts.IDENTITY = path
    return path


def test_ambient_login_is_slot_one_without_any_setup():
    """One account and no config must still work — slot 1 is ~/.claude itself."""
    _fresh_root()
    _fake_claude_home()
    _fake_identity("solo@example.com")

    got = accounts.list_accounts()

    assert [a["slot"] for a in got] == [1]
    assert got[0]["email"] == "solo@example.com"
    assert got[0]["default"] is True


def test_add_copies_the_current_login_into_the_next_free_slot():
    _fresh_root()
    _fake_claude_home()
    _fake_identity("second@example.com")

    slot = accounts.add()

    assert slot == 2
    with open(accounts.credentials_path(2)) as fh:
        assert "live-token" in fh.read()
    assert [a["slot"] for a in accounts.list_accounts()] == [1, 2]


def test_added_credentials_are_not_world_readable():
    _fresh_root()
    _fake_claude_home()
    _fake_identity()
    accounts.add()
    mode = os.stat(accounts.credentials_path(2)).st_mode & 0o777
    assert mode == 0o600, f"tokens at mode {oct(mode)}"


def test_add_records_the_email_it_snapshotted():
    _fresh_root()
    _fake_claude_home()
    _fake_identity("work@example.com")
    accounts.add()
    entry = [a for a in accounts.list_accounts() if a["slot"] == 2][0]
    assert entry["email"] == "work@example.com"


def test_add_refuses_a_login_already_saved_in_a_slot():
    """Pressing ADD twice must not mint two slots of the same account."""
    _fresh_root()
    _fake_claude_home()
    _fake_identity("work@example.com")
    accounts.add()
    try:
        accounts.add()
    except ValueError as e:
        assert "2" in str(e) and "work@example.com" in str(e)
    else:
        raise AssertionError("expected ValueError")
    assert [a["slot"] for a in accounts.list_accounts()] == [1, 2]


def test_add_refuses_when_there_is_no_login_to_copy():
    _fresh_root()
    home = _fake_claude_home()
    os.remove(os.path.join(home, ".credentials.json"))
    _fake_identity()
    try:
        accounts.add()
    except accounts.NoLogin:
        return
    raise AssertionError("expected NoLogin")


def test_disable_holds_a_slot_out_of_rotation_but_keeps_it_listed():
    _fresh_root()
    _fake_claude_home()
    _fake_identity()
    accounts.add()

    accounts.disable(2)
    entry = [a for a in accounts.list_accounts() if a["slot"] == 2][0]
    assert entry["disabled"] is True

    accounts.enable(2)
    entry = [a for a in accounts.list_accounts() if a["slot"] == 2][0]
    assert entry["disabled"] is False


def test_remove_drops_the_slot_and_its_profile_dir():
    _fresh_root()
    _fake_claude_home()
    _fake_identity()
    accounts.add()
    p = accounts.profile_dir(2)
    assert os.path.isdir(p)

    accounts.remove(2)

    assert [a["slot"] for a in accounts.list_accounts()] == [1]
    assert not os.path.exists(p)


def test_remove_refuses_to_delete_the_ambient_login():
    """Slot 1 is the user's real ~/.claude — removing it is never our business."""
    _fresh_root()
    _fake_claude_home()
    _fake_identity()
    try:
        accounts.remove(1)
    except ValueError:
        return
    raise AssertionError("expected ValueError")


# --- user-scoped MCP state follows the ambient login into every profile ------

def test_ensure_profile_seeds_user_scoped_mcp_servers():
    """A slot's fresh .claude.json knows nothing of `claude mcp add --scope
    user` servers: they live in the ambient ~/.claude.json."""
    _fresh_root()
    _fake_claude_home()
    _fake_identity(mcp={"railway": {"type": "http", "url": "https://x"}})

    p = accounts.ensure_profile(2)

    with open(os.path.join(p, ".claude.json")) as fh:
        assert json.load(fh)["mcpServers"]["railway"]["url"] == "https://x"


def test_ensure_profile_merges_mcp_servers_ambient_wins():
    _fresh_root()
    _fake_claude_home()
    _fake_identity(mcp={"railway": {"url": "https://new"}})
    p = accounts.ensure_profile(2)
    with open(os.path.join(p, ".claude.json"), "w") as fh:
        json.dump({"oauthAccount": {"emailAddress": "slot@example.com"},
                   "mcpServers": {"railway": {"url": "https://old"},
                                  "local-only": {"url": "https://keep"}}}, fh)

    accounts.ensure_profile(2)

    with open(os.path.join(p, ".claude.json")) as fh:
        got = json.load(fh)
    assert got["mcpServers"]["railway"]["url"] == "https://new"
    assert got["mcpServers"]["local-only"]["url"] == "https://keep"
    assert got["oauthAccount"]["emailAddress"] == "slot@example.com"


def test_ensure_profile_syncs_mcp_oauth_into_a_logged_in_slot():
    """MCP OAuth tokens (Notion, GitHub, plugin servers…) are the user's tool
    logins, not the Claude account's; a slot without them has every external
    server stuck at 'needs authentication'."""
    _fresh_root()
    home = _fake_claude_home()
    _fake_identity()
    with open(os.path.join(home, ".credentials.json"), "w") as fh:
        json.dump({"claudeAiOauth": {"accessToken": "ambient-token"},
                   "mcpOAuth": {"notion|abc": {"accessToken": "n1", "expiresAt": 200},
                                "github|def": {"accessToken": "g1", "expiresAt": 200}}}, fh)
    p = accounts.ensure_profile(2)
    creds = os.path.join(p, ".credentials.json")
    with open(creds, "w") as fh:
        json.dump({"claudeAiOauth": {"accessToken": "slot-token"},
                   "mcpOAuth": {"notion|abc": {"accessToken": "n-newer",
                                               "expiresAt": 900}}}, fh)

    accounts.ensure_profile(2)

    with open(creds) as fh:
        got = json.load(fh)
    assert got["claudeAiOauth"]["accessToken"] == "slot-token", \
        "the Claude login is the slot's own, never overwrite it"
    assert got["mcpOAuth"]["github|def"]["accessToken"] == "g1", "missing token copied"
    assert got["mcpOAuth"]["notion|abc"]["accessToken"] == "n-newer", \
        "a fresher slot token must survive the sync"
    assert os.stat(creds).st_mode & 0o777 == 0o600


def test_ensure_profile_never_creates_credentials_for_a_pending_login():
    """submit_login_code treats the file's existence as login success."""
    _fresh_root()
    home = _fake_claude_home()
    _fake_identity()
    with open(os.path.join(home, ".credentials.json"), "w") as fh:
        json.dump({"claudeAiOauth": {"accessToken": "x"},
                   "mcpOAuth": {"notion|abc": {"accessToken": "n1"}}}, fh)

    p = accounts.ensure_profile(2)

    assert not os.path.exists(os.path.join(p, ".credentials.json"))


def test_env_for_a_slot_repairs_and_syncs_its_profile():
    """Every spawn self-heals: a server added to the ambient login after the
    slot was created still reaches the next turn run on that slot."""
    _fresh_root()
    _fake_claude_home()
    _fake_identity(mcp={"railway": {"url": "https://x"}})

    env = accounts.env_for(4)

    assert env["CLAUDE_CONFIG_DIR"] == accounts.profile_dir(4)
    with open(os.path.join(accounts.profile_dir(4), ".claude.json")) as fh:
        assert "railway" in json.load(fh)["mcpServers"]


# --- browser sign-in ---------------------------------------------------------
# The real `claude auth login` prints an OAuth URL, waits for a pasted code and
# writes credentials into CLAUDE_CONFIG_DIR. A stand-in speaking that protocol
# covers the flow without a network round-trip.

_FAKE_CLI = '''#!/usr/bin/env python3
import json, os, sys
url = "https://claude.com/cai/oauth/authorize?code=true&client_id=x"
# The CLI hyperlinks the URL, so it arrives as OSC-8 target *and* link text.
sys.stdout.write("\\x1b]8;;%s\\x1b\\\\%s\\x1b]8;;\\x1b\\\\\\n" % (url, url))
sys.stdout.write("Paste code here if prompted > ")
sys.stdout.flush()
code = sys.stdin.readline().strip()
home = os.environ["CLAUDE_CONFIG_DIR"]
if code != "good-code":
    sys.stdout.write("Login failed: Request failed with status code 400\\n")
    sys.exit(1)
with open(os.path.join(home, ".credentials.json"), "w") as fh:
    json.dump({"claudeAiOauth": {"accessToken": "slot-token"}}, fh)
with open(os.path.join(home, ".claude.json"), "w") as fh:
    json.dump({"oauthAccount": {"emailAddress": "other@example.com"}}, fh)
'''


def _fake_cli():
    """Put a stand-in `claude` behind runner.claude_bin(); returns an undo."""
    from bridge import runner
    path = os.path.join(tempfile.mkdtemp(), "claude")
    with open(path, "w") as fh:
        fh.write(_FAKE_CLI)
    os.chmod(path, 0o755)
    original = runner.claude_bin
    runner.claude_bin = lambda: path
    return lambda: setattr(runner, "claude_bin", original)


def test_begin_login_hands_back_one_clean_sign_in_url():
    """The terminal-hyperlink escapes double the URL — one has to come out."""
    _fresh_root()
    _fake_claude_home()
    _fake_identity()
    undo = _fake_cli()
    try:
        began = accounts.begin_login()
        assert began["slot"] == 2
        assert began["url"] == "https://claude.com/cai/oauth/authorize?code=true&client_id=x"
    finally:
        accounts.cancel_login(2)
        undo()


def test_a_sign_in_leaves_the_ambient_login_alone():
    """The whole point over add(): slot 1 is never logged out to gain a slot 2."""
    _fresh_root()
    home = _fake_claude_home()
    _fake_identity()
    undo = _fake_cli()
    before = open(os.path.join(home, ".credentials.json")).read()
    try:
        accounts.begin_login()
        accounts.submit_login_code(2, "good-code", timeout=10)
        assert open(os.path.join(home, ".credentials.json")).read() == before
    finally:
        undo()


def test_submit_login_code_registers_the_account_it_signed_in_as():
    _fresh_root()
    _fake_claude_home()
    _fake_identity("mine@example.com")
    undo = _fake_cli()
    try:
        accounts.begin_login()
        done = accounts.submit_login_code(2, "good-code", timeout=10)
        assert done["email"] == "other@example.com"
        listed = accounts.list_accounts()
        assert [a["slot"] for a in listed] == [1, 2]
        assert listed[1]["email"] == "other@example.com"
        assert "slot-token" in open(accounts.credentials_path(2)).read()
    finally:
        undo()


def test_a_rejected_code_leaves_no_half_made_account():
    _fresh_root()
    _fake_claude_home()
    _fake_identity()
    undo = _fake_cli()
    try:
        accounts.begin_login()
        try:
            accounts.submit_login_code(2, "wrong-code", timeout=10)
        except accounts.LoginFailed as e:
            assert "400" in str(e)
            assert "Paste code here" not in str(e), "the CLI's prompt is not an error"
        else:
            raise AssertionError("expected LoginFailed")
        assert [a["slot"] for a in accounts.list_accounts()] == [1]
        assert not os.path.exists(accounts.profile_dir(2))
        assert accounts.pending_login() is None
    finally:
        undo()


def test_submit_login_code_refuses_an_account_already_in_a_slot():
    """Signing in as an account that already has a slot must not duplicate it."""
    _fresh_root()
    _fake_claude_home()
    _fake_identity("mine@example.com")
    undo = _fake_cli()
    try:
        accounts.begin_login()
        accounts.submit_login_code(2, "good-code", timeout=10)   # other@example.com
        accounts.begin_login()
        try:
            accounts.submit_login_code(3, "good-code", timeout=10)  # same account
        except accounts.LoginFailed as e:
            assert "other@example.com" in str(e) and "2" in str(e)
        else:
            raise AssertionError("expected LoginFailed")
        assert [a["slot"] for a in accounts.list_accounts()] == [1, 2]
        assert not os.path.exists(accounts.profile_dir(3))
    finally:
        undo()


def test_submit_login_code_refuses_the_ambient_account():
    """Signing in as the login already active in ~/.claude is a duplicate of
    slot 1, not a new account."""
    _fresh_root()
    _fake_claude_home()
    _fake_identity("other@example.com")   # ambient == what the fake CLI signs in as
    undo = _fake_cli()
    try:
        accounts.begin_login()
        try:
            accounts.submit_login_code(2, "good-code", timeout=10)
        except accounts.LoginFailed as e:
            assert "1" in str(e)
        else:
            raise AssertionError("expected LoginFailed")
        assert [a["slot"] for a in accounts.list_accounts()] == [1]
        assert not os.path.exists(accounts.profile_dir(2))
    finally:
        undo()


def test_a_new_sign_in_never_inherits_a_stale_slot_credential():
    """Spoil from an abandoned attempt would otherwise read as success."""
    _fresh_root()
    _fake_claude_home()
    _fake_identity()
    undo = _fake_cli()
    stale = os.path.join(accounts.ensure_profile(2), ".credentials.json")
    with open(stale, "w") as fh:
        fh.write('{"claudeAiOauth": {"accessToken": "someone-elses"}}')
    try:
        accounts.begin_login()
        assert not os.path.exists(stale)
    finally:
        accounts.cancel_login(2)
        undo()


# --- pick(): which account takes over ---------------------------------------

def _meter(five=0, seven=0, seven_reset=None):
    return {"available": True,
            "five_hour": {"percent": five, "resets_at": None, "severity": "normal"},
            "seven_day": {"percent": seven, "resets_at": seven_reset,
                          "severity": "normal"} if seven or seven_reset else None,
            "limits": []}


def _stub_usage(by_slot: dict):
    """Patch the usage lookup accounts.pick() reads, keyed by slot."""
    saved = accounts.usage.get_usage
    paths = {accounts.credentials_path(s): m for s, m in by_slot.items()}
    accounts.usage.get_usage = lambda p=None: paths.get(
        p or accounts.credentials_path(1), {"available": False})
    return lambda: setattr(accounts.usage, "get_usage", saved)


def _slots(n):
    """Register slots 2..n so list_accounts() reports them. Each add is a
    distinct login: the same account twice is exactly what add() refuses."""
    _fresh_root()
    _fake_claude_home()
    for i in range(2, n + 1):
        _fake_identity(f"acct{i}@example.com")
        accounts.add()
    _fake_identity()


def test_pick_takes_the_account_with_most_quota_left():
    _slots(3)
    restore = _stub_usage({1: _meter(five=90), 2: _meter(five=20),
                           3: _meter(five=55)})
    try:
        assert accounts.pick() == 2
    finally:
        restore()


def test_pick_counts_the_worst_of_the_two_windows():
    """A fresh 5-hour window is worthless if the weekly one is nearly gone."""
    _slots(2)
    restore = _stub_usage({1: _meter(five=50, seven=50),
                           2: _meter(five=1, seven=95)})
    try:
        assert accounts.pick() == 1
    finally:
        restore()


def test_pick_skips_the_account_that_just_died():
    _slots(3)
    restore = _stub_usage({1: _meter(five=10), 2: _meter(five=20),
                           3: _meter(five=30)})
    try:
        assert accounts.pick(exclude=(1,)) == 2
        assert accounts.pick(exclude=(1, 2)) == 3
    finally:
        restore()


def test_pick_skips_exhausted_accounts():
    _slots(2)
    restore = _stub_usage({1: _meter(five=100), 2: _meter(five=99)})
    try:
        assert accounts.pick() is None
    finally:
        restore()


def test_pick_skips_disabled_accounts():
    _slots(2)
    accounts.disable(2)
    restore = _stub_usage({1: _meter(five=80), 2: _meter(five=0)})
    try:
        assert accounts.pick() == 1
    finally:
        restore()


def test_pick_skips_accounts_with_no_readable_usage():
    """No meter means no evidence of headroom — never gamble a turn on it."""
    _slots(2)
    restore = _stub_usage({1: _meter(five=50)})     # slot 2 → {"available": False}
    try:
        assert accounts.pick() == 1
    finally:
        restore()


def test_pick_returns_none_when_every_account_is_spent():
    _slots(2)
    restore = _stub_usage({1: _meter(five=100), 2: _meter(five=100)})
    try:
        assert accounts.pick() is None
    finally:
        restore()


def test_consume_first_prefers_the_soonest_expiring_weekly_quota():
    """Use-it-or-lose-it: spend the window that resets soonest, not the fullest."""
    _slots(2)
    restore = _stub_usage({
        1: _meter(five=40, seven=40, seven_reset="2026-08-05T12:00:00+00:00"),
        2: _meter(five=10, seven=10, seven_reset="2026-08-01T12:00:00+00:00"),
    })
    try:
        assert accounts.pick(strategy="best") == 2          # most left
        assert accounts.pick(strategy="consume-first") == 2  # also soonest
        restore()
        restore2 = _stub_usage({
            1: _meter(five=40, seven=40, seven_reset="2026-08-01T12:00:00+00:00"),
            2: _meter(five=10, seven=10, seven_reset="2026-08-05T12:00:00+00:00"),
        })
        try:
            assert accounts.pick(strategy="best") == 2          # most left
            assert accounts.pick(strategy="consume-first") == 1  # expires first
        finally:
            restore2()
    finally:
        pass


if __name__ == "__main__":
    import traceback
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception:  # noqa: BLE001
                fails += 1
                print(f"FAIL {name}")
                traceback.print_exc()
    print(f"\n{fails} failure(s)")
    sys.exit(1 if fails else 0)
