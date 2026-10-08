"""Both servers' profile routes, the briefs, and /run no longer pinning a
profiled session (Review Focus 5)."""
from types import SimpleNamespace

import pytest

from bridge import accounts, config, models, profiles, project_config, relevance, runner, store
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini

store.init()
CHAT = 555


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(accounts, "list_accounts", lambda: [{"slot": 1, "disabled": False}])
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-opus-5-5", "claude-fable-5-1"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])
    monkeypatch.setattr(relevance, "gate", lambda *a, **k: None)


def _handler(mod):
    h = mod.Handler.__new__(mod.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _p(**kw):
    return profiles.create({"name": "P", "agent": "claude", "model": "claude-fable-5-1",
                            "mode": "plan", "effort": "high", **kw})


def test_brief_of_a_bound_session_shows_effective_values_and_no_overrides():
    p = _p()
    s = store.create_session(CHAT, "/pe-brief", profile_id=p["id"])
    b = mini._session_brief(store.get_session(s["id"]))
    assert (b["profile_id"], b["model"], b["permission_mode"], b["effort"], b["overrides"]) == (
        p["id"], "claude-fable-5-1", "plan", "high", [])


def test_brief_of_a_session_whose_profile_was_deleted_still_renders():
    p = _p()
    s = store.create_session(CHAT, "/pe-gone", profile_id=p["id"])
    profiles.delete(p["id"])
    b = mini._session_brief(store.get_session(s["id"]))
    assert b["profile_id"] is None and b["model"] == "claude-fable-5-1"


def test_settings_pick_equal_to_the_profile_follows_it():
    p = _p()
    s = store.create_session(CHAT, "/pe-set", profile_id=p["id"])
    out, code = mini.save_run_settings(s, {"model": "claude-fable-5-1", "effort": "low",
                                           "pick": "effort"})
    row = store.get_session(s["id"])
    assert code == 200 and row["model"] is None and row["effort"] == "low"
    assert out["overrides"] == ["effort"]


def _run(mod, monkeypatch, body):
    def start(chat, prompt, paths, project=None, **kw):
        sess = runner._resolve_session(chat, project or config.BASE_PATH,
                                       session_id=kw.get("session_id"),
                                       permission_mode=kw.get("permission_mode"),
                                       origin="dashboard", profile_id=kw.get("profile_id"))
        return SimpleNamespace(id="j", store_session_id=sess["id"])
    monkeypatch.setattr(runner, "start_streaming_job", start)
    h, box = _handler(mod)
    (h._run if mod is dash else h._api_run)(CHAT, body)
    return box


def _create(mod, project):
    """A session made the way both clients make one: before its first /run, so
    /run's profile_id never reaches it. An existing cwd, so neither route has to
    fall back to the chat's project dir."""
    h, box = _handler(mod)
    body = {"project": project, "cwd": config.BASE_PATH}
    if mod is dash:
        h._post_api("/local/sessions", body)
    else:
        h._api_sessions_create(CHAT, body)
    return store.get_session(box["obj"]["session"]["id"])


@pytest.mark.parametrize("mod", [dash, mini])
def test_a_new_session_takes_its_project_default_and_its_mode(mod):
    p = _p()
    profiles.set_project_default("/pe-new", p["id"])
    row = _create(mod, "/pe-new")
    assert (row["profile_id"], row["permission_mode"]) == (p["id"], None)


@pytest.mark.parametrize("mod", [dash, mini])
def test_a_new_session_without_a_project_default_is_unchanged(mod):
    row = _create(mod, "/pe-new-plain")
    assert (row["profile_id"], row["permission_mode"]) == (
        None, config.NEW_SESSION_PERMISSION_MODE)


@pytest.mark.parametrize("mod", [dash, mini])
def test_run_echoing_the_profile_does_not_pin_the_session(mod, monkeypatch):
    p = _p()
    s = store.create_session(CHAT, "/pe-run", cwd=config.BASE_PATH, profile_id=p["id"])
    box = _run(mod, monkeypatch, {"prompt": "hi", "session_id": s["id"],
                                  "model": "claude-fable-5-1", "permission_mode": "plan",
                                  "effort": "high"})
    assert box["code"] == 200
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"], row["effort"]) == (None, None, None)


def test_dashboard_profile_routes_round_trip():
    h, box = _handler(dash)
    h._post_profiles(CHAT, {"action": "create", "name": "X", "agent": "claude"})
    assert box["code"] == 200
    pid = box["obj"]["profile"]["id"]
    s = store.create_session(CHAT, "/pe-bind")
    h._post_session_profile(CHAT, {"session_id": s["id"], "profile_id": pid})
    assert box["code"] == 200 and box["obj"]["session"]["profile_id"] == pid
    h._post_project_profile(CHAT, {"project": "/pe-bind", "profile_id": pid})
    assert box["obj"]["project_defaults"] == {"/pe-bind": pid}


def test_session_profile_rejects_someone_elses_session():
    h, box = _handler(dash)
    s = store.create_session(999, "/pe-other")
    h._post_session_profile(CHAT, {"session_id": s["id"], "profile_id": ""})
    assert box["code"] == 404


def test_miniapp_session_profile_round_trip():
    """The Mini App's half of the dashboard's round trip: GET list, POST bind.
    Profile creation stays dashboard-only (spec: "Profiles are edited on the
    dashboard")."""
    p = _p()
    h, box = _handler(mini)
    h._api_profiles(CHAT)
    assert box["code"] == 200 and [row["id"] for row in box["obj"]["profiles"]] == [p["id"]]
    s = store.create_session(CHAT, "/pe-bind-mini")
    h._api_session_profile(CHAT, {"session_id": s["id"], "profile_id": p["id"]})
    assert box["code"] == 200 and box["obj"]["session"]["profile_id"] == p["id"]


def test_miniapp_session_profile_rejects_someone_elses_session():
    h, box = _handler(mini)
    s = store.create_session(999, "/pe-other-mini")
    h._api_session_profile(CHAT, {"session_id": s["id"], "profile_id": ""})
    assert box["code"] == 404


def test_profile_bot_command_lists_binds_and_unbinds(monkeypatch):
    """The third surface: /profile lists, binds by name, unbinds with "none",
    and tells an unknown name apart from "none" (profiles.bind's "" vs a
    missing name's None)."""
    from bridge import dispatch, state
    monkeypatch.setattr(state, "project_key", lambda chat_id: "/pe-profile-cmd")
    sent = []
    monkeypatch.setattr(dispatch, "send", lambda chat_id, text, *a, **k: sent.append(text))
    s = store.create_session(CHAT, "/pe-profile-cmd")
    p = _p()

    dispatch.handle_profile_command(CHAT, "/profile")
    assert sent[-1].split("\n")[0] == "• P — claude · claude-fable-5-1"

    dispatch.handle_profile_command(CHAT, "/profile p")       # case-insensitive
    assert sent[-1] == "✅ Profile: p"
    assert store.get_session(s["id"])["profile_id"] == p["id"]

    dispatch.handle_profile_command(CHAT, "/profile none")
    assert sent[-1] == "✅ Profile removed"
    assert store.get_session(s["id"])["profile_id"] is None

    dispatch.handle_profile_command(CHAT, "/profile nope")
    assert sent[-1] == "No profile named 'nope'. /profile lists them."


def test_history_rows_carry_the_profile_on_both_servers(monkeypatch):
    """Final review minor 4: a session opened from History seeds from its row."""
    from bridge import native
    monkeypatch.setattr(native, "refresh", lambda chat: None)
    p = _p()
    sid = store.create_session(config.DASH_CHAT_ID, "/pe-hist", profile_id=p["id"])["id"]
    h, box = _handler(dash)
    h._get_api("/local/history", {})
    m, mbox = _handler(mini)
    m._api_history(config.DASH_CHAT_ID, {})
    for rows in (box["obj"]["sessions"], mbox["obj"]["sessions"]):
        row = next(r for r in rows if r["id"] == sid)
        assert (row["profile_id"], row["agent"], row["model"], row["permission_mode"],
                row["effort"], row["overrides"]) == (
            p["id"], "claude", "claude-fable-5-1", "plan", "high", [])
