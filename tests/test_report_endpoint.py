"""Dashboard weekly-report endpoint, socketless via the Handler.__new__ trick
(mirrors test_breakdown_endpoint.py).
Run: python -m pytest tests/test_report_endpoint.py -v"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_report_endpoint_returns_the_weekly_rollup():
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "/proj-endpoint")["id"]
    store.start_turn(sid, f"{sid}:1", "p", None)
    store.finish_turn(f"{sid}:1", "done", None, 30)
    h, box = _handler()

    h._get_api("/local/report", {})

    assert box["code"] == 200
    assert box["obj"]["totals"]["turns"] >= 1
    assert any(p["project"] == "/proj-endpoint" for p in box["obj"]["projects"])
    assert "prev" in box["obj"] and "days" in box["obj"]
