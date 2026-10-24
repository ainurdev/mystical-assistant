"""bridge.shots: the pictures each session's tools handed back lately (the
tool_done events' `images`), for the sidebar's unseen-picture tag.
Run: python -m pytest tests/test_shots.py -v"""

import os
import sys
import time
import uuid
from contextlib import closing

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import shots, store  # noqa: E402


def _turn(chat_id, started=None, done=True):
    store.init()
    sid = store.create_session(chat_id, "/proj")["id"]
    tid = uuid.uuid4().hex
    store.start_turn(sid, tid, "p", None)
    if done:
        store.finish_turn(tid, "done", None, 1)
    if started is not None:
        with closing(store._connect()) as c:
            c.execute("UPDATE turns SET started=? WHERE id=?", (started, tid))
    return sid, tid


def _pic(sid, tid, path, ts=None):
    seq = store.append_event(sid, tid, {"type": "tool_done", "id": "toolu_x", "stat": "image", "images": [path]})
    if ts is not None:
        with closing(store._connect()) as c:
            c.execute("UPDATE events SET ts=? WHERE session_id=? AND seq=?", (ts, sid, seq))


def test_lists_a_sessions_tool_pictures_oldest_first():
    sid, tid = _turn(500)
    now = time.time()
    _pic(sid, tid, "/u/t/mcp-toolu_b-0.png", now - 5)
    _pic(sid, tid, "/u/t/toolu_a-clip.webm", now - 9)
    store.append_event(sid, tid, {"type": "tool_done", "id": "toolu_c", "stat": "ok"})  # no picture
    store.append_event(sid, tid, {"type": "tool", "id": "toolu_d", "images": ["/u/t/not-a-result.png"]})

    assert shots.since(500, now - 60)[sid] == [["/u/t/toolu_a-clip.webm", now - 9],
                                               ["/u/t/mcp-toolu_b-0.png", now - 5]]


def test_only_this_chats_sessions_count():
    sid, tid = _turn(502)
    _pic(sid, tid, "/u/t/mcp-toolu_x-0.png")

    assert sid not in shots.since(503, 0)


def test_pictures_before_since_are_left_out():
    sid, tid = _turn(504)
    _pic(sid, tid, "/u/t/mcp-toolu_y-0.png", time.time() - 3600)

    assert sid not in shots.since(504, time.time() - 60)
    assert sid in shots.since(504, time.time() - 7200)


def test_a_turn_still_running_from_before_since_counts():
    sid, tid = _turn(505, started=time.time() - 2 * 86400, done=False)
    _pic(sid, tid, "/u/t/mcp-toolu_r-0.png")

    assert sid in shots.since(505, time.time() - 86400)


def test_asking_further_back_than_a_week_is_clamped():
    sid, tid = _turn(506, started=time.time() - 8 * 86400)
    _pic(sid, tid, "/u/t/mcp-toolu_z-0.png", time.time() - 8 * 86400)

    assert sid not in shots.since(506, 0)
