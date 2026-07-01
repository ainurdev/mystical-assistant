"""Unit tests for the learning_items store layer."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import store  # noqa: E402

store.init()


def test_add_and_get_learning_item():
    it = store.add_learning_item(555, "/proj", "useMemo dependency array",
                                 session_id="s1", source_turn_id="t1",
                                 code_snippet="useMemo(() => x, [x])",
                                 why_it_matters="stale closures")
    assert it["id"]
    assert it["status"] == "candidate"
    assert it["mastery"] == 0
    got = store.get_learning_item(it["id"])
    assert got["title"] == "useMemo dependency array"
    assert got["owner_id"] == 555
    assert got["project_path"] == "/proj"


def test_list_filters_by_owner_project_status():
    a = store.add_learning_item(700, "/p1", "A", status="kept")
    store.add_learning_item(700, "/p1", "B", status="candidate")   # wrong status
    store.add_learning_item(700, "/p2", "C", status="kept")        # wrong project
    store.add_learning_item(701, "/p1", "D", status="kept")        # wrong owner
    kept_p1 = store.list_learning_items(700, "/p1", status="kept")
    assert [i["title"] for i in kept_p1] == ["A"]
    assert a["id"] == kept_p1[0]["id"]
    # project_path=None → all projects for that owner+status
    all_kept = store.list_learning_items(700, None, status="kept")
    assert {i["title"] for i in all_kept} == {"A", "C"}


def test_status_transition_and_mastery():
    it = store.add_learning_item(555, "/proj", "closures")
    store.set_learning_status(it["id"], "kept")
    assert store.get_learning_item(it["id"])["status"] == "kept"
    store.bump_mastery(it["id"])
    store.bump_mastery(it["id"])
    row = store.get_learning_item(it["id"])
    assert row["mastery"] == 2
    assert row["times_reviewed"] == 2
    assert row["last_reviewed_at"] is not None


def test_append_note():
    it = store.add_learning_item(555, "/proj", "generics")
    store.append_learning_note(it["id"], "you confused T with any")
    assert "you confused T with any" in store.get_learning_item(it["id"])["notes"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
    print("all passed")
