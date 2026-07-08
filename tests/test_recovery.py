"""Unit tests for startup auto-resume of restart-interrupted turns.
Run directly: `python tests/test_recovery.py` (or with pytest). Env is set before
importing the package so config picks it up.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import config, recovery, store  # noqa: E402

store.init()

CHAT = 555


def _orphan(project, *, claude_sid, cwd="/tmp/proj", chat=CHAT, model=None,
            turn_ids=("t",)):
    """A session (optionally carrying a claude_session_id) + one or more 'running'
    turns — i.e. turns a restart left mid-flight."""
    s = store.create_session(chat, project, cwd=cwd)
    if claude_sid:
        store.set_claude_session_id(s["id"], claude_sid)
    for suffix in turn_ids:
        store.start_turn(s["id"], f"{s['id']}-{suffix}", "do the thing", [], model=model)
    return s["id"]


class _Rec:
    """Records calls; usable as both the fake runner and the fake notifier."""

    def __init__(self, job="JOB"):
        self.calls = []
        self._job = job

    def __call__(self, chat_id, prompt, images=None, project=None, session_id=None,
                 model=None, **kw):
        self.calls.append({"chat_id": chat_id, "prompt": prompt, "images": images,
                           "project": project, "session_id": session_id, "model": model})
        return self._job


def _recover(run, *, notify=None):
    """Run recovery with a known allowed-chat set, isolating the test from the real
    ALLOWED_CHAT_IDS that leaks into the process env (config parses it once at
    import, so import order across test files would otherwise decide it)."""
    saved = config.ALLOWED_CHAT_IDS
    config.ALLOWED_CHAT_IDS = {CHAT}
    try:
        return recovery.recover(run=run, notify=notify or _Rec())
    finally:
        config.ALLOWED_CHAT_IDS = saved


def test_claim_orphaned_turns_flips_and_returns():
    sid = _orphan("clp", claude_sid="c-1", model="opus")
    rows = store.claim_orphaned_turns()
    mine = [r for r in rows if r["session_id"] == sid]
    assert len(mine) == 1
    r = mine[0]
    assert r["claude_session_id"] == "c-1" and r["chat_id"] == CHAT
    assert r["cwd"] == "/tmp/proj" and r["model"] == "opus" and r["prompt"] == "do the thing"
    # No longer running, and a second claim doesn't re-yield it.
    assert sid not in store.running_session_ids(CHAT)
    assert all(x["session_id"] != sid for x in store.claim_orphaned_turns())


def test_recover_resumes_eligible():
    sid = _orphan("rez", claude_sid="c-2", cwd="/tmp/rez", model="sonnet")
    run, notify = _Rec(), _Rec()
    n = _recover(run, notify=notify)
    assert n == 1
    assert len(run.calls) == 1
    call = run.calls[0]
    assert call["chat_id"] == CHAT and call["session_id"] == sid
    assert call["project"] == "/tmp/rez" and call["model"] == "sonnet"
    assert call["prompt"] == recovery.NUDGE and call["images"] == []
    assert len(notify.calls) == 1 and notify.calls[0]["chat_id"] == CHAT


def test_recover_skips_turn_without_claude_session_id():
    sid = _orphan("nosid", claude_sid=None)          # died before Claude init
    run = _Rec()
    n = _recover(run)
    assert n == 0 and run.calls == []
    assert sid not in store.running_session_ids(CHAT)  # still flipped to error


def test_recover_resumes_on_every_boot():
    """Back-to-back restarts each resume the interrupted turn — no cooldown skip
    (every boot-resume traces to a human restarting the bridge, so it can't loop)."""
    sid = _orphan("warm", claude_sid="c-4")
    run = _Rec()
    assert _recover(run) == 1
    store.start_turn(sid, f"{sid}-again", "still going", [])   # next restart hits it too
    assert _recover(run) == 1
    assert [c["session_id"] for c in run.calls] == [sid, sid]


def test_recover_skips_disallowed_chat():
    sid = _orphan("foreign", claude_sid="c-5", chat=999)  # 999 not in ALLOWED_CHAT_IDS
    run = _Rec()
    n = _recover(run)                                     # allowed set forced to {555}
    assert n == 0 and run.calls == []
    assert sid not in store.running_session_ids(999)


def test_recover_dedups_multiple_running_turns_on_one_session():
    sid = _orphan("dup", claude_sid="c-6", turn_ids=("a", "b"))  # two running turns
    run = _Rec()
    n = _recover(run)
    assert n == 1 and len(run.calls) == 1 and run.calls[0]["session_id"] == sid


def test_recover_disabled_flips_but_does_not_resume():
    sid = _orphan("off", claude_sid="c-7")
    run = _Rec()
    saved = config.AUTO_RESUME
    config.AUTO_RESUME = False
    try:
        n = _recover(run)
    finally:
        config.AUTO_RESUME = saved
    assert n == 0 and run.calls == []
    assert sid not in store.running_session_ids(CHAT)  # claim still ran (UI hygiene)


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
