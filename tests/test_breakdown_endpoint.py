"""Dashboard session-breakdown endpoint, driven without sockets via the
Handler.__new__ trick (mirrors test_graph_endpoints.py).
Run: python -m pytest tests/test_breakdown_endpoint.py -v"""

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


def _session(chat_id):
    store.init()
    return store.create_session(chat_id, "/proj")["id"]


def test_breakdown_endpoint_returns_the_sessions_attribution():
    sid = _session(config.DASH_CHAT_ID)
    store.start_turn(sid, f"{sid}:b1", "p", None)
    store.finish_turn(f"{sid}:b1", "done", None, 30)
    h, box = _handler()

    h._get_api(f"/local/sessions/{sid}/breakdown", {})

    assert box["code"] == 200
    assert box["obj"]["wall"] == 30
    assert box["obj"]["model_s"] == 30       # nothing else claimed the time


def test_breakdown_of_another_users_session_is_404():
    sid = _session(config.DASH_CHAT_ID + 1)
    h, box = _handler()

    h._get_api(f"/local/sessions/{sid}/breakdown", {})

    assert box["code"] == 404


def test_breakdown_of_an_unknown_session_is_404():
    h, box = _handler()

    h._get_api("/local/sessions/nope/breakdown", {})

    assert box["code"] == 404
