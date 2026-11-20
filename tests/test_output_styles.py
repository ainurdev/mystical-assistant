"""Output styles (bridge/outputstyles.py): which style a turn's claude runs with.

A session's Style is Claude Code's own `outputStyle` setting, passed per run in the
one --settings. Only chats you drive get one, and Not set passes nothing, so the
folder's own Claude settings decide."""
import json
import threading
import time

import pytest

from bridge import (accounts, config, models, profiles, project_config, queue_manager, runner, state, store,
                    titler, toolsets)

store.init()
CHAT = 556


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(accounts, "list_accounts", lambda: [{"slot": 1, "disabled": False}])
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-opus-5-5"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])
    monkeypatch.setattr(toolsets, "ready", lambda: True)
    monkeypatch.setattr(toolsets, "servers", lambda refresh=False: [])
    monkeypatch.setattr(runner, "_configured_mcp_servers", lambda cwd: {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    # A turn whose claude never started would be resumed or carried on: not here.
    monkeypatch.setattr(runner, "_maybe_auto_resume", lambda *a, **k: False)
    monkeypatch.setattr(runner, "_continue_after_turn", lambda *a, **k: False)


def _session(origin="dashboard", **fields):
    s = store.create_session(CHAT, "/os-proj", origin=origin, cwd=config.BASE_PATH)
    for k, v in fields.items():
        store.set_session_field(s["id"], k, v)
    return s


def _settings(monkeypatch, start=None, **kw) -> dict:
    """The one --settings the turn's claude child is started with ({} = none). The turn
    is start_streaming_job(**kw)'s, or the one `start` sets off (it returns the session id)."""
    got, spawned, real = {}, threading.Event(), runner.subprocess.Popen

    def popen(cmd, **opts):
        if cmd[:2] != [runner.claude_bin(), "-p"]:
            return real(cmd, **opts)          # git and friends run as usual
        got["cmd"] = cmd
        spawned.set()
        raise FileNotFoundError

    monkeypatch.setattr(runner.subprocess, "Popen", popen)
    sid = start() if start else runner.start_streaming_job(
        CHAT, "go", [], project=config.BASE_PATH, **kw).store_session_id
    assert spawned.wait(10), "claude never started"
    end = time.time() + 10
    while state.is_running(sid) and time.time() < end:
        time.sleep(0.01)                      # its turn has ended before the next test starts
    cmd = got["cmd"]
    return json.loads(cmd[cmd.index("--settings") + 1]) if "--settings" in cmd else {}


def test_a_style_picked_in_a_chat_you_drive_reaches_claude(monkeypatch):
    s = _session(style="Explanatory")
    assert _settings(monkeypatch, session_id=s["id"])["outputStyle"] == "Explanatory"


def test_not_set_passes_no_style_so_the_folders_own_setting_decides(monkeypatch):
    s = _session()
    assert "outputStyle" not in _settings(monkeypatch, session_id=s["id"])


@pytest.mark.parametrize("origin", ["ticket", "ticket-merge", "helper", "automation",
                                    "rivendell:w1", "device-run", "preview-queue", None])
def test_a_session_nobody_watches_gets_no_style(monkeypatch, origin):
    """Learning leaves a TODO(human) and waits: in a Part nobody watches, its flow
    could merge the half-written code."""
    s = _session(origin=origin, style="Learning")
    assert "outputStyle" not in _settings(monkeypatch, session_id=s["id"])


@pytest.mark.parametrize("origin", ["dashboard", "miniapp", "bot", "vscode", "terminal", "browser", "work"])
def test_every_chat_you_drive_takes_its_style(monkeypatch, origin):
    s = _session(origin=origin, style="Concise")
    assert _settings(monkeypatch, session_id=s["id"])["outputStyle"] == "Concise"


def test_an_internal_one_shot_gets_no_style(monkeypatch):
    s = _session(style="Learning")
    assert "outputStyle" not in _settings(monkeypatch, session_id=s["id"], skip_pack=True)


def test_a_profiles_style_is_followed_and_a_pick_in_the_session_wins(monkeypatch):
    p = profiles.create({"name": "P", "account": "1", "style": "Learning"})

    def bound(**fields):
        s = store.create_session(CHAT, "/os-proj", origin="dashboard", cwd=config.BASE_PATH,
                                 profile_id=p["id"])
        for k, v in fields.items():
            store.set_session_field(s["id"], k, v)
        return s["id"]
    assert _settings(monkeypatch, session_id=bound())["outputStyle"] == "Learning"
    assert _settings(monkeypatch, session_id=bound(style="Concise"))["outputStyle"] == "Concise"


def test_a_lit_flows_style_beats_the_sessions_pick(monkeypatch):
    s = _session(style="Concise")
    assert _settings(monkeypatch, session_id=s["id"], style="Proactive")["outputStyle"] == "Proactive"


def test_a_flow_prompt_that_waits_in_the_queue_keeps_its_style(monkeypatch):
    s = _session(style="Concise")
    q = queue_manager.PreviewQueue(run_fn=queue_manager._default_run_fn, persist_path=None)

    def start():
        q.enqueue(s["id"], text="go", prompt="go", images=[], model=None, effort=None,
                  permission_mode=None, width=0, sel=[], surface="dashboard", chat_id=CHAT,
                  project=config.BASE_PATH, style="Learning")
        return s["id"]
    assert _settings(monkeypatch, start=start)["outputStyle"] == "Learning"


# --- what a picker offers (outputstyles.available) -------------------------------------

def _style(folder, stem, name=None, description=None):
    d = folder / ".claude" / "output-styles"
    d.mkdir(parents=True, exist_ok=True)
    front = "".join(f"{k}: {v}\n" for k, v in (("name", name), ("description", description)) if v)
    (d / f"{stem}.md").write_text((f"---\n{front}---\n" if front else "") + "Answer like this.\n")


def test_the_list_is_claudes_built_ins_then_yours_with_the_nearest_folder_winning(monkeypatch, tmp_path):
    from bridge import outputstyles
    home, repo = tmp_path / "home", tmp_path / "repo"
    app = repo / "app"
    (repo / ".git").mkdir(parents=True)
    app.mkdir()
    _style(home, "terse", "Terse", "yours, everywhere")
    _style(tmp_path, "above", "Above")                  # past the repo root: not this folder's
    _style(repo, "comms", "Comms", "the repo's")
    _style(app, "comms-app", "Comms", "the app folder's")
    _style(app, "review")                               # no frontmatter: named for its file
    monkeypatch.setattr(outputstyles, "USER_DIR", str(home / ".claude" / "output-styles"))
    got = outputstyles.available(str(app))
    assert [s["id"] for s in got] == ["default", "Proactive", "Concise", "Explanatory", "Learning",
                                      "Comms", "review", "Terse"]
    by = {s["id"]: s for s in got}
    assert (by["Comms"]["description"], by["Comms"]["source"]) == ("the app folder's", "folder")
    assert (by["Terse"]["source"], by["Proactive"]["source"]) == ("user", "built-in")
    assert [s["id"] for s in outputstyles.available(None)][-1] == "Terse"   # no folder: yours only


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_both_apps_offer_the_sessions_folder_styles(monkeypatch, tmp_path, surface):
    from bridge import outputstyles
    from bridge.dashboard import server as dash
    from bridge.miniapp import server as mini
    monkeypatch.setattr(outputstyles, "USER_DIR", str(tmp_path / "none"))
    folder = tmp_path / "proj"
    (folder / ".git").mkdir(parents=True)
    _style(folder, "comms", "Comms")
    mine = store.create_session(CHAT, "/os-list", origin="dashboard", cwd=str(folder))
    other = store.create_session(999, "/os-list-other", origin="dashboard", cwd=str(folder))

    def get(qs):
        mod = dash if surface == "dashboard" else mini
        h, box = mod.Handler.__new__(mod.Handler), {}
        h._json = lambda obj, code=200: box.update(obj=obj, code=code)
        if surface == "dashboard":
            from urllib.parse import parse_qs
            monkeypatch.setattr(dash, "_chat", lambda: CHAT)
            h._get_api("/local/styles", parse_qs(qs.lstrip("?")))
        else:
            h._auth = lambda: CHAT
            h.path = "/api/styles" + qs
            h.do_GET()
        return box
    box = get(f"?session={mine['id']}")
    assert box["code"] == 200 and box["obj"]["styles"][-1]["id"] == "Comms"
    assert "Comms" not in [s["id"] for s in get("")["obj"]["styles"]]       # a profile's, a flow's
    assert get(f"?session={other['id']}")["code"] == 404


def test_a_profile_takes_a_style_and_refuses_a_bad_one():
    out, code = profiles.api_write({"action": "create", "name": "S", "style": "Explanatory"})
    assert code == 200 and out["profile"]["style"] == "Explanatory"
    out, code = profiles.api_write({"action": "update", "id": out["profile"]["id"], "style": ""})
    assert code == 200 and out["profile"]["style"] == ""                     # Not set
    assert profiles.api_write({"action": "create", "name": "B", "style": "a\nb"})[1] == 400


def test_a_brief_says_whether_its_turns_take_a_style():
    """The STYLE chip shows only where a pick would reach Claude."""
    from bridge.miniapp.server import _session_brief
    assert _session_brief(store.get_session(_session(style="Learning")["id"]))["takes_style"] is True
    part = _session(origin="ticket", style="Learning")
    assert _session_brief(store.get_session(part["id"]))["takes_style"] is False
