"""Unit tests for the project-memory capture extractor (reconcile + gates).
Run: `python tests/test_memory_capture.py`
"""

import os
import sys

import pytest
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import config, memory, store  # noqa: E402

store.init()


@pytest.fixture(autouse=True)
def _feature_on(monkeypatch):
    """Project memory ships OFF (bridge/aifeatures.py) — these tests are about what it
    does once switched on, so turn it on for the module."""
    monkeypatch.setattr(config, "MEMORY_ENABLE", True)


def _session_turn(owner, project):
    s = store.create_session(owner, project)
    tid = "t_" + s["id"][:8]
    store.start_turn(s["id"], tid, "do a thing", None)
    return s["id"], tid


# --- _parse_ops (pure) ------------------------------------------------------

def test_parse_ops_valid_add_and_update():
    raw = ('[{"op":"ADD","type":"convention","scope":"project","title":"pnpm","body":"use pnpm"},'
           '{"op":"UPDATE","id":"abc","type":"goal","scope":"project","title":"g2","body":"new"}]')
    ops = memory._parse_ops(raw)
    assert [o["op"] for o in ops] == ["ADD", "UPDATE"]


def test_parse_ops_drops_skip_and_invalid_and_caps_two():
    raw = ('[{"op":"SKIP"},'
           '{"op":"ADD","type":"bogus","scope":"project","title":"x","body":"y"},'
           '{"op":"ADD","type":"gotcha","scope":"project","title":"a","body":"b"},'
           '{"op":"ADD","type":"decision","scope":"project","title":"c","body":"d"},'
           '{"op":"ADD","type":"convention","scope":"project","title":"e","body":"f"}]')
    ops = memory._parse_ops(raw)
    assert {o["title"] for o in ops} == {"a", "c"}      # SKIP+bogus dropped, capped at 2


def test_parse_ops_handles_fenced_and_malformed():
    fenced = 'Sure!\n```json\n[{"op":"ADD","type":"gotcha","scope":"project","title":"t","body":"b"}]\n```'
    assert len(memory._parse_ops(fenced)) == 1
    assert memory._parse_ops("not json at all") == []
    assert memory._parse_ops('{"op":"ADD"}') == []      # object, not array


# --- propose (gates + apply, with an injected fake run) ---------------------

def test_build_capture_prompt_lists_known_and_asks_json():
    existing = [{"id": "m1", "type": "convention", "title": "pnpm-fact"}]
    p = memory._build_capture_prompt(existing, "did work", ["a.py"])
    assert "m1" in p and "pnpm-fact" in p and "JSON" in p and "a.py" in p


def test_gating_disabled_skips_run():
    o = 4001
    sid, tid = _session_turn(o, "/p")
    called = []
    old = config.MEMORY_ENABLE
    config.MEMORY_ENABLE = False
    try:
        out = memory.propose(o, sid, tid, "/p", "feat", "some output", [],
                             run=lambda _p: called.append(1) or "[]")
    finally:
        config.MEMORY_ENABLE = old
    assert out == [] and called == []


def test_no_output_skips_run():
    o = 4002
    sid, tid = _session_turn(o, "/p")
    called = []
    out = memory.propose(o, sid, tid, "/p", "feat", "", [],
                         run=lambda _p: called.append(1) or "[]")
    assert out == [] and called == []


def test_add_creates_candidate_and_emits_event():
    o = 4003
    sid, tid = _session_turn(o, "/p")
    raw = '[{"op":"ADD","type":"convention","scope":"project","title":"pnpm","body":"use pnpm"}]'
    ids = memory.propose(o, sid, tid, "/p", "feat", "did stuff", ["a.py"], run=lambda _p: raw)
    assert len(ids) == 1
    m = store.get_memory(ids[0])
    assert m["status"] == "candidate"
    assert m["type"] == "convention"
    assert m["source_turn_id"] == tid
    assert m["branch"] is None                          # non-goal project facts are repo-wide
    events = store.transcript(sid)["events"]
    assert any(e.get("type") == "memory_candidate" and e.get("item_id") == ids[0]
               for e in events)


def test_goal_add_is_branch_scoped():
    o = 4004
    sid, tid = _session_turn(o, "/p")
    raw = '[{"op":"ADD","type":"goal","scope":"project","title":"ship","body":"finish"}]'
    ids = memory.propose(o, sid, tid, "/p", "feat", "x", [], run=lambda _p: raw)
    assert store.get_memory(ids[0])["branch"] == "feat"


def test_user_scope_ignores_project_and_branch():
    o = 4005
    sid, tid = _session_turn(o, "/p")
    raw = '[{"op":"ADD","type":"preference","scope":"user","title":"terse","body":"be terse"}]'
    ids = memory.propose(o, sid, tid, "/p", "feat", "x", [], run=lambda _p: raw)
    m = store.get_memory(ids[0])
    assert m["scope"] == "user" and m["project_path"] is None and m["branch"] is None


def test_update_with_valid_target_sets_supersedes():
    o = 4006
    sid, tid = _session_turn(o, "/p")
    target = store.add_memory(o, "project", "goal", "old goal", "old",
                              project_path="/p", branch="feat", status="active")
    raw = ('[{"op":"UPDATE","id":"%s","type":"goal","scope":"project",'
           '"title":"new goal","body":"new"}]') % target["id"]
    ids = memory.propose(o, sid, tid, "/p", "feat", "x", [], run=lambda _p: raw)
    assert store.get_memory(ids[0])["supersedes_id"] == target["id"]


def test_update_with_unknown_target_downgrades_to_add():
    o = 4007
    sid, tid = _session_turn(o, "/p")
    raw = '[{"op":"UPDATE","id":"nope","type":"goal","scope":"project","title":"g","body":"b"}]'
    ids = memory.propose(o, sid, tid, "/p", "feat", "x", [], run=lambda _p: raw)
    assert store.get_memory(ids[0])["supersedes_id"] is None


def test_malformed_output_yields_nothing_no_raise():
    o = 4008
    sid, tid = _session_turn(o, "/p")
    assert memory.propose(o, sid, tid, "/p", "feat", "x", [], run=lambda _p: "garbage") == []


def test_run_exception_is_swallowed():
    o = 4009
    sid, tid = _session_turn(o, "/p")
    def boom(_p):
        raise RuntimeError("claude down")
    assert memory.propose(o, sid, tid, "/p", "feat", "x", [], run=boom) == []


def test_default_run_path_produces_candidate():
    # Exercises the REAL default run (no injected `run`): a regression guard for the
    # owner-binding bug where propose() called a 2-arg _default_run with 1 arg.
    o = 4010
    sid, tid = _session_turn(o, "/p")
    from bridge import runner
    raw = '[{"op":"ADD","type":"convention","scope":"project","title":"pnpm","body":"use pnpm"}]'
    old = runner.run_blocking
    runner.run_blocking = lambda owner, prompt, **k: (raw, None, None, False)
    try:
        ids = memory.propose(o, sid, tid, "/p", "feat", "did real work", ["a.py"])
    finally:
        runner.run_blocking = old
    assert len(ids) == 1
    assert store.get_memory(ids[0])["title"] == "pnpm"


def test_auto_creates_active_not_candidate():
    o = 4011
    sid, tid = _session_turn(o, "/p")
    raw = '[{"op":"ADD","type":"convention","scope":"project","title":"pnpm","body":"use pnpm"}]'
    ids = memory.propose(o, sid, tid, "/p", "feat", "did stuff", ["a.py"],
                         run=lambda _p: raw, auto=True)
    assert len(ids) == 1
    assert store.get_memory(ids[0])["status"] == "active"


def test_auto_update_archives_superseded_target():
    o = 4012
    sid, tid = _session_turn(o, "/p")
    target = store.add_memory(o, "project", "goal", "old goal", "old",
                              project_path="/p", branch="feat", status="active")
    raw = ('[{"op":"UPDATE","id":"%s","type":"goal","scope":"project",'
           '"title":"new goal","body":"new"}]') % target["id"]
    ids = memory.propose(o, sid, tid, "/p", "feat", "x", [], run=lambda _p: raw, auto=True)
    assert store.get_memory(ids[0])["status"] == "active"
    assert store.get_memory(ids[0])["supersedes_id"] == target["id"]
    assert store.get_memory(target["id"])["status"] == "archived"


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
