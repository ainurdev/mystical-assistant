"""flow-gear 07: the routing text every run carries follows the FLOWS settings (NO KIND,
which flows are on, BUILD's and DESIGN's grill), and a BUILD Claude picks with its grill
off still builds on its own branch. Run: python -m pytest tests/test_flow_routing.py -v"""

from types import SimpleNamespace

import pytest

from bridge import aifeatures, config, flowsettings, paths, runner, store


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    """A DB, flows.json and flow_settings.json of its own per test, caches dropped."""
    monkeypatch.setattr(config, "BRIDGE_DB", str(tmp_path / "bridge.db"))
    store.init()
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "ponytail"))
    flowsettings._cache.clear()
    paths._cache.clear()
    paths._pack_ok.clear()
    yield
    flowsettings._cache.clear()
    paths._cache.clear()
    paths._pack_ok.clear()


def _session(cid: str, origin: str = "") -> str:
    s = store.create_session(1, "p", **({"origin": origin} if origin else {}))
    store.set_claude_session_id(s["id"], cid)
    return s["id"]


def _text(cid: str = "c1") -> str:
    return runner._compose_system_prompt(paths_pack=paths.pack_for(cid))  # noqa: SLF001


def _line(text: str, flow: str) -> str:
    return next(ln for ln in text.splitlines() if ln.startswith(f"- {flow}: "))


def test_claude_picks_lists_only_the_flows_that_are_on(monkeypatch):
    _session("c1")
    t = paths.pack_for("c1")
    for fl in ("design", "build", "refactor", "fix", "one"):
        assert f"\n- {fl}: " in t
    assert "\n- ship: " not in t and "\n- ask: " not in t
    flowsettings.change({"flow": "refactor", "key": "on", "value": False})
    flowsettings.change({"flow": "ship", "key": "on", "value": False})
    t = paths.pack_for("c1")
    assert "\n- refactor: " not in t and "\n- build: " in t and "\n- one: " in t
    assert "StepDone" in t


def test_each_flow_starts_at_its_first_step_as_set():
    _session("c1")
    assert "grill-with-docs" in _line(paths.pack_for("c1"), "build")
    flowsettings.change({"flow": "build", "key": "step", "step": "grill", "value": False})
    flowsettings.change({"flow": "design", "key": "step", "step": "grill", "value": False})
    t = paths.pack_for("c1")
    assert "grill-with-docs" not in _line(t, "build") and "SetPath" in _line(t, "build")
    assert "design-first skill (named just design-first" in _line(t, "design") and "grill-with-docs" not in _line(t, "design")
    assert "diagnosing-bugs" in _line(t, "fix")


def test_as_typed_leaves_the_routing_out_and_keeps_stepdone():
    _session("c1")
    flowsettings.change({"key": "nokind", "value": "typed"})
    t = paths.pack_for("c1")
    assert "\n- build: " not in t and "\n- one: " not in t and "decide whether" not in t
    assert "make StepDone the last tool call" in t
    assert 'If the message begins "No path for this message."' not in t


def test_the_text_is_one_per_settings_state():
    _session("c1")
    a, b = _text(), _text()
    assert a == b                                   # every turn: one cache write per change
    flowsettings.change({"flow": "fix", "key": "on", "value": False})
    c = _text()
    assert c != a and c == _text()
    flowsettings.change({"flow": "fix", "key": "on", "value": True})
    assert _text() == a


def test_flows_off_carries_no_routing(monkeypatch):
    _session("c1")
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)
    assert paths.pack_for("c1") == ""


@pytest.mark.parametrize("origin", ["bot", "miniapp"])
def test_telegram_and_the_mini_app_follow_no_kind(origin):
    _session("c-dash")
    _session("c-phone", origin)
    assert paths.pack_for("c-phone") == paths.pack_for("c-dash") and "\n- build: " in paths.pack_for("c-phone")
    flowsettings.change({"key": "nokind", "value": "typed"})
    assert "\n- build: " not in paths.pack_for("c-phone") and "StepDone" in paths.pack_for("c-phone")


@pytest.fixture
def server(monkeypatch):
    from bridge.dashboard import server as dash
    monkeypatch.setattr(dash, "_chat", lambda: 1)
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    return lambda path, body: (h._post_api(path, body), box["obj"])[1]  # noqa: SLF001


def test_a_build_claude_picks_with_its_grill_off_builds_on_its_own_branch(server, monkeypatch):
    from bridge import flowbranch, queue_manager
    sid = _session("cf1")
    store.start_turn(sid, "t1", "add a thing", None)
    flowsettings.change({"flow": "build", "key": "step", "step": "grill", "value": False})
    assert server("/local/flow/set", {"claude_session_id": "cf1", "path": "build", "why": "new"}) == \
        {"text": "Path recorded: build-here. End your turn now: the build starts on its own branch when it ends."}
    f = paths.get(sid)
    assert f["path"] == "build-here" and f["done"] == ["grill"] and f["next"]["station"] == "build-here"
    q = []
    monkeypatch.setattr(queue_manager, "enqueue", lambda s, **kw: q.append(kw["prompt"]))
    monkeypatch.setattr(store, "get_session", lambda s: {"cwd": "/p", "chat_id": 1, "title": "A Thing", "project": "p"})
    monkeypatch.setattr(flowbranch, "flow_files", lambda s, since: [])
    monkeypatch.setattr(flowbranch, "ensure_feature_branch", lambda s, slug, prefix: (f"{prefix}/{slug}", "/wt"))
    monkeypatch.setattr(flowbranch, "carry_and_commit", lambda *a, **k: True)
    monkeypatch.setattr(store, "set_cwd", lambda *a: None)
    monkeypatch.setattr(store, "set_work_cwd", lambda *a: None)
    job = SimpleNamespace(store_session_id=sid, id="t1", status="done", interrupted=False, runtime=None, chat_id=1)
    assert paths.continue_after_turn(job) is True
    assert q == ["/mattpocock-skills:implement Work in /wt on branch feat/a-thing, and commit there."]


def test_a_design_claude_picks_with_its_grill_off_starts_at_design(server):
    sid = _session("cf1")
    store.start_turn(sid, "t1", "redo the header", None)
    flowsettings.change({"flow": "design", "key": "step", "step": "grill", "value": False})
    server("/local/flow/set", {"claude_session_id": "cf1", "path": "design", "why": "looks"})
    f = paths.get(sid)
    assert f["path"] == "design-here" and f["done"] == ["grill"] and f["next"] is None
    assert paths.step_done(sid, "t1") == "build-here"    # Approve's StepDone: the build follows
