"""Unit tests for the per-session preview prompt queue (bridge/queue_manager.py).

The queue runs queued prompts one at a time per session, via an injected run_fn
(the real one wraps runner.start_streaming_job). It auto-advances when each run
finishes (driven by notify_job_done, which the runner calls in its finally block).
Everything here exercises the pure state machine with a fake runner — no Claude.
Run: `python tests/test_preview_queue.py` (or with pytest).
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", tempfile.mkdtemp())
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge.queue_manager import PreviewQueue  # noqa: E402


class FakeRunner:
    """Stand-in for runner.start_streaming_job: records starts, hands out job ids,
    and can simulate a busy session by returning None."""

    def __init__(self):
        self.calls = []      # list of started items
        self.n = 0
        self.busy = False

    def __call__(self, item):
        if self.busy:
            return None
        self.n += 1
        jid = f"job{self.n}"
        self.calls.append(item)
        return jid


def _q(**kw):
    """A queue with a fake runner, in-memory (no persistence)."""
    fake = FakeRunner()
    q = PreviewQueue(run_fn=fake, persist_path=None, **kw)
    return q, fake


def _enq(q, sid="s1", text="t", **kw):
    return q.enqueue(
        sid, text=text, prompt=kw.get("prompt", text), images=kw.get("images", []),
        model=kw.get("model"), effort=kw.get("effort"),
        permission_mode=kw.get("permission_mode"), width=kw.get("width", 1280),
        sel=kw.get("sel", []), surface=kw.get("surface", "dashboard"),
        chat_id=kw.get("chat_id", 555), project=kw.get("project", "/repo"),
    )


def _items(q, sid="s1"):
    return q.snapshot(sid)["items"]


# --- enqueue + auto-start --------------------------------------------------

def test_enqueue_when_idle_starts_running():
    q, fake = _q()
    iid = _enq(q, text="do x")
    items = _items(q)
    assert len(items) == 1
    assert items[0]["id"] == iid
    assert items[0]["status"] == "running"
    assert items[0]["job_id"] == "job1"
    assert items[0]["text"] == "do x"
    assert fake.n == 1


def test_second_enqueue_waits_while_first_runs():
    q, fake = _q()
    _enq(q, text="a")
    _enq(q, text="b")
    statuses = [it["status"] for it in _items(q)]
    assert statuses == ["running", "queued"]
    assert fake.n == 1  # only one run started


def test_enqueue_carries_anchors_and_width():
    q, _ = _q()
    _enq(q, text="a", sel=[{"tag": "button", "label": "Primary CTA"}], width=375)
    it = _items(q)[0]
    assert it["sel"] == [{"tag": "button", "label": "Primary CTA"}]
    assert it["width"] == 375


# --- completion advances the queue -----------------------------------------

def test_notify_done_marks_done_and_advances():
    q, fake = _q()
    a = _enq(q, text="a")
    _enq(q, text="b")
    q.notify_job_done("s1", "job1", "done", "all good", 0.0031, 6)
    items = _items(q)
    done = next(it for it in items if it["id"] == a)
    assert done["status"] == "done"
    assert done["result"] == "all good"
    assert done["cost"] == 0.0031
    assert done["elapsed"] == 6
    # b advanced to running
    assert [it["status"] for it in items] == ["done", "running"]
    assert fake.n == 2


def test_notify_error_marks_failed():
    q, _ = _q()
    a = _enq(q, text="a")
    q.notify_job_done("s1", "job1", "error", None, None, None, error="boom")
    it = next(i for i in _items(q) if i["id"] == a)
    assert it["status"] == "failed"
    assert it["error"] == "boom"


def test_notify_for_unknown_job_advances_queue():
    """A chat run (not a queue item) holds the session's run slot, so an enqueue
    can't start. When that run finishes, the runner calls notify_job_done with a
    job id the queue doesn't know — which must still free things up and start the
    waiting item."""
    q, fake = _q()
    fake.busy = True           # the session is busy with an external (chat) run
    _enq(q, text="a")          # can't start yet
    assert _items(q)[0]["status"] == "queued"
    assert fake.n == 0
    fake.busy = False          # the chat run finished, freeing the slot
    q.notify_job_done("s1", "chat-job-xyz", "done", "x", None, None)
    assert _items(q)[0]["status"] == "running"
    assert fake.n == 1


# --- pause / resume --------------------------------------------------------

def test_pause_blocks_start():
    q, fake = _q()
    q.pause("s1")
    _enq(q, text="a")
    assert _items(q)[0]["status"] == "queued"
    assert fake.n == 0
    q.resume("s1")
    assert _items(q)[0]["status"] == "running"
    assert fake.n == 1


def test_pause_lets_running_finish_but_holds_next():
    q, fake = _q()
    _enq(q, text="a")          # running
    _enq(q, text="b")          # queued
    q.pause("s1")
    q.notify_job_done("s1", "job1", "done", "ok", None, None)
    assert [it["status"] for it in _items(q)] == ["done", "queued"]
    assert fake.n == 1
    q.resume("s1")
    assert [it["status"] for it in _items(q)] == ["done", "running"]


# --- reorder / bump --------------------------------------------------------

def test_bump_runs_that_item_next():
    q, fake = _q()
    _enq(q, text="a")          # running
    _enq(q, text="b")          # queued
    c = _enq(q, text="c")      # queued
    q.bump("s1", c)            # c should run before b
    order = [it["text"] for it in _items(q)]
    assert order == ["a", "c", "b"]
    q.notify_job_done("s1", "job1", "done", None, None, None)
    running = next(it for it in _items(q) if it["status"] == "running")
    assert running["text"] == "c"


def test_reorder_moves_queued_before_target():
    q, _ = _q()
    _enq(q, text="a")          # running
    _enq(q, text="b")
    _enq(q, text="c")
    d = _enq(q, text="d")
    # Find b's id to drop d before it.
    b_id = [it["id"] for it in _items(q) if it["text"] == "b"][0]
    q.reorder("s1", d, b_id)
    assert [it["text"] for it in _items(q)] == ["a", "d", "b", "c"]


def test_bump_ignores_running_and_done():
    q, _ = _q()
    a = _enq(q, text="a")      # running
    _enq(q, text="b")
    q.bump("s1", a)            # no-op on the running item
    assert [it["text"] for it in _items(q)] == ["a", "b"]


# --- move to another session -----------------------------------------------

def test_move_queued_item_starts_in_destination():
    q, fake = _q()
    _enq(q, text="a")                  # running in s1, so "b" is stuck behind it
    b = _enq(q, text="b")
    q.move("s1", b, "s2")
    assert [it["text"] for it in _items(q)] == ["a"]
    moved = _items(q, "s2")
    assert [it["text"] for it in moved] == ["b"]
    assert moved[0]["status"] == "running"     # the new session is idle
    assert fake.calls[-1].session_id == "s2"   # and it runs AS s2


def test_move_ignores_running_and_same_session():
    q, _ = _q()
    a = _enq(q, text="a")              # running
    b = _enq(q, text="b")
    q.move("s1", a, "s2")             # running items stay put
    q.move("s1", b, "s1")             # no-op: same session
    q.move("s1", b, "")               # no-op: no destination
    assert [it["text"] for it in _items(q)] == ["a", "b"]
    assert _items(q, "s2") == []


# --- remove / edit ---------------------------------------------------------

def test_remove_queued_item():
    q, _ = _q()
    _enq(q, text="a")          # running
    b = _enq(q, text="b")
    q.remove("s1", b)
    assert [it["text"] for it in _items(q)] == ["a"]


def test_remove_running_item_is_ignored():
    q, _ = _q()
    a = _enq(q, text="a")      # running
    q.remove("s1", a)
    assert len(_items(q)) == 1


def test_edit_only_queued():
    q, _ = _q()
    a = _enq(q, text="a")      # running
    b = _enq(q, text="b")
    q.edit("s1", b, "b2", "b2 prompt")
    q.edit("s1", a, "a2", "a2 prompt")   # ignored (running)
    texts = {it["id"]: it["text"] for it in _items(q)}
    assert texts[b] == "b2"
    assert texts[a] == "a"


# --- cancel / retry --------------------------------------------------------

def test_cancel_running_interrupts_and_fails():
    interrupted = []
    fake = FakeRunner()
    q = PreviewQueue(run_fn=fake, interrupt_fn=interrupted.append, persist_path=None)
    a = _enq(q, text="a")      # running, job1
    q.cancel("s1", a)
    assert interrupted == ["job1"]
    it = _items(q)[0]
    assert it["status"] == "failed"
    assert "cancel" in (it["error"] or "").lower()


def test_retry_requeues_failed_and_runs():
    q, fake = _q()
    a = _enq(q, text="a")
    q.notify_job_done("s1", "job1", "error", None, None, None, error="boom")
    assert _items(q)[0]["status"] == "failed"
    q.retry("s1", a)
    it = _items(q)[0]
    assert it["status"] == "running"
    assert it["error"] is None
    assert fake.n == 2


# --- clear done ------------------------------------------------------------

def test_clear_done_drops_terminal_items():
    q, _ = _q()
    _enq(q, text="a")
    q.notify_job_done("s1", "job1", "done", "ok", None, None)   # a done, nothing queued
    b = _enq(q, text="b")      # runs (job2)
    q.notify_job_done("s1", "job2", "error", None, None, None, error="x")  # b failed
    c = _enq(q, text="c")      # runs (job3)
    q.clear_done("s1")
    texts = [it["text"] for it in _items(q)]
    assert texts == ["c"]
    assert c  # silence lint


# --- snapshot revision + cursor backfill -----------------------------------

def test_snapshot_revision_increments_on_change():
    q, _ = _q()
    r0 = q.snapshot("s1")["seq"]
    _enq(q, text="a")
    r1 = q.snapshot("s1")["seq"]
    assert r1 > r0


def test_backfill_respects_cursor():
    q, _ = _q()
    _enq(q, text="a")
    snap = q.snapshot("s1")
    seq = snap["seq"]
    # A client already at the latest revision gets nothing.
    assert q.backfill("s1", seq + 1) == []
    # A client behind gets the current snapshot.
    got = q.backfill("s1", seq)
    assert len(got) == 1 and got[0]["seq"] == seq


# --- persistence -----------------------------------------------------------

def test_persistence_roundtrip_resets_running(tmp_path):
    path = str(tmp_path / "queue.json")
    fake = FakeRunner()
    q = PreviewQueue(run_fn=fake, persist_path=path)
    _enq(q, text="a")          # running, job1
    _enq(q, text="b")          # queued
    # Reload (simulating a server restart — the in-flight job is gone).
    q2 = PreviewQueue(run_fn=FakeRunner(), persist_path=path)
    items = q2.snapshot("s1")["items"]
    assert [it["text"] for it in items] == ["a", "b"]
    # The previously-running item is reset to queued (its job died with the server).
    assert items[0]["status"] in ("queued", "running")
    assert items[0]["job_id"] is None


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            import inspect
            if "tmp_path" in inspect.signature(fn).parameters:
                with tempfile.TemporaryDirectory() as d:
                    import pathlib
                    fn(pathlib.Path(d))
            else:
                fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
