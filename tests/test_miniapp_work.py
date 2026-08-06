"""The Mini App's WORK tab endpoints: /api/queue (list + ops) and /api/goal.

Both are new surfaces onto machinery the dashboard already had (queue_manager,
goals), so what's worth checking here is the boundary the Mini App adds: a chat
only ever sees its OWN sessions' queues and goals. Driven without sockets via
Handler.__new__, mirroring test_miniapp_files.py.

Run: python tests/test_miniapp_work.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import goals, queue_manager, store  # noqa: E402
from bridge.miniapp import server as mini  # noqa: E402

store.init()

CHAT = 555
OTHER = 999


def _handler():
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _session(chat_id=CHAT):
    return store.create_session(chat_id, "proj", origin="miniapp", cwd="/tmp")["id"]


def _queue():
    """A fresh queue whose runs go nowhere — nothing here should start Claude."""
    q = queue_manager.PreviewQueue(run_fn=lambda item: None)
    queue_manager._instance = q
    return q


def test_enqueue_then_list():
    _queue()
    sid = _session()
    h, box = _handler()
    h._api_queue_post(CHAT, {"op": "enqueue", "session_id": sid, "prompt": "ship it"})
    assert box["code"] == 200
    assert [i["text"] for i in box["obj"]["items"]] == ["ship it"]

    h._api_queue_get(CHAT)
    queues = box["obj"]["queues"]
    assert len(queues) == 1 and queues[0]["session_id"] == sid
    assert queues[0]["items"][0]["status"] == "queued"


def test_list_hides_another_chats_queue():
    _queue()
    mine, theirs = _session(), _session(OTHER)
    h, box = _handler()
    h._api_queue_post(CHAT, {"op": "enqueue", "session_id": mine, "prompt": "mine"})
    h._api_queue_post(OTHER, {"op": "enqueue", "session_id": theirs, "prompt": "theirs"})
    h._api_queue_get(CHAT)
    assert [q["session_id"] for q in box["obj"]["queues"]] == [mine]


def test_ops_on_a_foreign_session_are_not_found():
    _queue()
    theirs = _session(OTHER)
    h, box = _handler()
    h._api_queue_post(CHAT, {"op": "enqueue", "session_id": theirs, "prompt": "pwn"})
    assert box["code"] == 404
    assert queue_manager.snapshot(theirs)["items"] == []


def test_remove_takes_an_item_off():
    _queue()
    sid = _session()
    h, box = _handler()
    h._api_queue_post(CHAT, {"op": "enqueue", "session_id": sid, "prompt": "drop me"})
    item_id = box["obj"]["items"][0]["id"]
    h._api_queue_post(CHAT, {"op": "remove", "session_id": sid, "item_id": item_id})
    assert box["obj"]["items"] == []


def test_empty_prompt_is_rejected():
    _queue()
    sid = _session()
    h, box = _handler()
    h._api_queue_post(CHAT, {"op": "enqueue", "session_id": sid, "prompt": "   "})
    assert box["code"] == 400


def test_unknown_op_is_not_found():
    _queue()
    sid = _session()
    h, box = _handler()
    h._api_queue_post(CHAT, {"op": "detonate", "session_id": sid})
    assert box["code"] == 404


def test_goal_reads_the_sessions_objective():
    sid = _session()
    h, box = _handler()
    h._api_goal(CHAT, {"session": [sid]})
    assert box["obj"]["goal"] is None and box["obj"]["max_iter"] == goals.MAX_ITER

    goals.create(sid, "ship the redesign")
    h._api_goal(CHAT, {"session": [sid]})
    assert box["obj"]["goal"]["objective"] == "ship the redesign"


def test_goal_of_another_chat_is_not_found():
    theirs = _session(OTHER)
    goals.create(theirs, "secret")
    h, box = _handler()
    h._api_goal(CHAT, {"session": [theirs]})
    assert box["code"] == 404


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok - {fn.__name__}")
    print(f"\n{len(fns)} passed")
