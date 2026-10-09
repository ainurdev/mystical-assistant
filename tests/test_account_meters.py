"""Whose quota a session spends, on every surface.

The usage meters used to read the ambient login whatever ran the turn, so a
session handed to account 2 by the fallback ladder still showed account 1's
100%. The brief now names the login a session is spending (its turn in flight's,
else the one its next turn takes), both servers list every login with its meter
so a client can show that one's usage and each profile's headroom, and the
bot's /profile says what each profile has left.
"""
from types import SimpleNamespace

import pytest

from bridge import accounts, models, profiles, project_config, runner, store, usage
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini

store.init()
CHAT = 555

LOGINS = [{"slot": 1, "email": "a@x.com", "alias": None, "disabled": False, "default": True,
           "plan": "MAX 20x"},
          {"slot": 2, "email": "b@x.com", "alias": None, "disabled": False, "default": False,
           "plan": "MAX 20x"}]
# What the usage endpoint says for each login: 1 is spent, 2 is nearly fresh.
METERS = {1: {"available": True,
              "five_hour": {"percent": 100, "resets_at": "2026-10-09T16:50:00+00:00",
                            "severity": "critical"},
              "seven_day": {"percent": 31, "resets_at": "2026-10-14T12:00:00+00:00",
                            "severity": "normal"},
              "limits": [{"kind": "weekly_scoped", "percent": 40,
                          "scope": {"model": {"id": None, "display_name": "Fable"}}}]},
          2: {"available": True,
              "five_hour": {"percent": 9, "resets_at": "2026-10-09T21:00:00+00:00",
                            "severity": "normal"},
              "seven_day": {"percent": 2, "resets_at": "2026-10-16T02:00:00+00:00",
                            "severity": "normal"},
              "limits": []}}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(accounts, "list_accounts", lambda: [dict(a) for a in LOGINS])
    monkeypatch.setattr(accounts, "usage_for", lambda slot: METERS.get(int(slot), {"available": False}))
    monkeypatch.setattr(usage, "has_token", lambda path: True)
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-opus-5-5"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])
    monkeypatch.setattr(runner, "live_job", lambda sid: None)


def _handler(mod):
    h = mod.Handler.__new__(mod.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


# --- the brief names the login being spent ---------------------------------

def test_a_session_with_no_profile_spends_the_default_login():
    s = store.create_session(CHAT, "/am-default")
    assert mini._session_brief(store.get_session(s["id"]))["slot"] == accounts.DEFAULT_SLOT


def test_a_session_on_a_profile_spends_that_profiles_login():
    p = profiles.create({"name": "B", "account": "2"})
    s = store.create_session(CHAT, "/am-profile", profile_id=p["id"])
    assert mini._session_brief(store.get_session(s["id"]))["slot"] == 2


def test_a_turn_handed_to_another_login_moves_the_meter_with_it(monkeypatch):
    """The fallback ladder runs the turn on account 2 while the session has no
    profile: the turn in flight is what's being spent, not the default login."""
    s = store.create_session(CHAT, "/am-handover")
    monkeypatch.setattr(runner, "live_job", lambda sid: SimpleNamespace(
        account_slot=2, runtime="claude:2") if sid == s["id"] else None)
    assert mini._session_brief(store.get_session(s["id"]))["slot"] == 2


def test_a_turn_in_flight_on_the_default_login_reads_as_slot_one(monkeypatch):
    p = profiles.create({"name": "B", "account": "2"})
    s = store.create_session(CHAT, "/am-default-run", profile_id=p["id"])
    # Run on the ambient login by hand (account_slot None) despite the profile.
    monkeypatch.setattr(runner, "live_job", lambda sid: SimpleNamespace(
        account_slot=None, runtime=None))
    assert mini._session_brief(store.get_session(s["id"]))["slot"] == accounts.DEFAULT_SLOT


def test_another_agent_spends_no_claude_login(monkeypatch):
    s = store.create_session(CHAT, "/am-agent")
    assert mini._run_slot(store.get_session(s["id"]), {"agent": "codex", "account": "k1"}) is None
    monkeypatch.setattr(runner, "live_job", lambda sid: SimpleNamespace(
        account_slot=None, runtime="acp:codex"))
    assert mini._session_brief(store.get_session(s["id"]))["slot"] is None


# --- both servers list every login with its meter ----------------------------

def test_meter_carries_a_models_own_cap_for_any_login():
    m = accounts.meter(1)
    assert m["left"] == 0 and m["five_hour"]["percent"] == 100
    assert m["limits"][0]["scope"]["model"]["display_name"] == "Fable"
    assert accounts.meter(2)["left"] == 91 and accounts.meter(2)["limits"] == []


def test_both_servers_list_the_same_logins_with_their_meters():
    h, box = _handler(dash)
    h._get_api("/local/accounts", {})
    m, mbox = _handler(mini)
    m._auth = lambda: CHAT
    m.path = "/api/accounts"
    m.do_GET()
    assert box["code"] == 200 and mbox["code"] == 200
    assert box["obj"]["accounts"] == mbox["obj"]["accounts"] == accounts.with_meters()
    a2 = mbox["obj"]["accounts"][1]
    assert (a2["slot"], a2["email"], a2["left"], a2["five_hour"]["percent"]) == (2, "b@x.com", 91, 9)


# --- the bot ------------------------------------------------------------------

def _bot(monkeypatch, project):
    from bridge import dispatch, state
    monkeypatch.setattr(state, "project_key", lambda chat_id: project)
    sent = []
    monkeypatch.setattr(dispatch, "send", lambda chat_id, text, *a, **k: sent.append(text))
    return dispatch, sent


def test_profile_list_says_what_each_claude_profile_has_left(monkeypatch):
    dispatch, sent = _bot(monkeypatch, "/am-bot")
    profiles.create({"name": "Main"})                       # the default login
    profiles.create({"name": "Spare", "account": "2"})
    left = {1: 0, 2: 91}
    monkeypatch.setattr(accounts, "headroom", lambda slot: left.get(int(slot)))
    dispatch.handle_profile_command(CHAT, "/profile")
    assert sent[-1].split("\n")[:2] == ["• Main — claude · 0% left",
                                        "• Spare — claude · 91% left"]
    left[2] = None                                          # slot 2's meter stops reading
    dispatch.handle_profile_command(CHAT, "/profile")
    assert sent[-1].split("\n")[1] == "• Spare — claude"


def test_adding_a_login_names_the_profile_it_got(monkeypatch):
    dispatch, sent = _bot(monkeypatch, "/am-add")

    def add(*a, **k):
        profiles.add_default(2)
        return 2
    monkeypatch.setattr(accounts, "add", add)
    dispatch.handle_fallback_command(CHAT, "/accounts add")
    assert sent[-1].endswith("\nIts profile: /profile b@x.com")

    monkeypatch.setattr(accounts, "pending_login", lambda: {"slot": 3, "url": "u"})
    monkeypatch.setattr(accounts, "submit_login_code",
                        lambda slot, code: {"slot": 3, "email": "c@x.com"})
    dispatch.handle_fallback_command(CHAT, "/accounts code xyz")
    assert sent[-1] == "✅ Added c@x.com as account 3."   # no profile on 3: nothing to name
