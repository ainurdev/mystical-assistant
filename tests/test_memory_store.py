"""Unit tests for the project-memory store helpers (memories table).
Run: `python tests/test_memory_store.py`
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import store  # noqa: E402

store.init()


def test_add_and_get_roundtrip():
    m = store.add_memory(1001, "project", "convention", "pnpm not npm",
                         "Use pnpm; npm lockfiles are gitignored",
                         project_path="/p", branch=None)
    got = store.get_memory(m["id"])
    assert got is not None
    assert got["owner_id"] == 1001
    assert got["scope"] == "project"
    assert got["type"] == "convention"
    assert got["title"] == "pnpm not npm"
    assert got["status"] == "candidate"            # default
    assert got["pinned"] == 0
    assert got["project_path"] == "/p"
    assert got["branch"] is None


def test_user_scope_defaults():
    m = store.add_memory(1002, "user", "preference", "minimal diffs",
                         "Prefer surgical changes", status="active")
    got = store.get_memory(m["id"])
    assert got["scope"] == "user"
    assert got["project_path"] is None
    assert got["status"] == "active"
    assert got["use_count"] == 0
    assert got["supersedes_id"] is None


def test_list_memories_filters_by_scope_status_type():
    o = 1003
    store.add_memory(o, "project", "convention", "c1", "b", project_path="/p", status="active")
    store.add_memory(o, "project", "gotcha", "g1", "b", project_path="/p", status="active")
    store.add_memory(o, "project", "convention", "c2", "b", project_path="/p", status="candidate")
    active = store.list_memories(o, scope="project", project="/p", status="active")
    assert {r["title"] for r in active} == {"c1", "g1"}
    convs = store.list_memories(o, project="/p", type="convention")
    assert {r["title"] for r in convs} == {"c1", "c2"}


def test_set_status_and_pin():
    m = store.add_memory(1004, "project", "decision", "d", "b", project_path="/p")
    store.set_memory_status(m["id"], "active")
    store.set_pinned(m["id"], True)
    got = store.get_memory(m["id"])
    assert got["status"] == "active"
    assert got["pinned"] == 1


def test_update_memory_changes_fields_and_bumps_updated():
    m = store.add_memory(1005, "project", "decision", "old", "oldbody", project_path="/p")
    before = store.get_memory(m["id"])["updated_at"]
    store.update_memory(m["id"], title="new", body="newbody")
    got = store.get_memory(m["id"])
    assert got["title"] == "new"
    assert got["body"] == "newbody"
    assert got["updated_at"] >= before


def test_touch_memory_increments_use_count_only():
    m = store.add_memory(1006, "user", "preference", "p", "b", status="active")
    before = store.get_memory(m["id"])["updated_at"]
    store.touch_memory(m["id"])
    store.touch_memory(m["id"])
    got = store.get_memory(m["id"])
    assert got["use_count"] == 2
    assert got["last_used_at"] is not None
    assert got["updated_at"] == before            # touch must NOT bump updated_at (keeps pack stable)


def test_supersede_archives_old_and_creates_active_new():
    old = store.add_memory(1007, "project", "goal", "ship v1", "old goal",
                           project_path="/p", branch="feat", status="active")
    new = store.supersede_memory(old["id"], title="ship v2", body="new goal")
    assert store.get_memory(old["id"])["status"] == "archived"
    assert new["status"] == "active"
    assert new["title"] == "ship v2"
    assert new["type"] == "goal"                   # namespace inherited from old
    assert new["project_path"] == "/p"
    assert new["branch"] == "feat"


def test_resolve_cascade_user_project_branch():
    o = 1008
    store.add_memory(o, "user", "preference", "pref", "b", status="active")
    store.add_memory(o, "project", "convention", "proj", "b",
                     project_path="/p", branch=None, status="active")
    store.add_memory(o, "project", "goal", "goal", "b",
                     project_path="/p", branch="feat", status="active")
    # excluded from the /p@feat cascade:
    store.add_memory(o, "project", "goal", "other-branch", "b",
                     project_path="/p", branch="main", status="active")
    store.add_memory(o, "project", "convention", "other-proj", "b",
                     project_path="/q", status="active")
    store.add_memory(o, "project", "convention", "candidate", "b",
                     project_path="/p", status="candidate")
    resolved = store.resolve_memories(o, "/p", "feat")
    assert {r["title"] for r in resolved} == {"pref", "proj", "goal"}


def test_resolve_no_branch_sees_project_wide_only():
    o = 1011
    store.add_memory(o, "project", "convention", "wide", "b",
                     project_path="/p", branch=None, status="active")
    store.add_memory(o, "project", "goal", "branchy", "b",
                     project_path="/p", branch="feat", status="active")
    resolved = store.resolve_memories(o, "/p", None)
    assert {r["title"] for r in resolved} == {"wide"}


def test_resolve_excludes_other_owner():
    store.add_memory(2001, "project", "convention", "mine", "b",
                     project_path="/shared", status="active")
    store.add_memory(2002, "project", "convention", "theirs", "b",
                     project_path="/shared", status="active")
    resolved = store.resolve_memories(2001, "/shared", None)
    assert {r["title"] for r in resolved} == {"mine"}


def test_resolve_orders_pinned_first():
    o = 1009
    store.add_memory(o, "project", "convention", "plain", "b",
                     project_path="/p", status="active")
    store.add_memory(o, "project", "convention", "pinned", "b",
                     project_path="/p", status="active", pinned=True)
    resolved = store.resolve_memories(o, "/p", None)
    assert resolved[0]["title"] == "pinned"


def test_namespace_version_starts_zero_and_bumps_on_active_write():
    o = 1010
    assert store.namespace_version(o, "/p", "feat") == 0.0
    store.add_memory(o, "project", "goal", "g", "b",
                     project_path="/p", branch="feat", status="active")
    assert store.namespace_version(o, "/p", "feat") > 0.0


def test_namespace_version_ignores_candidates():
    o = 1012
    store.add_memory(o, "project", "convention", "c", "b",
                     project_path="/p", status="active")
    v = store.namespace_version(o, "/p", None)
    store.add_memory(o, "project", "convention", "cand", "b",
                     project_path="/p", status="candidate")
    assert store.namespace_version(o, "/p", None) == v   # candidate doesn't change the resident pack


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
