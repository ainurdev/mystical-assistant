"""Unit tests for memory.suggest (memory-grounded prompt ideas + cache).
Run: `python tests/test_memory_suggest.py`
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


def _seed(owner, project):
    store.add_memory(owner, "project", "convention", "use pnpm", "always pnpm",
                     project_path=project, branch=None, status="active")


def test_parse_suggestions_caps_three_and_trims():
    assert memory._parse_suggestions('["one","two","three","four"]') == ["one", "two", "three"]
    assert memory._parse_suggestions('```json\n["a","b"]\n```') == ["a", "b"]
    assert memory._parse_suggestions("not json") == []
    assert memory._parse_suggestions('{"a":1}') == []          # object, not array


def test_suggest_empty_pack_returns_empty_without_calling():
    o = 5001
    calls = []
    out = memory.suggest(o, "/nomem", None, run=lambda _p: calls.append(1) or '["x"]')
    assert out == [] and calls == []


def test_suggest_parses_and_caps_three():
    o = 5002
    _seed(o, "/p")
    raw = '["one","two","three","four","five"]'
    assert memory.suggest(o, "/p", None, run=lambda _p: raw) == ["one", "two", "three"]


def test_suggest_caches_by_version():
    o = 5003
    _seed(o, "/p")
    calls = []
    run = lambda _p: calls.append(1) or '["a","b","c"]'  # noqa: E731
    first = memory.suggest(o, "/p", None, run=run)
    second = memory.suggest(o, "/p", None, run=run)
    assert first == ["a", "b", "c"] and second == ["a", "b", "c"]
    assert len(calls) == 1                                     # 2nd served from cache


def test_suggest_disabled_returns_empty():
    o = 5004
    _seed(o, "/p")
    old = config.MEMORY_ENABLE
    config.MEMORY_ENABLE = False
    try:
        assert memory.suggest(o, "/p", None, run=lambda _p: '["x"]') == []
    finally:
        config.MEMORY_ENABLE = old


def test_suggest_malformed_returns_empty():
    o = 5005
    _seed(o, "/p")
    assert memory.suggest(o, "/p", None, run=lambda _p: "garbage") == []


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
