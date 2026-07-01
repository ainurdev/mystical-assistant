"""Unit tests for the memory action layer shared by both HTTP servers
(Keep/Skip, pin, edit, status, list) with owner scoping.
Run: `python tests/test_memory_actions.py`
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import memory, store  # noqa: E402

store.init()


def test_keep_add_candidate_activates():
    o = 5001
    m = store.add_memory(o, "project", "convention", "c", "b", project_path="/p", status="candidate")
    out = memory.keep_or_skip(o, m["id"], "keep")
    assert out["status"] == "active"


def test_keep_update_candidate_archives_its_target():
    o = 5002
    target = store.add_memory(o, "project", "goal", "old", "b",
                              project_path="/p", branch="feat", status="active")
    cand = store.add_memory(o, "project", "goal", "new", "b", project_path="/p",
                            branch="feat", status="candidate", supersedes_id=target["id"])
    memory.keep_or_skip(o, cand["id"], "keep")
    assert store.get_memory(cand["id"])["status"] == "active"
    assert store.get_memory(target["id"])["status"] == "archived"


def test_skip_archives_candidate():
    o = 5003
    m = store.add_memory(o, "project", "gotcha", "g", "b", project_path="/p", status="candidate")
    memory.keep_or_skip(o, m["id"], "skip")
    assert store.get_memory(m["id"])["status"] == "archived"


def test_actions_reject_other_owner():
    m = store.add_memory(5004, "project", "convention", "c", "b", project_path="/p", status="candidate")
    assert memory.keep_or_skip(9999, m["id"], "keep") is None
    assert memory.set_pin(9999, m["id"], True) is None
    assert memory.set_status(9999, m["id"], "archived") is None
    assert memory.edit(9999, m["id"], "x", None) is None
    assert store.get_memory(m["id"])["status"] == "candidate"   # untouched


def test_pin_edit_status():
    o = 5005
    m = store.add_memory(o, "project", "decision", "d", "b", project_path="/p", status="active")
    assert memory.set_pin(o, m["id"], True)["pinned"] == 1
    assert memory.edit(o, m["id"], "new title", None)["title"] == "new title"
    assert memory.set_status(o, m["id"], "archived")["status"] == "archived"


def test_items_returns_owner_active_by_default():
    o = 5006
    store.add_memory(o, "project", "convention", "act", "b", project_path="/p", status="active")
    store.add_memory(o, "project", "convention", "cand", "b", project_path="/p", status="candidate")
    assert {r["title"] for r in memory.items(o)} == {"act"}


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
