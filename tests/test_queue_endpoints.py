"""The QUEUE tab's two dashboard routes (bridge/dashboard/server.py).

Socket-free via Handler.__new__ (the test_rivendell_tasks_endpoint.py pattern).
Run: python -m pytest tests/test_queue_endpoints.py -v"""

import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import queue_manager, rivendell, rivendell_instances, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402
from bridge.queue_manager import PreviewQueue  # noqa: E402


def dget(path):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    u = urlparse(path)
    h._get_api(u.path, parse_qs(u.query))
    return box


def _enq(q, sid, **kw):
    q.enqueue(sid, text=kw.get("text", "x"), prompt="x", images=[], model=None, effort=None,
              permission_mode=None, width=0, sel=[], surface="rivendell", chat_id=555,
              project="/p", label=kw.get("label"), link=kw.get("link"), ref=kw.get("ref"))


def test_queue_all_lists_this_projects_sessions_and_skips_rows_the_store_lost(monkeypatch):
    """Review focus 5: a bucket whose session row is gone is left out, not a crash."""
    q = PreviewQueue(run_fn=lambda item: None, persist_path=None)   # busy runner: items stay queued
    monkeypatch.setattr(queue_manager, "_instance", q)
    for sid in ("s-here", "s-there", "s-gone"):
        _enq(q, sid, label="L", link="https://rv", ref="w:r")
    rows = {"s-here": {"id": "s-here", "title": "Login fixes", "project": "acme/app"},
            "s-there": {"id": "s-there", "title": "Other", "project": "acme/other"}}
    monkeypatch.setattr(store, "get_session", lambda sid: rows.get(sid))

    r = dget("/local/queue/all?project=acme/app")
    assert r["code"] == 200
    [s] = r["obj"]["sessions"]
    assert s["session_id"] == "s-here" and s["title"] == "Login fixes" and s["paused"] is False
    assert s["items"][0]["label"] == "L" and s["items"][0]["link"] == "https://rv" and s["items"][0]["ref"] == "w:r"

    everything = dget("/local/queue/all")["obj"]["sessions"]
    assert sorted(s["session_id"] for s in everything) == ["s-here", "s-there"]


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
