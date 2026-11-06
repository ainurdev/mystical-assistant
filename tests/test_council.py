from bridge import council, store

store.init()

def test_parse_review_reads_the_last_json_block():
    t = 'Looks fine.\n```json\n{"score": 3}\n```\nFinal:\n```json\n{"score": 7.46, "summary": "one race", "findings": [{"sev": "must", "file": "bridge/git.py", "line": 584, "title": "push() hides exit 1"}]}\n```'
    r = council.parse_review(t)
    assert r["score"] == 7.5 and r["summary"] == "one race"
    assert r["findings"] == [{"sev": "must", "file": "bridge/git.py", "line": 584, "title": "push() hides exit 1"}]

def test_parse_review_rejects_junk_and_bad_scores():
    assert council.parse_review("no json here") is None
    assert council.parse_review('{"score": 14}') is None
    r = council.parse_review('{"score": 8, "findings": [{"sev": "huge", "file": "a.py", "line": "x", "title": "t"}, {"sev": "nit", "file": "b.py"}]}')
    assert r["findings"] == [{"sev": "should", "file": "a.py", "line": None, "title": "t"}]

def test_merge_joins_near_lines_and_keeps_the_higher_severity():
    by = {"claude": {"score": 7, "findings": [{"sev": "must", "file": "git.py", "line": 584, "title": "A"}]},
          "codex": {"score": 8, "findings": [{"sev": "should", "file": "git.py", "line": 586, "title": "B"},
                                             {"sev": "nit", "file": "taskcheck.py", "line": 10, "title": "C"}]}}
    m = council.merge(by)
    assert [(f["sev"], f["file"], f["by"]) for f in m] == [("must", "git.py", ["claude", "codex"]), ("nit", "taskcheck.py", ["codex"])]
    assert m[0]["id"] == "git.py:584" and m[0]["title"] == "A"

def test_blocking_needs_every_seat_that_ran_and_skips_dismissed():
    both = {"id": "git.py:584", "sev": "must", "file": "git.py", "line": 584, "title": "A", "by": ["claude", "codex"]}
    one = {"id": "x.py:1", "sev": "must", "file": "x.py", "line": 1, "title": "B", "by": ["claude"]}
    assert council.blocking([both, one], ["claude", "codex"], []) == [both]
    assert council.blocking([both, one], ["claude"], []) == [both, one]
    assert council.blocking([both], ["claude", "codex"], ["git.py:586"]) == []

def test_decide_covers_pass_max_stall_and_fixing():
    base = {"bar": 9.0, "max_rounds": 3, "stop_early": True}
    r = lambda s, b=0: {"score": s, "blocking": b}
    assert council.decide({**base, "round": 1, "rounds": [r(9.2)]}) == "passed"
    assert council.decide({**base, "round": 1, "rounds": [r(9.5, 1)]}) == "fixing"
    assert council.decide({**base, "round": 2, "rounds": [r(7.0), r(6.9)]}) == "stopped:stalled"
    assert council.decide({**base, "stop_early": False, "round": 2, "rounds": [r(7.0), r(6.9)]}) == "fixing"
    assert council.decide({**base, "round": 3, "rounds": [r(6), r(7), r(8)]}) == "stopped:max_rounds"

def test_fix_prompt_and_answers():
    c = {"round": 2, "max_rounds": 5, "bar": 9.0, "rounds": [{"score": 8.1, "findings": [
        {"sev": "must", "file": "bridge/git.py", "line": 584, "title": "push() hides exit 1", "by": ["claude", "codex"], "state": "open"}]}]}
    p = council.fix_prompt(c)
    assert p.startswith("[council 2/5] 8.1 of 9.0\n")
    assert "1. MUST · bridge/git.py:584 · claude+codex · push() hides exit 1" in p
    assert council.answers("1. NO: not a bug, see runner.py:271\n2. fixed it\n3) NO - churn") == {1: "not a bug, see runner.py:271", 3: "churn"}

def test_settings_clamp_and_round_trip():
    s = council.save_settings({"bar": 12, "max_rounds": 0, "codex_projects": ["/a", 3], "junk": 1})
    assert s["bar"] == 10.0 and s["max_rounds"] == 1 and s["codex_projects"] == ["/a"] and "junk" not in s
    assert council.save_settings({"bar": 8.7, "max_rounds": 5})["bar"] == 8.5
    store.set_setting("council", None)          # the test DB is shared: leave the defaults for the next test

def test_store_council_column_round_trip():
    sid = store.create_session(555, "/counciltest", origin="dashboard")["id"]
    store.set_council(sid, {"status": "passed"})
    assert store.get_council(sid) == {"status": "passed"}
    store.set_council(sid, None)
    assert store.get_council(sid) is None


def test_parse_review_never_raises():
    assert council.parse_review('{"score": 8, "findings": 5}')["findings"] == []
    assert council.parse_review('{"score": 8, "findings": [1, null, {"title": "t", "file": "a"}]}')["findings"][0]["title"] == "t"
    assert council.parse_review('{"a":' + "[" * 100000) is None


def test_lineless_finding_can_be_dismissed_by_its_id():
    f = {"id": "a.py:0", "sev": "must", "file": "a.py", "line": None, "title": "T", "by": ["claude"]}
    assert council.blocking([f], ["claude"], ["a.py:0"]) == []
    assert council.blocking([f], ["claude"], []) == [f]


def test_dismissing_one_lineless_finding_leaves_the_others():
    m = council.merge({"claude": {"score": 6, "findings": [{"sev": "must", "file": "a.py", "line": None, "title": "T"},
                                                           {"sev": "nit", "file": "a.py", "line": None, "title": "U"}]}})
    must, nit = m
    assert must["id"] != nit["id"]
    assert council.blocking(m, ["claude"], [nit["id"]]) == [must]


def test_answers_do_not_cross_lines():
    assert council.answers("1. NO:\n2. fixed") == {}
    assert council.answers("1. NO: why\n2. NO: other") == {1: "why", 2: "other"}


def test_save_settings_survives_bad_input():
    before = council.save_settings({"bar": 8, "max_rounds": 4, "codex_projects": ["/a"]})
    s = council.save_settings({"bar": "x", "max_rounds": "y", "codex_projects": 5, "stop_early": "yes"})
    assert (s["bar"], s["max_rounds"], s["codex_projects"]) == (8.0, 4, ["/a"])
    assert council.save_settings({"bar": float("nan")})["bar"] == 8.0
    assert council.save_settings({"bar": float("inf")})["bar"] == 8.0
    assert council.save_settings({"bar": 1e308})["bar"] == 10.0
    assert council.save_settings({"bar": -1e308})["bar"] == 1.0
    assert council.save_settings({"bar": 10**400})["bar"] == 1.0  # unchanged
    assert council.save_settings({"max_rounds": 10**400})["max_rounds"] == 10
    store.set_setting("council", None)          # the test DB is shared: leave the defaults for the next test


# --- seats ---------------------------------------------------------------
import subprocess
import threading

import pytest

from bridge import acp, acp_agents, native, runner

_G = ["git", "-c", "user.email=t@t", "-c", "user.name=t"]


def _git(cwd, *a):
    subprocess.run([*_G, *a], cwd=cwd, check=True, capture_output=True)


def _clone(tmp_path):
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", "remote.git")
    _git(tmp_path, "clone", "-q", "remote.git", "c")
    c = tmp_path / "c"
    (c / "a.txt").write_text("one\n")
    _git(c, "add", "."); _git(c, "commit", "-qm", "first"); _git(c, "push", "-q", "-u", "origin", "HEAD")
    return c


def test_material_reads_commits_and_uncommitted_changes(tmp_path):
    c = _clone(tmp_path)
    (c / "b.txt").write_text("two\n")
    _git(c, "add", "."); _git(c, "commit", "-qm", "second")
    (c / "a.txt").write_text("one\nuncommitted line\n")
    m = council.material(str(c))
    assert len(m["commits"]) == 1 and m["commits"][0][1] == "second"
    assert "uncommitted line" in m["diff"] and m["files"] >= 2


def test_material_is_none_when_nothing_to_review(tmp_path):
    assert council.material(str(_clone(tmp_path))) is None


def test_material_caps_a_huge_diff(tmp_path):
    c = _clone(tmp_path)
    (c / "big.txt").write_text("x" * 200_000 + "\n")
    (c / "small.txt").write_text("s\n")
    _git(c, "add", "."); _git(c, "commit", "-qm", "big")
    m = council.material(str(c))
    assert m["truncated"] and len(m["diff"]) <= council.DIFF_CAP
    assert m["left_out"] == ["big.txt"] and "small.txt" in m["diff"]


def test_review_prompt_carries_the_contract():
    m = {"commits": [["abc", "msg"]], "untracked": ["n.py"], "diff": "DIFF", "truncated": True, "left_out": ["big.txt"]}
    p = council.review_prompt(m, ["settled one"], ["answered one"])
    assert p.startswith(native.INTERNAL_ONESHOT_TAG)
    for bit in ('"score"', "must =", "settled one", "answered one", "abc msg", "n.py", "DIFF", "big.txt"):
        assert bit in p


def test_seat_claude_parses_or_reports(monkeypatch):
    seen = {}
    ret = [('```json\n{"score": 8}\n```', "s", 0.0, False)]
    monkeypatch.setattr(runner, "run_blocking", lambda *a, **k: (seen.update(k), ret[0])[1])
    r = council.seat_claude("p", "/tmp", 1, "slot2")
    assert r["ok"] and r["score"] == 8.0
    assert seen == dict(cwd="/tmp", timeout=900, skip_pack=True, permission_mode="plan",
                        new_session=True, account_slot="slot2")
    ret[0] = ("boom", "s", 0, True)
    assert council.seat_claude("p", "/tmp", 1, None) == {"ok": False, "error": "boom"}
    ret[0] = ("junk", "s", 0, False)
    r = council.seat_claude("p", "/tmp", 1, None)
    assert not r["ok"] and "no score" in r["error"]


_MODES = {"mode": [{"value": "auto"}, {"value": "read-only"}]}


def test_seat_codex_times_out_and_denies_requests(monkeypatch):
    stop, asked = threading.Event(), []
    monkeypatch.setattr(acp_agents, "accounts", lambda a=None: [])
    monkeypatch.setattr(acp_agents, "argv", lambda p: ["x"])
    monkeypatch.setattr(acp_agents, "options_for", lambda a, acct: _MODES)
    monkeypatch.setattr(acp, "answer", lambda job, rid, allow: asked.append((rid, allow)))
    monkeypatch.setattr(acp, "cancel", lambda job, grace: stop.set())

    def hang(job, **kw):
        job.awaiting["r1"] = {}
        stop.wait(5)
    monkeypatch.setattr(acp, "run_turn", hang)
    assert council.seat_codex("p", "/tmp", timeout=0.3) == {"ok": False, "error": "timed out"}
    assert ("r1", False) in asked

    def fine(job, **kw):
        job.result, job.status = '{"score": 9}', "done"
    monkeypatch.setattr(acp, "run_turn", fine)
    r = council.seat_codex("p", "/tmp", timeout=5)
    assert r["ok"] and r["score"] == 9.0


def test_seats_for(monkeypatch):
    st = {"installed": True}
    monkeypatch.setattr(acp_agents, "accounts", lambda a=None: [])
    monkeypatch.setattr(acp_agents, "available", lambda: [{"id": "codex", **st}])
    signed = {"mode": [{"value": "read-only"}]}
    monkeypatch.setattr(acp_agents, "options_for", lambda a, acct: signed)
    s, sess = dict(council.DEFAULTS, codex_projects=["p"]), {"project": "p"}
    assert council.seats_for(sess, s) == {"claude": "on", "codex": "sign-in"}
    signed["signed_in"] = True
    assert council.seats_for(sess, s)["codex"] == "on"
    signed["mode"] = []
    assert council.seats_for(sess, s)["codex"] == "sign-in"
    signed["mode"] = [{"value": "read-only"}]
    st["installed"] = False
    assert council.seats_for(sess, s)["codex"] == "sign-in"
    assert council.seats_for({"project": "q"}, s)["codex"] == "not-allowed"
    assert council.seats_for(sess, dict(s, codex=False, claude=False)) == {"claude": "off", "codex": "off"}


def test_seat_codex_needs_a_read_only_mode_and_passes_it(monkeypatch):
    called = []
    monkeypatch.setattr(acp_agents, "accounts", lambda a=None: [])
    monkeypatch.setattr(acp_agents, "argv", lambda p: ["x"])
    monkeypatch.setattr(acp, "run_turn", lambda job, **kw: (called.append(kw), setattr(job, "status", "done"),
                                                            setattr(job, "result", '{"score": 9}')))
    monkeypatch.setattr(acp_agents, "options_for", lambda a, acct: {"mode": []})
    r = council.seat_codex("p", "/tmp")
    assert not r["ok"] and "no read-only mode" in r["error"] and not called
    monkeypatch.setattr(acp_agents, "options_for", lambda a, acct: _MODES)
    assert council.seat_codex("p", "/tmp")["ok"]
    assert called[0]["opts"] == {"permission_mode": "read-only", "must": ("permission_mode",)}


def test_the_read_only_mode_is_picked_from_the_cached_list(monkeypatch):
    modes = {"mode": [{"value": "auto"}, {"value": "full-access"}, {"value": "Read-Only"}]}
    monkeypatch.setattr(acp_agents, "options_for", lambda a, acct: modes)
    assert council._read_only_mode("") == "Read-Only"                   # noqa: SLF001
    modes["mode"] = [{"value": "auto"}, {"value": "full-access"}]
    assert council._read_only_mode("") is None                          # noqa: SLF001
    del modes["mode"]                                                    # never tested: no list at all
    assert council._read_only_mode("") is None                          # noqa: SLF001


def test_seats_never_raise(monkeypatch):
    def boom(*a, **k):
        raise OSError("disk")
    monkeypatch.setattr(acp_agents, "options_for", boom)
    monkeypatch.setattr(runner, "run_blocking", boom)
    assert council.seat_codex("p", "/tmp") == {"ok": False, "error": "disk"}
    assert council.seat_claude("p", "/tmp", 1, None) == {"ok": False, "error": "disk"}


def test_material_raises_on_a_git_failure(tmp_path, monkeypatch):
    c = _clone(tmp_path)
    (c / "a.txt").write_text("changed\n")
    real = council.git._run
    monkeypatch.setattr(council.git, "_run", lambda cwd, *a, **k: (124, "", "git timed out") if a[0] == "diff" else real(cwd, *a, **k))
    with pytest.raises(RuntimeError, match="git diff: git timed out"):
        council.material(str(c))


def test_material_survives_latin1_bytes(tmp_path):
    c = _clone(tmp_path)
    (c / "a.txt").write_bytes(b"caf\xe9\n")
    assert "\ufffd" in council.material(str(c))["diff"]


# --- the loop ------------------------------------------------------------
import os
from types import SimpleNamespace

from bridge import goals, notices, paths, queue_manager, state, tickets, waits

_MAT = {"base": "b", "head": "h", "commits": [["abc", "fix push"]], "files": 2, "add": 9, "del": 3,
        "untracked": [], "diff": "DIFF", "truncated": False, "left_out": []}


def _said(score, *found):
    """A seat's answer; each finding is (sev, file, line)."""
    return {"ok": True, "score": score, "summary": f"says {score}",
            "findings": [{"sev": s, "file": f, "line": n, "title": f"{s} at {f}:{n}"} for s, f, n in found]}


@pytest.fixture
def rig(monkeypatch):
    """No real reviewer, queue, turn or ping: rounds run inline, each seat answers
    from its list, and the queue's snapshot lists `items`: by default the fix
    prompt, run and done (the queue keeps an item that ran)."""
    r = SimpleNamespace(queued=[], items=[{"id": "item-1", "status": "done", "job_id": None}], removed=[],
                        kinds=[], woke=[], mat=_MAT, claude=[], codex=[])
    monkeypatch.setattr(council, "_spawn", lambda fn, *a: fn(*a))
    monkeypatch.setattr(council, "settings", lambda: dict(council.DEFAULTS))
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: r.queued.append(kw) or "item-1")
    monkeypatch.setattr(queue_manager, "snapshot", lambda sid: {"items": list(r.items)})
    monkeypatch.setattr(queue_manager, "remove", lambda sid, iid: r.removed.append(iid))
    monkeypatch.setattr(runner, "_notify", lambda chat, text, kb=None, **kw: r.kinds.append(kw["kind"]))
    monkeypatch.setattr(waits, "target_ended", r.woke.append)
    monkeypatch.setattr(council, "material", lambda cwd: r.mat)
    monkeypatch.setattr(council, "counts", lambda cwd: r.mat)
    monkeypatch.setattr(council, "seat_claude", lambda *a, **k: r.claude.pop(0))
    monkeypatch.setattr(council, "seat_codex", lambda *a, **k: r.codex.pop(0))
    monkeypatch.setattr(council, "seats_for", lambda session, s: {"claude": "on", "codex": "on"})
    r.session = store.create_session(555, "/counciltest", origin="dashboard")
    r.sid = r.session["id"]
    return r


def _spinning(b):
    return [k for k, v in b["seats"].items() if v["state"] == "running"]


def _job(rig, jid, result="", status="done", texts=(), events=()):
    return SimpleNamespace(id=jid, store_session_id=rig.sid, status=status, interrupted=False,
                           result=result, texts=list(texts), events=list(events), chat_id=555, runtime=None)


_FIX = ("should", "s.py", 5)    # something to fix: a round under the bar with nothing in it stops


def test_start_scores_a_round_and_queues_the_fix_prompt(rig):
    rig.claude, rig.codex = [_said(7.0, ("must", "git.py", 584))], [_said(8.0, ("must", "git.py", 584))]
    b = council.start(rig.session, "/tmp")
    assert b["status"] == "fixing" and b["score"] == 7.5
    assert len(rig.queued) == 1
    assert rig.queued[0]["prompt"].startswith("[council 1/5] 7.5 of 9.0") and rig.queued[0]["surface"] == "council"
    assert store.get_council(rig.sid)["item"] == "item-1"


def test_round_that_passes_notifies_once(rig):
    rig.claude, rig.codex = [_said(9.4, ("should", "a.py", 1))], [_said(9.2)]
    assert council.start(rig.session, "/tmp")["status"] == "passed"
    assert rig.kinds == ["council_passed"] and not rig.queued


def test_a_round_without_gain_stops_and_notifies(rig):
    rig.claude, rig.codex = [_said(7.0, _FIX), _said(6.9)], [_said(7.0, _FIX), _said(6.9)]
    council.start(rig.session, "/tmp")
    assert council.after_turn(_job(rig, "j1")) is True
    c = council.get(rig.sid)
    assert c["status"] == "stopped" and "didn't raise" in c["reason"]
    assert rig.kinds[-1] == "council_stopped"


def test_after_turn_waits_for_the_council_turn(rig):
    rig.claude, rig.codex = [_said(7.0, _FIX), _said(7.6, _FIX), _said(8.2)], [_said(7.0, _FIX), _said(7.6, _FIX), _said(8.2)]
    council.start(rig.session, "/tmp")
    rig.items = [{"id": "item-1", "status": "queued", "job_id": None}]
    assert council.after_turn(_job(rig, "j-yours")) is False          # your turn; the fix still waits
    rig.items = [{"id": "item-1", "status": "running", "job_id": "j-fix"}]
    assert council.after_turn(_job(rig, "j-yours")) is False          # yours ended as the fix began
    assert council.get(rig.sid)["round"] == 1
    rig.items = [{"id": "item-1", "status": "done", "job_id": "j-fix"}]
    assert council.after_turn(_job(rig, "j-fix")) is True             # the fix turn's own end
    assert council.get(rig.sid)["round"] == 2
    rig.items = []                                                    # gone: steered into this turn
    steer = {"type": "steer", "text": "[council 2/5] 7.6 of 9.0\n1. SHOULD · s.py:5", "images": []}
    assert council.after_turn(_job(rig, "j-other", events=[steer])) is True
    assert council.get(rig.sid)["round"] == 3


def test_after_turn_records_answers(rig):
    rig.claude = [_said(7.0, ("must", "git.py", 584), ("should", "x.py", 10)), _said(8.0)]
    rig.codex = [_said(7.0, ("must", "git.py", 584)), _said(8.0)]
    council.start(rig.session, "/tmp")
    council.after_turn(_job(rig, "j1", result="1. NO: not a bug"))
    f = council.get(rig.sid)["rounds"][0]["findings"]
    assert [(x["state"], x["answer"]) for x in f] == [("answered", "not a bug"), ("fixed", "")]


def test_one_seat_failing_scores_on_the_other(rig, monkeypatch):
    rig.claude = [_said(7.0, ("must", "a.py", 1), ("must", "b.py", 9))]
    rig.codex = [{"ok": False, "error": "timed out"}]
    b = council.start(rig.session, "/tmp")
    assert b["score"] == 7.0 and b["seats"]["codex"]["state"] == "error"
    assert b["rounds"][0]["blocking"] == 2
    # A seat that never answers costs the round that seat, not the round.
    gate = threading.Event()
    monkeypatch.setattr(council, "SEAT_TIMEOUT", -29.8)              # the join waits 0.2 s
    monkeypatch.setattr(council, "seat_codex", lambda *a, **k: gate.wait(5) and None)
    rig.claude = [_said(8.0)]
    council.after_turn(_job(rig, "j1"))
    b = council.brief(rig.sid)
    gate.set()
    assert b["rounds"][-1]["score"] == 8.0 and b["seats"]["codex"]["error"] == "timed out"


def test_restart_marks_a_live_looking_run_stopped(rig):
    # The bridge restarts by os.execv in place: same pid, a new boot.
    old = f"{os.getpid()}:1"
    running = {"claude": {"state": "running", "score": None, "summary": "", "error": ""}}
    store.set_council(rig.sid, {"status": "reviewing", "pid": os.getpid(), "boot": old, "round": 2,
                                "rounds": [], "seats": running})
    c = council.get(rig.sid)
    assert c["status"] == "stopped" and "restart" in c["reason"]
    assert store.get_council(rig.sid)["status"] == "stopped"          # saved
    assert c["seats"]["claude"]["state"] == "stopped"                 # no spinner on a dead round
    store.set_council(rig.sid, {"status": "fixing", "boot": old, "item": "gone", "round": 1, "rounds": []})
    c = council.get(rig.sid)
    assert c["status"] == "stopped" and "restart" in c["reason"]
    # The queue outlives a restart: a fix prompt still in it runs, and its end goes on.
    rig.items = [{"id": "kept", "status": "queued", "job_id": None}]
    store.set_council(rig.sid, {"status": "fixing", "boot": old, "item": "kept", "round": 1, "rounds": []})
    assert council.get(rig.sid)["status"] == "fixing"
    # In this boot an item gone from the queue was steered in or removed: after_turn's to judge.
    store.set_council(rig.sid, {"status": "fixing", "boot": council._BOOT, "item": "gone", "round": 1, "rounds": []})
    assert council.get(rig.sid)["status"] == "fixing"


def test_nothing_left_to_review_stops_and_says_so(rig):
    """Round 2 finds nothing: the fix turn's DONE went to the council, so the stop is the news."""
    rig.claude, rig.codex = [_said(7.0, _FIX)], [_said(7.0, _FIX)]
    council.start(rig.session, "/tmp")
    rig.mat = None
    council.after_turn(_job(rig, "j1"))
    b = council.brief(rig.sid)
    assert b["status"] == "stopped" and b["reason"] == "nothing left to review"
    assert rig.kinds[-1] == "council_stopped" and _spinning(b) == []


def test_a_git_failure_stops_the_round_with_its_message(rig, monkeypatch):
    def boom(cwd):
        raise RuntimeError("git diff: git timed out")
    monkeypatch.setattr(council, "material", boom)
    b = council.start(rig.session, "/tmp")
    assert b["status"] == "stopped" and b["reason"] == "git diff: git timed out"
    assert _spinning(b) == [] and b["seats"]["claude"]["state"] == "stopped"


def test_start_refuses_when_running_busy_or_empty(rig, monkeypatch):
    monkeypatch.setattr(state, "is_running", lambda sid: True)
    with pytest.raises(ValueError, match="running"):
        council.start(rig.session, "/tmp")
    monkeypatch.setattr(state, "is_running", lambda sid: False)
    rig.items = [{"id": "item-1", "status": "queued", "job_id": None}]
    store.set_council(rig.sid, {"status": "fixing", "boot": council._BOOT, "item": "item-1", "round": 1, "rounds": []})
    with pytest.raises(ValueError, match="busy"):
        council.start(rig.session, "/tmp")
    store.set_council(rig.sid, None)
    rig.mat = None
    with pytest.raises(ValueError, match="nothing"):
        council.start(rig.session, "/tmp")


def test_actions(rig):
    rig.claude = [_said(9.5, ("must", "a.py", 1), ("should", "b.py", 9))]
    rig.codex = [_said(9.5, ("must", "a.py", 1))]
    council.start(rig.session, "/tmp")
    rig.items = [{"id": "item-1", "status": "queued", "job_id": None}]
    b = council.act(rig.session, "stop")
    assert b["status"] == "stopped" and b["reason"] == "you stopped it" and rig.removed == ["item-1"]
    b = council.act(rig.session, "side", "a.py:1")                    # the only blocker, at 9.5
    assert b["status"] == "passed" and rig.kinds[-1] == "council_passed"
    at = store.get_council(rig.sid)["at"]
    b = council.act(rig.session, "advice")
    assert rig.queued[-1]["prompt"].startswith("[council advice]\n1. SHOULD · b.py:9")
    assert "a.py" not in rig.queued[-1]["prompt"] and b["advice_sent"] and b["status"] == "passed"
    assert store.get_council(rig.sid)["at"] == at                     # the passed run's time stays put
    rig.claude, rig.codex = [_said(7.0, ("must", "c.py", 3))], [_said(7.0, ("must", "c.py", 3))]
    council.start(rig.session, "/tmp")
    council.act(rig.session, "stop")
    b = council.act(rig.session, "fix", "c.py:3")
    assert rig.queued[-1]["prompt"].startswith("[council 1/6] the user wants this fixed\n1. MUST · c.py:3")
    assert b["status"] == "fixing" and b["max_rounds"] == 6
    rig.mat, rig.items = None, [{"id": "item-1", "status": "done", "job_id": "j1"}]
    council.after_turn(_job(rig, "j1"))                               # round 2: nothing to read
    rig.mat, rig.claude, rig.codex = _MAT, [_said(8.0)], [_said(8.0)]
    b = council.act(rig.session, "more")
    assert b["max_rounds"] == 8 and b["round"] == 3 and b["rounds"][-1]["score"] == 8.0
    with pytest.raises(ValueError):
        council.act(rig.session, "nope")


def test_more_after_a_stall_sends_the_fix_first(rig):
    """The stop left the last round's findings unsent: a re-read of the same code
    would only stall again, so the loop goes on with the fix."""
    must = ("must", "a.py", 1)
    rig.claude, rig.codex = [_said(7.0, _FIX), _said(6.9, must)], [_said(7.0, _FIX), _said(6.9, must)]
    council.start(rig.session, "/tmp")
    council.after_turn(_job(rig, "j1"))
    b = council.act(rig.session, "more")
    assert b["status"] == "fixing" and b["max_rounds"] == 7 and b["round"] == 2
    assert rig.queued[-1]["prompt"].startswith("[council 2/7] 6.9 of 9.0")


def test_more_waits_for_the_session_turn(rig, monkeypatch):
    """2 more rounds can start a review at once, so like RUN it never does mid-turn."""
    rig.claude, rig.codex = [_said(7.0, _FIX), _said(7.0)], [_said(7.0, _FIX), _said(7.0)]
    council.start(rig.session, "/tmp")
    council.after_turn(_job(rig, "j1"))                               # round 2 didn't raise it: stopped
    monkeypatch.setattr(state, "is_running", lambda sid: True)
    with pytest.raises(ValueError, match="running"):
        council.act(rig.session, "more")
    c = council.get(rig.sid)
    assert c["status"] == "stopped" and c["max_rounds"] == 5 and c["round"] == 2


def test_a_round_stopped_while_seats_read_is_dropped(rig, monkeypatch):
    def claude(*a, **k):
        council.act(rig.session, "stop")                                 # you tap Stop mid-read
        return _said(9.5)
    monkeypatch.setattr(council, "seat_claude", claude)
    rig.codex = [_said(9.5)]
    b = council.start(rig.session, "/tmp")
    assert b["status"] == "stopped" and b["reason"] == "you stopped it" and b["rounds"] == []
    assert rig.kinds == [] and _spinning(b) == []                     # Stop: no ping, no spinner


def test_a_fix_turn_that_fails_stops_the_run(rig, monkeypatch):
    rig.claude, rig.codex = [_said(7.0, _FIX)], [_said(7.0, _FIX)]
    council.start(rig.session, "/tmp")
    assert council.after_turn(_job(rig, "j1", status="error")) is False
    c = council.get(rig.sid)
    assert c["status"] == "stopped" and c["reason"] == "the fix turn stopped"
    assert rig.kinds[-1] == "council_stopped"
    monkeypatch.setattr(store, "get_council", lambda sid: 1 / 0)
    assert council.after_turn(_job(rig, "j2")) is False               # never raises into a turn


def test_brief_reads_the_run(rig):
    b = council.brief(rig.sid)
    assert b["status"] == "idle" and b["bar"] == 9.0 and b["score"] is None
    assert b["seats"]["codex"]["state"] == "on"
    must = ("must", "git.py", 578)
    rig.claude = [_said(7.0, must, ("should", "x.py", 1)), _said(7.5, must), _said(8.0, must, ("nit", "y.py", 2))]
    rig.codex = [_said(7.0, must), _said(7.5, must), _said(8.0, must)]
    council.start(rig.session, "/tmp")
    council.after_turn(_job(rig, "j1", result="1. NO: not a bug"))
    council.after_turn(_job(rig, "j2", result="1. NO: still not"))
    b = council.brief(rig.sid, "/tmp", full=True)
    assert [r["score"] for r in b["rounds"]] == [7.0, 7.5, 8.0] and b["score"] == 8.0
    assert [(f["file"], f["blocking"]) for f in b["findings"]] == [("git.py", True), ("y.py", False)]
    assert [f["file"] for f in b["advice"]] == ["y.py"] and b["previous"][0]["state"] == "answered"
    assert b["stuck"]["rounds"] == 2 and b["stuck"]["answer"] == "still not"
    assert b["fixed_total"] == 1 and b["elapsed"] >= 0
    assert b["material"] == {"commits": [["abc", "fix push"]], "files": 2, "add": 9, "del": 3}


def test_council_prompts_do_not_rearm_goals():
    assert "[council" in goals._BRIDGE_PROMPTS
    assert notices.CATALOG["council_passed"] == ("done", "news", "session")
    assert notices.CATALOG["council_stopped"] == ("ask", "needs", "session")


def test_runner_asks_the_council_first(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("asked after the council took the turn")
    monkeypatch.setattr(tickets, "after_turn", lambda job: False)
    monkeypatch.setattr(council, "after_turn", lambda job: True)
    monkeypatch.setattr(paths, "continue_after_turn", boom)
    monkeypatch.setattr(goals, "continue_after_turn", boom)
    assert runner._continue_after_turn(SimpleNamespace(store_session_id="s")) is True   # noqa: SLF001


def test_after_turn_leaves_the_lock_alone_without_a_live_run(rig, monkeypatch):
    """Every turn end in the bridge asks; only a fixing run may wait on the lock."""
    class Tripwire:
        hits = 0

        def __enter__(self):
            Tripwire.hits += 1
            raise AssertionError("took the council lock")

        def __exit__(self, *a):
            return False
    monkeypatch.setattr(council, "_lock", Tripwire())
    assert council.after_turn(_job(rig, "j0")) is False                # no council here
    store.set_council(rig.sid, {"status": "passed", "boot": council._BOOT, "rounds": []})
    assert council.after_turn(_job(rig, "j0")) is False                # one that's over
    assert Tripwire.hits == 0
    store.set_council(rig.sid, {"status": "fixing", "boot": council._BOOT, "item": "item-1", "rounds": []})
    council.after_turn(_job(rig, "j0"))                                # a live one still asks
    assert Tripwire.hits == 1


def test_a_finished_run_wakes_the_sessions_waiting_on_it(rig):
    """A council's True skipped the turn's end, where waits are woken: the verdict wakes them."""
    rig.claude, rig.codex = [_said(9.4)], [_said(9.2)]
    council.start(rig.session, "/tmp")
    assert [j.store_session_id for j in rig.woke] == [rig.sid]
    j = rig.woke[0]
    assert (j.status, j.result, j.texts) == ("done", "Council passed · 9.3 in 1 round", [])
    assert isinstance(j.elapsed, int) and j.elapsed >= 0
    rig.claude, rig.codex = [_said(7.0, _FIX), _said(6.9)], [_said(7.0, _FIX), _said(6.9)]
    council.start(rig.session, "/tmp")
    council.after_turn(_job(rig, "j1"))
    assert [j.store_session_id for j in rig.woke] == [rig.sid, rig.sid]
    assert rig.woke[1].result == "Council stopped · round 2 didn't raise the score"
    rig.claude, rig.codex = [_said(7.0, _FIX)], [_said(7.0, _FIX)]
    council.start(rig.session, "/tmp")
    council.after_turn(_job(rig, "j2", status="error"))               # its own end wakes them
    assert len(rig.woke) == 2


# --- final review fixes ---------------------------------------------------

def test_material_without_an_upstream_reads_from_the_local_default_first(tmp_path):
    """#2: a branch cut from a local main that is ahead of origin reviews only its own commits."""
    c = _clone(tmp_path)
    (c / "m.txt").write_text("main only\n")
    _git(c, "add", "."); _git(c, "commit", "-qm", "unpushed on main")
    _git(c, "branch", "--unset-upstream")
    # On the default branch itself the local one is HEAD: what origin lacks.
    assert [s for _, s in council.material(str(c))["commits"]] == ["unpushed on main"]
    _git(c, "checkout", "-qb", "feat")                                  # no upstream
    (c / "f.txt").write_text("feature\n")
    _git(c, "add", "."); _git(c, "commit", "-qm", "own")
    m = council.material(str(c))
    assert [s for _, s in m["commits"]] == ["own"] and "m.txt" not in m["diff"] and m["files"] == 1
    # No local default branch: origin's.
    _git(c, "remote", "set-head", "origin", "main")
    _git(c, "branch", "-qD", "main")
    assert [s for _, s in council.material(str(c))["commits"]] == ["own", "unpushed on main"]


def test_the_reviewer_prompt_fits_one_argv_string(tmp_path):
    """#4: the Claude seat's prompt is one argument, and Linux caps one at 128 KiB."""
    c = _clone(tmp_path)
    for i in range(300):
        (c / f"tracked-{i:03}-{'t' * 60}.txt").write_text("é" * 1_000 + "\n")    # 2 bytes a char
    _git(c, "add", "."); _git(c, "commit", "-qm", "many")
    for i in range(300):
        (c / f"untracked-{i:03}-{'u' * 60}.txt").write_text("u\n")
    m = council.material(str(c))
    assert len(m["untracked"]) == 300 and len(m["left_out"]) > 200
    p = council.review_prompt(m, [], [])
    assert len(p.encode()) < 120_000
    assert "and 250 more" in p and f"and {len(m['left_out']) - 50} more" in p


def test_the_full_brief_counts_without_reading_the_diff(tmp_path, monkeypatch):
    """#6: the tab's idle poll, every 15 s, runs git log and --numstat, never the diff's text."""
    c = _clone(tmp_path)
    (c / "b.txt").write_text("two\nlines\n")
    _git(c, "add", "."); _git(c, "commit", "-qm", "second")
    (c / "a.txt").write_text("one\nmore\n")
    calls, real = [], council.git._run
    monkeypatch.setattr(council.git, "_run", lambda cwd, *a, **k: calls.append(a) or real(cwd, *a, **k))
    sid = store.create_session(555, "/counciltest", origin="dashboard")["id"]
    m = council.brief(sid, str(c), full=True)["material"]
    assert [s for _, s in m["commits"]] == ["second"] and (m["files"], m["add"], m["del"]) == (2, 3, 0)
    assert [a for a in calls if a[0] == "diff" and "--numstat" not in a] == []


def test_a_git_failure_leaves_the_material_out_of_the_brief(rig, monkeypatch):
    """#7: not null ("nothing to review"): no field at all, so the tab keeps its last read."""
    def boom(cwd):
        raise RuntimeError("git diff: git timed out")
    monkeypatch.setattr(council, "counts", boom)
    assert "material" not in council.brief(rig.sid, "/tmp", full=True)
    rig.mat = None
    monkeypatch.setattr(council, "counts", lambda cwd: rig.mat)
    assert council.brief(rig.sid, "/tmp", full=True)["material"] is None


def test_under_the_bar_with_nothing_to_fix_stops(rig):
    """#5: never an empty fix prompt. The stop says so, like any other."""
    rig.claude, rig.codex = [_said(7.0)], [_said(7.5)]
    b = council.start(rig.session, "/tmp")
    assert b["status"] == "stopped" and b["reason"] == "under the bar, but they listed nothing to fix"
    assert not rig.queued and rig.kinds == ["council_stopped"] and _spinning(b) == []


def test_a_fix_prompt_that_left_the_queue(rig):
    """#3: removed (× in QUEUE) or moved, the next turn isn't the fix: the run stops
    and that turn keeps its DONE (False). Steered into a turn, that turn is the fix."""
    rig.claude, rig.codex = [_said(7.0, _FIX), _said(8.0, _FIX)], [_said(7.0, _FIX), _said(8.0, _FIX)]
    council.start(rig.session, "/tmp")
    rig.items = []
    assert council.after_turn(_job(rig, "j-yours")) is False
    c = council.get(rig.sid)
    assert (c["status"], c["reason"], c["round"]) == ("stopped", "the fix prompt left the queue", 1)
    assert rig.kinds == ["council_stopped"] and rig.woke == []        # the turn's own end wakes its waiters
    council.act(rig.session, "more")                                  # its finding was never sent: sent now
    steer = {"type": "steer", "text": rig.queued[-1]["prompt"], "images": []}
    assert council.after_turn(_job(rig, "j-steered", events=[steer])) is True
    assert council.get(rig.sid)["round"] == 2


def test_an_objection_anywhere_in_the_fix_turn_is_recorded(rig):
    """#9: the whole turn's text, not only its last."""
    rig.claude = [_said(7.0, ("must", "git.py", 584), ("should", "x.py", 10)), _said(8.0)]
    rig.codex = [_said(7.0, ("must", "git.py", 584)), _said(8.0)]
    council.start(rig.session, "/tmp")
    texts = ["1. NO: not a bug, see runner.py:271", "Now x.py.", "Done: fixed x.py."]
    council.after_turn(_job(rig, "j1", result=texts[-1], texts=texts))
    f = council.get(rig.sid)["rounds"][0]["findings"]
    assert [(x["state"], x["answer"]) for x in f] == [("answered", "not a bug, see runner.py:271"), ("fixed", "")]
