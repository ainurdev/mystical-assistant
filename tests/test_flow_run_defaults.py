"""Each flow's run defaults (model, mode, effort, trim, style) on the bridge, over POST /local/flows:
REFACTOR starts as BUILD's, a browser's kind presets carry over once, Reset unsets the run.
Run: python -m pytest tests/test_flow_run_defaults.py -v"""

import pytest

from bridge import aifeatures, config, flowsettings, store

store.init()


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BRIDGE_DB", str(tmp_path / "bridge.db"))
    monkeypatch.setattr(aifeatures, "_cache", None)
    flowsettings._cache.clear()
    yield
    monkeypatch.setattr(aifeatures, "_cache", None)
    flowsettings._cache.clear()


def _post(monkeypatch, body):
    from bridge.dashboard import server as dash
    monkeypatch.setattr(dash, "_chat", lambda: 1)
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    h._post_api("/local/flows", body)  # noqa: SLF001
    assert box["code"] == 200, box
    return {f["id"]: f for f in box["obj"]["flows"]}


def test_refactor_starts_as_build(monkeypatch):
    fl = _post(monkeypatch, {"flow": "ask", "key": "on", "value": True})
    assert fl["refactor"]["run"] == fl["build"]["run"] == {
        "model": "claude-opus-5-5", "mode": "bypassPermissions", "effort": "max", "trim": "", "style": ""}


def test_refactor_takes_builds_carried_preset(monkeypatch):
    fl = _post(monkeypatch, {"presets": {"build": {"model": "claude-sonnet-5-5", "effort": "high"}}})
    assert fl["refactor"]["run"] == fl["build"]["run"]
    assert fl["refactor"]["run"]["model"] == "claude-sonnet-5-5"


def test_a_saved_run_is_what_a_send_reads_until_reset(monkeypatch):
    _post(monkeypatch, {"flow": "fix", "key": "trim", "value": "lite"})
    flowsettings._cache.clear()                                  # a restart
    assert flowsettings.run("fix")["trim"] == "lite"
    fl = _post(monkeypatch, {"reset": "fix"})
    assert fl["fix"]["run_saved"] is False and flowsettings.run("fix") == flowsettings.BUILT_IN["fix"]


def test_a_flows_style_is_saved_and_unset_follows_the_session(monkeypatch):
    """Style "" is the Mode row's "Session": the session's own style runs."""
    fl = _post(monkeypatch, {"flow": "ask", "key": "on", "value": True})
    assert fl["ask"]["run"]["style"] == ""
    fl = _post(monkeypatch, {"flow": "ask", "key": "style", "value": "Explanatory"})
    assert fl["ask"]["run"]["style"] == "Explanatory"
    with pytest.raises(ValueError):
        flowsettings.change({"flow": "ask", "key": "style", "value": "two\nlines"})


def test_a_run_saved_before_styles_reads_as_the_sessions(monkeypatch):
    import json
    _post(monkeypatch, {"flow": "fix", "key": "trim", "value": "lite"})
    with open(flowsettings._file()) as f:
        saved = json.load(f)
    del saved["flows"]["fix"]["run"]["style"]
    with open(flowsettings._file(), "w") as f:
        json.dump(saved, f)
    flowsettings._cache.clear()                                  # a restart on the old file
    assert flowsettings.run("fix")["style"] == ""
    fl = _post(monkeypatch, {"flow": "ask", "key": "on", "value": True})
    assert fl["fix"]["run"]["style"] == "" and fl["fix"]["run"]["trim"] == "lite"
