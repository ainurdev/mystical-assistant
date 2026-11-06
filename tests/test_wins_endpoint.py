"""Dashboard today's-wins endpoint, socketless via the Handler.__new__ trick
(mirrors test_report_endpoint.py).
Run: python -m pytest tests/test_wins_endpoint.py -v"""

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


def test_wins_endpoint_returns_todays_spine():
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "/proj-wins-endpoint")["id"]
    store.start_turn(sid, f"{sid}:1", "p", None)
    store.append_event(sid, f"{sid}:1", {"type": "tool", "name": "Bash", "id": "toolu_ep1",
                                         "summary": "gh pr create", "detail": 'gh pr create --title "x"'})
    store.append_event(sid, f"{sid}:1", {"type": "tool_done", "id": "toolu_ep1",
                                         "output": "https://github.com/a/b/pull/7", "is_error": False, "ms": 9})
    store.finish_turn(f"{sid}:1", "done", None, 30)
    h, box = _handler()

    h._get_api("/local/wins", {})

    assert box["code"] == 200
    assert set(box["obj"]) >= {"since", "now", "wins", "work", "away", "worked"}
    assert any(w["kind"] == "pr" and w["text"] == "#7" and w["big"] for w in box["obj"]["wins"])
