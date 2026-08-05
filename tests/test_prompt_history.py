"""Unit tests for the two halves of the Ctrl+R / venv work: `store.prompt_history`
(every session's prompts, newest first, deduped) and `terminals.venv_dir`.
Run: `python tests/test_prompt_history.py`
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import store, terminals  # noqa: E402

store.init()


def _turn(session_id: str, prompt: str) -> None:
    store.start_turn(session_id, f"t{time.time_ns()}", prompt, None)
    time.sleep(0.002)  # started is a float clock; keep the order unambiguous


def test_prompt_history_spans_sessions_newest_first():
    a = store.create_session(1, "/p")
    b = store.create_session(1, "/q")
    _turn(a["id"], "first prompt")
    _turn(b["id"], "second prompt")
    got = store.prompt_history()
    assert got[:2] == ["second prompt", "first prompt"], got


def test_prompt_history_dedupes_and_skips_blanks():
    s = store.create_session(1, "/dedupe")
    _turn(s["id"], "run the tests")
    _turn(s["id"], "   ")
    _turn(s["id"], "run the tests")
    got = store.prompt_history()
    assert got.count("run the tests") == 1, got
    assert "   " not in got
    # The repeat is recent news: it sorts by the latest use, not the first.
    assert got[0] == "run the tests", got


def test_prompt_history_honours_limit():
    s = store.create_session(1, "/limit")
    for i in range(5):
        _turn(s["id"], f"prompt {i}")
    assert len(store.prompt_history(limit=3)) == 3


def test_venv_dir_finds_dot_venv_then_venv():
    d = tempfile.mkdtemp()
    assert terminals.venv_dir(d) == ""
    os.makedirs(os.path.join(d, "venv", "bin"))
    open(os.path.join(d, "venv", "bin", "python"), "w").close()
    assert terminals.venv_dir(d) == "venv"
    os.makedirs(os.path.join(d, ".venv", "bin"))
    open(os.path.join(d, ".venv", "bin", "python"), "w").close()
    assert terminals.venv_dir(d) == ".venv"


def test_venv_dir_ignores_a_directory_with_no_interpreter():
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, ".venv", "bin"))
    assert terminals.venv_dir(d) == ""


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
