"""bridge.flowsettings over GET and POST /local/flows: the FLOWS sheet's settings, kept on
the bridge, seeded from the switches they replace. Run: python -m pytest tests/test_flowsettings.py -v"""

import threading

import pytest

from bridge import aifeatures, config, flowsettings, paths, store

store.init()


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    """A settings file of its own per test, both caches dropped (as a restart would)."""
    monkeypatch.setattr(config, "BRIDGE_DB", str(tmp_path / "bridge.db"))
    monkeypatch.setattr(aifeatures, "_cache", None)
    flowsettings._cache.clear()
    yield
    monkeypatch.setattr(aifeatures, "_cache", None)
    flowsettings._cache.clear()


@pytest.fixture
def api(monkeypatch):
    from bridge.dashboard import server as dash
    monkeypatch.setattr(dash, "_chat", lambda: 1)
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001

    class A:
        def get(self):
            h._get_api("/local/flows", {})  # noqa: SLF001
            return box["obj"]

        def post(self, body):
            h._post_api("/local/flows", body)  # noqa: SLF001
            return box["obj"], box["code"]
    return A()


def _flow(st: dict, fl: str) -> dict:
    return next(f for f in st["flows"] if f["id"] == fl)


def _steps(f: dict) -> dict:
    return {s["step"]: s["on"] for s in f["steps"]}


def test_an_untouched_install_reads_as_todays_switches(api, monkeypatch):
    for env, v in (("ROUTER_ENABLE", True), ("ROUTER_AUTO", False), ("ROUTER_NEXT", False), ("ROUTER_ZONE", True),
                   ("TICKET_RUNS", True), ("TICKET_APPROVE", True), ("MERGE_REVIEW", False)):
        monkeypatch.setattr(config, env, v)
    st = api.get()
    assert (st["on"], st["autopick"], st["smartzone"], st["guess"], st["nokind"], st["presets"]) == \
        (True, False, True, "auto", "claude", False)
    for f in st["flows"]:
        assert f["on"] is True and f["next"] is False          # AUTO NEXT STEPS was off
        assert f["run"] == flowsettings.BUILT_IN[f["id"]] and f["run_saved"] is False
    for fl in flowsettings.TICKET_FLOWS:
        f = _flow(st, fl)
        assert (f["tickets"], f["approve"], _steps(f)["review"]) == (True, True, False)
    assert "tickets" not in _flow(st, "fix") and _steps(_flow(st, "fix"))["review"] is True
    assert [f["id"] for f in st["flows"]] == ["design", "build", "refactor", "fix", "ship", "ask"]
    assert _flow(st, "refactor")["run"] == flowsettings.BUILT_IN["build"]


def test_seeds_are_kept_once_read(api, monkeypatch):
    monkeypatch.setattr(config, "ROUTER_NEXT", True)
    assert flowsettings.next_auto("build") is True
    aifeatures.set_enabled("nextstep", False)          # the old switch no longer leads
    flowsettings._cache.clear()
    assert flowsettings.next_auto("build") is True


def test_a_change_round_trips_and_survives_a_restart(api):
    for body in ({"key": "guess", "value": "hand"}, {"key": "nokind", "value": "typed"},
                 {"flow": "build", "key": "on", "value": False}, {"flow": "build", "key": "next", "value": False},
                 {"flow": "build", "key": "step", "step": "audit", "value": False},
                 {"flow": "design", "key": "tickets", "value": True},
                 {"flow": "ask", "key": "effort", "value": "low"}):
        _st, code = api.post(body)
        assert code == 200, body
    flowsettings._cache.clear()
    st = api.get()
    b, a = _flow(st, "build"), _flow(st, "ask")
    assert (st["guess"], st["nokind"], b["on"], b["next"], _steps(b)["audit"]) == ("hand", "typed", False, False, False)
    assert _flow(st, "design")["tickets"] is True
    assert a["run"] == {**flowsettings.BUILT_IN["ask"], "effort": "low"} and a["run_saved"] is True
    assert flowsettings.flow_on("build") is False and flowsettings.steps("build")["build"] is True


def test_the_global_switches_keep_their_old_home(api):
    for key, feat in (("on", "router"), ("autopick", "autopick"), ("smartzone", "smartzone")):
        st, _ = api.post({"key": key, "value": False})
        assert st[key] is False and aifeatures.enabled(feat) is False
        st, _ = api.post({"key": key, "value": True})
        assert st[key] is True and aifeatures.enabled(feat) is True


def test_reset_puts_a_flow_back(api):
    api.post({"flow": "build", "key": "on", "value": False})
    api.post({"flow": "build", "key": "model", "value": "claude-sonnet-5-5"})
    api.post({"flow": "fix", "key": "on", "value": False})
    st, code = api.post({"reset": "build"})
    b = _flow(st, "build")
    assert code == 200 and b["on"] is True and b["run_saved"] is False and b["run"] == flowsettings.BUILT_IN["build"]
    assert _flow(st, "fix")["on"] is False                      # only that flow


def test_presets_are_taken_once_and_never_over_a_saved_run(api):
    api.post({"flow": "fix", "key": "effort", "value": "low"})
    st, code = api.post({"presets": {"build": {"model": "claude-sonnet-5-5", "perm": "plan"},
                                     "fix": {"effort": "high"}, "someday": {"model": "x"}}})
    assert code == 200 and st["presets"] is True
    assert _flow(st, "build")["run"] == {**flowsettings.BUILT_IN["build"], "model": "claude-sonnet-5-5", "mode": "plan"}
    assert _flow(st, "fix")["run"]["effort"] == "low"           # the sheet's run stays
    st, _ = api.post({"presets": {"ask": {"effort": "max"}}})   # a second browser's
    assert _flow(st, "ask")["run_saved"] is False


@pytest.mark.parametrize("body", [
    {"key": "nope", "value": True}, {"key": "guess", "value": "sometimes"}, {"key": "on", "value": "yes"},
    {"flow": "nope", "key": "on", "value": True}, {"flow": "build", "key": "colour", "value": "red"},
    {"flow": "build", "key": "step", "step": "build", "value": False},     # the step BUILD exists for
    {"flow": "build", "key": "step", "step": "design", "value": False},
    {"flow": "fix", "key": "tickets", "value": True}, {"flow": "build", "key": "next", "value": 1},
    {"flow": "build", "key": "effort", "value": "ludicrous"}, {"flow": "build", "key": "mode", "value": "yolo"},
    {"reset": "nope"}, {"presets": ["build"]}, {"presets": {"build": {"perm": "yolo"}}},
])
def test_bad_changes_are_refused(api, body):
    before = api.get()
    obj, code = api.post(body)
    assert code == 400 and obj["error"]
    assert api.get() == before


def test_ponytails_steps_are_marked_while_ponytail_is_off(api):
    aifeatures.set_enabled("ponytail", False)
    st = api.get()
    marked = {(f["id"], s["step"]) for f in st["flows"] for s in f["steps"] if s["ponytail_off"]}
    assert marked == {("build", "audit"), ("refactor", "audit"), ("fix", "review")}   # BUILD's review may be the council's
    aifeatures.set_enabled("ponytail", True)
    assert not any(s["ponytail_off"] for f in api.get()["flows"] for s in f["steps"])


@pytest.mark.parametrize("body", [{"key": "on", "value": True}, {"flow": "build", "key": "tickets", "value": True}])
def test_switching_flows_or_tickets_on_carries_ticket_sets_on(api, monkeypatch, body):
    from bridge import tickets
    booted = threading.Event()
    monkeypatch.setattr(tickets, "boot", booted.set)
    api.post(body)
    assert booted.wait(2)


def test_a_flow_switched_off_is_refused_and_a_running_one_finishes(api, monkeypatch, tmp_path):
    aifeatures.set_enabled("router", True)
    api.post({"flow": "fix", "key": "on", "value": False})
    assert "FIX is switched off" in paths.flow_refusal("fix", "you", "it crashes", "claude")
    assert paths.flow_refusal("build", "you", "add it", "claude") == ""
    # SetPath refuses it too, old name and all
    paths._cache.clear()
    store.init()   # this test's own DB
    s = store.create_session(1, "p")
    store.set_claude_session_id(s["id"], "cfs1")
    from bridge.dashboard import server as dash
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    h._post_api("/local/flow/set", {"claude_session_id": "cfs1", "path": "bug", "why": "crash"})  # noqa: SLF001
    assert "FIX is switched off" in box["obj"]["text"] and paths.get(s["id"]) is None
    # A queued prompt whose flow went off goes as typed; a session already on it keeps it.
    assert paths.start_flow(s["id"], "fix", "you", "it crashes") == "it crashes" and paths.get(s["id"]) is None
    api.post({"flow": "fix", "key": "on", "value": True})
    paths.set_path(s["id"], "fix", "crash", "you")
    api.post({"flow": "fix", "key": "on", "value": False})
    assert paths.step_done(s["id"], "t1") == "review"
    paths._cache.clear()
