"""Unit tests for session subject-title provenance: the `title_source` column,
`set_subject_title` (overwrite only an auto title), `rename` provenance, and the
`start_turn` provisional auto-title.
Run: `python tests/test_session_title.py`
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


def test_new_session_defaults_title_source_auto():
    s = store.create_session(1, "/p")
    got = store.get_session(s["id"])
    assert got["title"] is None
    assert got["title_source"] == "auto"


def test_start_turn_sets_provisional_auto_title():
    s = store.create_session(1, "/p")
    store.start_turn(s["id"], s["id"] + "-t1", "Fix the login bug that logs users out", None)
    got = store.get_session(s["id"])
    assert got["title"] == "Fix the login bug that logs users out"
    assert got["title_source"] == "auto"


def test_start_turn_does_not_overwrite_existing_title():
    s = store.create_session(1, "/p")
    store.start_turn(s["id"], s["id"] + "-t1", "first prompt", None)
    store.start_turn(s["id"], s["id"] + "-t2", "second prompt", None)
    got = store.get_session(s["id"])
    assert got["title"] == "first prompt"          # 2nd turn leaves the title alone


def test_set_subject_title_overwrites_auto():
    s = store.create_session(1, "/p")
    store.start_turn(s["id"], s["id"] + "-t1", "help me center a div in CSS", None)
    store.set_subject_title(s["id"], "Center a div with CSS")
    got = store.get_session(s["id"])
    assert got["title"] == "Center a div with CSS"
    assert got["title_source"] == "subject"


def test_set_subject_title_skips_manual_rename():
    s = store.create_session(1, "/p")
    store.start_turn(s["id"], s["id"] + "-t1", "some prompt", None)
    store.rename(s["id"], "My Important Chat")
    store.set_subject_title(s["id"], "Generated Subject")
    got = store.get_session(s["id"])
    assert got["title"] == "My Important Chat"     # manual rename wins
    assert got["title_source"] == "manual"


def test_set_subject_title_skips_when_already_subject():
    s = store.create_session(1, "/p")
    store.start_turn(s["id"], s["id"] + "-t1", "prompt", None)
    store.set_subject_title(s["id"], "First Subject")
    store.set_subject_title(s["id"], "Second Subject")   # not regenerated
    got = store.get_session(s["id"])
    assert got["title"] == "First Subject"
    assert got["title_source"] == "subject"


def test_rename_sets_manual_source():
    s = store.create_session(1, "/p")
    store.rename(s["id"], "Custom Name")
    got = store.get_session(s["id"])
    assert got["title"] == "Custom Name"
    assert got["title_source"] == "manual"


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
