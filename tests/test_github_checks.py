"""A PR's checks as one word (bridge/github.py checks_state / pr_checks): what a
RIVENDELL DONE card shows beside its PR link.
Run: python -m pytest tests/test_github_checks.py -v"""

import json

from bridge import github


def test_any_failure_fails():
    assert github.checks_state([{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}]) == "fail"
    assert github.checks_state([{"state": "ERROR"}]) == "fail"


def test_anything_still_running_is_pending():
    assert github.checks_state([{"conclusion": "SUCCESS"},
                                {"status": "IN_PROGRESS", "conclusion": ""}]) == "pending"
    assert github.checks_state([{"state": "PENDING"}]) == "pending"


def test_all_green_or_skipped_passes():
    assert github.checks_state([{"conclusion": "SUCCESS"}, {"conclusion": "SKIPPED"},
                                {"state": "SUCCESS"}]) == "pass"


def test_no_checks_is_no_word():
    assert github.checks_state([]) is None and github.checks_state(None) is None


def test_pr_checks_reads_gh(monkeypatch):
    calls = []

    def run(*args, **kw):
        calls.append(args)
        return 0, json.dumps({"statusCheckRollup": [{"conclusion": "SUCCESS"}]}), ""
    monkeypatch.setattr(github, "_run", run)
    assert github.pr_checks("https://github.com/a/b/pull/7") == "pass"
    assert calls == [("gh", "pr", "view", "https://github.com/a/b/pull/7",
                      "--json", "statusCheckRollup")]


def test_pr_checks_without_gh_is_unknown(monkeypatch):
    monkeypatch.setattr(github, "_run", lambda *a, **k: (127, "", "gh: not found"))
    assert github.pr_checks("https://github.com/a/b/pull/7") is None
