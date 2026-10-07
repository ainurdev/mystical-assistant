"""A PR's checks as one word (bridge/github.py checks_state / pr_checks): what a
RIVENDELL DONE card shows beside its PR link.
Run: python -m pytest tests/test_github_checks.py -v"""

import json

import pytest

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


# --- issue_spec: the GitHub issue a Rivendell task's description defers to ---

_T26 = ("From GitHub: [#43](https://github.com/ainurhq/ibgroups_operations/issues/43). "
        "The issue was closed when tracking moved to Teamwork; its full spec stays there.")
_BODY = ("# T26 — Moneybird OAuth + connection storage\n\n"
         "> Wire up Moneybird the same way TeamLeader is wired.\n\n"
         "**Status:** ready · **Blocks:** T27\n\n"
         "## Context\n\nMoneybird is a Dutch accounting platform.")


def test_issue_spec_follows_the_first_issue_link(monkeypatch):
    calls = []

    def run(*args, **kw):
        calls.append(args)
        return 0, json.dumps({"number": 43, "title": "T26 — Moneybird OAuth + connection storage",
                              "state": "OPEN", "url": "https://github.com/ainurhq/ibgroups_operations/issues/43",
                              "body": _BODY}), ""
    monkeypatch.setattr(github, "_run", run)
    spec = github.issue_spec(_T26)
    assert calls == [("gh", "issue", "view", "43", "-R", "ainurhq/ibgroups_operations",
                      "--json", "number,title,state,url,body")]
    assert spec["number"] == 43 and spec["state"] == "OPEN"
    # The opening only: the title heading is dropped (the card already shows
    # it), and the excerpt stops at the first section heading.
    assert spec["body"] == ("> Wire up Moneybird the same way TeamLeader is wired.\n\n"
                            "**Status:** ready · **Blocks:** T27")


def test_issue_spec_caps_a_long_opening_at_a_paragraph():
    para = "word " * 60
    body = "\n\n".join([para.strip()] * 5)
    out = github._opening(body)
    assert len(out) <= github._OPENING_MAX + 1 and out.endswith("…")
    assert "\n\n" in out, "cut at a paragraph boundary, not mid-paragraph"


def test_issue_spec_without_a_link_asks_nothing(monkeypatch):
    monkeypatch.setattr(github, "_run", lambda *a, **k: pytest.fail("must not call gh"))
    assert github.issue_spec("Plain description, no links.") is None
    assert github.issue_spec(None) is None


def test_issue_spec_when_gh_fails_keeps_the_link(monkeypatch):
    monkeypatch.setattr(github, "_run", lambda *a, **k: (1, "", "HTTP 404"))
    assert github.issue_spec(_T26) == {
        "number": 43, "url": "https://github.com/ainurhq/ibgroups_operations/issues/43",
        "title": None, "state": None, "body": None}
