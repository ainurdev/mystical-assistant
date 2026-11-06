from bridge import council, store

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
    sid = store.create_session(555, "/counciltest", origin="dashboard")
    store.set_council(sid, {"status": "passed"})
    assert store.get_council(sid) == {"status": "passed"}
    store.set_council(sid, None)
    assert store.get_council(sid) is None
