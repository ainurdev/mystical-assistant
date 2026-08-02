"""A session's claude id is minted before the spawn, so --session-id creates it
and the store row is linked before any transcript exists.
Run: python -m pytest tests/test_session_id.py -v"""

import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import runner  # noqa: E402


def test_new_session_uses_session_id_flag():
    sid = str(uuid.uuid4())
    cmd = runner._base_cmd("hi", 555, stream=False, skip_pack=True,
                           claude_session_id=sid, new_session=True)
    assert "--session-id" in cmd and cmd[cmd.index("--session-id") + 1] == sid
    assert "--resume" not in cmd


def test_continuation_still_uses_resume():
    sid = str(uuid.uuid4())
    cmd = runner._base_cmd("hi", 555, stream=False, skip_pack=True,
                           claude_session_id=sid, new_session=False)
    assert "--resume" in cmd and cmd[cmd.index("--resume") + 1] == sid
    assert "--session-id" not in cmd


def test_no_session_id_means_neither_flag():
    cmd = runner._base_cmd("hi", 555, stream=False, skip_pack=True)
    assert "--resume" not in cmd and "--session-id" not in cmd


def test_claim_mints_and_persists_once(monkeypatch):
    """A fresh session gets a uuid written to the store before spawning; an
    existing one is returned untouched (and not re-persisted)."""
    saved = []
    monkeypatch.setattr(runner.store, "set_claude_session_id",
                        lambda s, c: saved.append((s, c)))

    minted, is_new = runner._claim_session_id("store-1", None)
    assert is_new and uuid.UUID(minted)          # valid uuid, flagged new
    assert saved == [("store-1", minted)]        # persisted before the spawn

    existing, is_new2 = runner._claim_session_id("store-1", minted)
    assert existing == minted and is_new2 is False
    assert len(saved) == 1                       # no redundant write


def test_resumable_requires_a_confirmed_session():
    """The minted id alone no longer proves the child wrote anything: a brand-new
    session that died before init is not resumable, but one whose id predates the
    run (or that reached init) is."""
    sess = {"claude_session_id": "abc"}

    fresh = runner.Job("j", 1, "s")
    fresh.new_session = True                     # minted this run, never confirmed
    assert runner._resumable(fresh, sess) is False

    fresh.session_id = "abc"                     # init came back -> transcript exists
    assert runner._resumable(fresh, sess) is True

    continuing = runner.Job("j2", 1, "s")        # id predates this run
    assert runner._resumable(continuing, sess) is True

    assert runner._resumable(continuing, {}) is False
    assert runner._resumable(continuing, None) is False
