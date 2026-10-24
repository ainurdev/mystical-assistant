"""Dashboard GET /local/shots, driven without sockets via the Handler.__new__
trick (mirrors test_breakdown_endpoint.py).
Run: python -m pytest tests/test_shots_endpoint.py -v"""

import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_shots_endpoint_answers_the_dashboards_pictures():
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "/proj")["id"]
    tid = uuid.uuid4().hex
    store.start_turn(sid, tid, "p", None)
    pic = os.path.join(config.UPLOAD_DIR, tid, "mcp-toolu_q-0.png")
    store.append_event(sid, tid, {"type": "tool_done", "id": "toolu_q", "images": [pic]})
    h, box = _handler()

    h._get_api("/local/shots", {"since": [str(time.time() - 60)]})

    assert box["code"] == 200
    assert [p for p, _ in box["obj"][sid]] == [pic]


def test_shots_endpoint_rejects_a_since_that_is_not_a_number():
    h, box = _handler()

    h._get_api("/local/shots", {"since": ["yesterday"]})

    assert box["code"] == 400
