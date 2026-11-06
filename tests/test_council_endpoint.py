import pytest

from bridge import config, council, store
from bridge.dashboard import server as dash

store.init()


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    return h, box


def _sid(chat=None):
    return store.create_session(chat or config.DASH_CHAT_ID, "/counciltest", origin="dashboard")["id"]


def test_settings_routes():
    h, box = _handler()
    h._get_api("/local/council/settings", {})                          # noqa: SLF001
    assert box["code"] == 200 and box["obj"]["bar"] == 9.0
    h._post_api("/local/council/settings", {"bar": 12})                # noqa: SLF001
    assert box["obj"]["bar"] == 10.0
    h._post_api("/local/council/settings", {"bar": 9})                 # noqa: SLF001


def test_brief_route_idle():
    h, box = _handler()
    h._get_api(f"/local/council/{_sid()}", {})            # noqa: SLF001
    assert box["code"] == 200 and box["obj"]["status"] == "idle"


def test_run_route_calls_start_and_maps_errors(monkeypatch, tmp_path):
    sid, calls = _sid(), []
    store.set_work_cwd(sid, str(tmp_path))
    monkeypatch.setattr(council, "start", lambda s, cwd: calls.append((s["id"], cwd)) or {"status": "reviewing"})
    h, box = _handler()
    h._post_api(f"/local/council/{sid}", {"action": "run"})            # noqa: SLF001
    assert box["code"] == 200 and box["obj"] == {"status": "reviewing"} and calls == [(sid, str(tmp_path))]
    for code in ("running", "busy", "nothing", "action"):
        def boom(*a, code=code):
            raise ValueError(code)
        monkeypatch.setattr(council, "start", boom)
        monkeypatch.setattr(council, "act", boom)
        for action in ("run", "stop"):
            h._post_api(f"/local/council/{sid}", {"action": action})   # noqa: SLF001
            assert (box["code"], box["obj"]) == (409, {"error": code})


@pytest.mark.parametrize("method", ["get", "post"])
def test_unknown_session_is_404(method):
    other = _sid(999)
    h, box = _handler()
    for sid in ("nope", other):
        if method == "get":
            h._get_api(f"/local/council/{sid}", {})                    # noqa: SLF001
        else:
            h._post_api(f"/local/council/{sid}", {"action": "run"})    # noqa: SLF001
        assert box["code"] == 404 and box["obj"] == {"error": "no such session"}


def test_full_brief_uses_the_session_checkout(monkeypatch, tmp_path):
    sid, got = _sid(), []
    store.set_work_cwd(sid, str(tmp_path))
    monkeypatch.setattr(council, "brief", lambda s, cwd=None, full=False: got.append((cwd, full)) or {})
    h, box = _handler()
    h._get_api(f"/local/council/{sid}", {"full": ["1"]})               # noqa: SLF001
    assert box["code"] == 200 and got == [(str(tmp_path), True)]


def test_no_checkout_is_400(tmp_path):
    sid = _sid()
    store.set_work_cwd(sid, str(tmp_path / "gone"))
    h, box = _handler()
    h._post_api(f"/local/council/{sid}", {"action": "run"})            # noqa: SLF001
    assert (box["code"], box["obj"]) == (400, {"error": "the session has no checkout"})
    h._get_api(f"/local/council/{sid}", {"full": ["1"]})               # noqa: SLF001
    assert box["code"] == 400


def test_a_removed_worktree_falls_back_to_the_session_folder(monkeypatch, tmp_path):
    """#8: as the session's own turns do (runner): a gone work_cwd means its cwd, not a 400."""
    sid, got = _sid(), []
    store.set_cwd(sid, str(tmp_path))
    store.set_work_cwd(sid, str(tmp_path / "gone"))
    monkeypatch.setattr(council, "start", lambda s, cwd: got.append(cwd) or {"status": "reviewing"})
    monkeypatch.setattr(council, "brief", lambda s, cwd=None, full=False: got.append(cwd) or {})
    h, box = _handler()
    h._post_api(f"/local/council/{sid}", {"action": "run"})            # noqa: SLF001
    assert box["code"] == 200
    h._get_api(f"/local/council/{sid}", {"full": ["1"]})               # noqa: SLF001
    assert box["code"] == 200 and got == [str(tmp_path), str(tmp_path)]
