"""Unit tests for project-memory retrieval + Context Pack rendering.
Run: `python tests/test_memory_inject.py`
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import config, memory, store  # noqa: E402

store.init()


def test_empty_pack_is_blank():
    assert memory.render_pack(3001, "/p", "feat") == ""


def test_pack_contains_active_cascade_not_candidates_or_other_scope():
    o = 3002
    store.add_memory(o, "user", "preference", "minimal diffs", "surgical", status="active")
    store.add_memory(o, "project", "convention", "pnpm-here", "use pnpm",
                     project_path="/p", status="active")
    store.add_memory(o, "project", "goal", "ship v2", "finish memory",
                     project_path="/p", branch="feat", status="active")
    store.add_memory(o, "project", "gotcha", "cand-only", "x", project_path="/p", status="candidate")
    store.add_memory(o, "project", "convention", "other-proj", "x", project_path="/q", status="active")
    pack = memory.render_pack(o, "/p", "feat")
    assert "minimal diffs" in pack
    assert "pnpm-here" in pack
    assert "ship v2" in pack
    assert "cand-only" not in pack      # candidate excluded
    assert "other-proj" not in pack     # other project excluded


def test_pack_is_byte_stable_until_memory_changes():
    o = 3003
    store.add_memory(o, "project", "convention", "c", "b", project_path="/p", status="active")
    a = memory.render_pack(o, "/p", None)
    b = memory.render_pack(o, "/p", None)
    assert a == b and a != ""
    store.add_memory(o, "project", "goal", "g", "b", project_path="/p", status="active")
    c = memory.render_pack(o, "/p", None)
    assert c != a                       # an active write changes the pack


def test_pack_budget_keeps_prefs_and_goals_drops_overflow():
    o = 3004
    store.add_memory(o, "user", "preference", "PREF-KEEP", "keep me", status="active")
    store.add_memory(o, "project", "goal", "GOAL-KEEP", "keep me",
                     project_path="/p", branch="feat", status="active")
    for i in range(60):
        store.add_memory(o, "project", "convention", f"conv{i}", "x" * 120,
                         project_path="/p", status="active")
    pack = memory.render_pack(o, "/p", "feat")
    assert "PREF-KEEP" in pack          # user prefs always kept
    assert "GOAL-KEEP" in pack          # active goals always kept
    kept = sum(1 for i in range(60) if f"conv{i}" in pack)
    assert 0 < kept < 60                # budget drops the overflow conventions
    assert memory._estimate_tokens(pack) <= config.MEMORY_TOKEN_BUDGET * 2


def test_retrieve_returns_active_cascade():
    o = 3005
    store.add_memory(o, "project", "convention", "c", "b", project_path="/p", status="active")
    store.add_memory(o, "project", "convention", "cand", "b", project_path="/p", status="candidate")
    got = memory.retrieve(o, "/p", None)
    assert [r["title"] for r in got] == ["c"]


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
