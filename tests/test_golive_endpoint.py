"""The rail's ⟳ routes: GET /local/live reads selfupdate.live(); POST /local/live/build
runs one app's build; POST /local/live/after arms or drops the wait for the turns."""

from bridge import selfupdate
from bridge.dashboard import server as dash


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_live_answers_what_is_behind(monkeypatch):
    monkeypatch.setattr(selfupdate, "live", lambda: {"repo": True, "parts": [{"key": "bridge"}]})
    h, box = _handler()
    h._get_api("/local/live", {})
    assert box == {"obj": {"repo": True, "parts": [{"key": "bridge"}]}, "code": 200}


def test_build_runs_the_app_it_names(monkeypatch):
    seen = []
    monkeypatch.setattr(selfupdate, "build", lambda key: (seen.append(key), {"ok": True, "output": "", "seconds": 9})[1])
    h, box = _handler()
    h._post_api("/local/live/build", {"ui": "dashboard"})
    h._post_api("/local/live/build", {})
    assert seen == ["dashboard", ""] and box["obj"]["seconds"] == 9


def test_after_arms_and_cancel_drops(monkeypatch):
    calls = []
    monkeypatch.setattr(selfupdate, "after", lambda cancel=False: calls.append(cancel))
    h, box = _handler()
    h._post_api("/local/live/after", {})
    h._post_api("/local/live/after", {"cancel": True})
    assert calls == [False, True] and box["obj"] == {"ok": True}
