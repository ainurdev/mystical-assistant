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
    assert called[0]["opts"]["permission_mode"] == "read-only"


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
