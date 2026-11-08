"""The dashboard's Rivendell queue route (bridge/dashboard/server.py).

Socket-free via Handler.__new__ (the test_rivendell_tasks_endpoint.py pattern).
Run: python -m pytest tests/test_queue_endpoints.py -v"""

import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import rivendell, rivendell_instances  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def dget(path):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    u = urlparse(path)
    h._get_api(u.path, parse_qs(u.query))
    return box


def test_rivendell_queue_lists_held_and_running_rows(monkeypatch):
    monkeypatch.setattr(rivendell_instances, "instances", lambda: [{"id": "w1", "name": "prod"}])
    monkeypatch.setattr(rivendell, "queue", lambda: {"w1": [
        {"key": "impl:r1", "kind": "impl", "request_id": "r1", "slug": "acme/app", "step": None,
         "created_at": 2.0, "label": "Login fixes", "link": None, "mode": "queue"}]})
    monkeypatch.setattr(rivendell, "running", lambda: [
        {"instance_id": "w1", "key": "impl:r0", "kind": "impl", "request_id": "r0", "slug": "acme/app",
         "label": "Earlier", "link": "https://rv/s/0", "session_id": "sess-0", "created_at": 1.0}])

    r = dget("/local/rivendell/queue")
    assert r["code"] == 200
    assert [(x["status"], x["request_id"], x["instance"]) for x in r["obj"]["queue"]] == [
        ("running", "r0", "prod"), ("held", "r1", "prod")]
    assert r["obj"]["queue"][0]["session_id"] == "sess-0" and r["obj"]["queue"][0]["link"] == "https://rv/s/0"


def _enqueue(monkeypatch, body):
    from bridge import queue_manager
    got = {}
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: got.update(kw) or "q1")
    monkeypatch.setattr(queue_manager, "snapshot", lambda sid: {})
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._queue("enqueue", 1, {"session_id": "s1", "prompt": "hi", **body})
    return box, got


def test_enqueue_carries_a_kinds_model_and_mode(monkeypatch):
    box, got = _enqueue(monkeypatch, {"model": "opus", "permission_mode": "plan"})
    assert box["code"] == 200
    assert got["model"] and got["permission_mode"] == "plan"


def test_enqueue_without_model_or_mode_keeps_none(monkeypatch):
    box, got = _enqueue(monkeypatch, {})
    assert box["code"] == 200 and got["model"] is None and got["permission_mode"] is None


def test_enqueue_refuses_a_bad_model_or_mode(monkeypatch):
    assert _enqueue(monkeypatch, {"model": "nope"})[0]["code"] == 400
    assert _enqueue(monkeypatch, {"permission_mode": "nope"})[0]["code"] == 400
