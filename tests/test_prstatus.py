"""bridge/prstatus.py: the PR chip's data. gh is faked at prstatus._gh. The
canned JSON and log lines are in the shapes real gh 2.92 returned on
2026-10-06 (ainurhq/rivendell, cli/cli, python/cpython).
Run: python3 -m pytest tests/test_prstatus.py -q"""

import json

import pytest

from bridge import prstatus, store

RUN = "https://github.com/acme/rivendell/actions/runs/9"


def _run(name, status="COMPLETED", conclusion="SUCCESS", job=1,
         started="2026-10-06T12:01:00Z", workflow="CI"):
    done = status == "COMPLETED"
    return {"__typename": "CheckRun", "name": name, "workflowName": workflow,
            "status": status, "conclusion": conclusion if done else "",
            "startedAt": started,
            "completedAt": "2026-10-06T12:03:14Z" if done else "0001-01-01T00:00:00Z",
            "detailsUrl": f"{RUN}/job/{job}"}


def _raw(**over):
    raw = {"number": 131, "title": "Inbox: group action items by client",
           "url": "https://github.com/acme/rivendell/pull/131", "state": "OPEN",
           "baseRefName": "main", "headRefName": "feat/inbox-grouping",
           "headRefOid": "abc123", "additions": 412, "deletions": 88,
           "createdAt": "2026-10-06T12:00:00Z", "mergedAt": None,
           "statusCheckRollup": [], "reviewDecision": "", "reviewRequests": [],
           "latestReviews": []}
    raw.update(over)
    return raw


# --- normalize / chip_state ---------------------------------------------------

def test_checks_failures_first_skips_dropped_zero_times_blank():
    pr = prstatus.normalize(_raw(statusCheckRollup=[
        _run("lint"),
        _run("e2e", status="IN_PROGRESS"),
        _run("backend", conclusion="FAILURE", job=7),
        _run("label", conclusion="SKIPPED"),
        {"__typename": "StatusContext", "context": "pre-commit.ci - pr",
         "state": "SUCCESS", "targetUrl": "https://pre-commit.ci/x",
         "startedAt": "2026-10-06T12:40:47Z"},
    ]))
    assert [c["name"] for c in pr["checks"]] == ["backend", "e2e", "lint", "pre-commit.ci - pr"]
    assert (pr["failed"], pr["running"], pr["passed"], pr["total"]) == (1, 1, 2, 4)
    assert pr["checks"][1]["completed"] == ""       # Go's zero time is not a finish
    assert pr["checks"][3]["started"] == ""         # a commit status has no duration
    assert pr["status"] == "failing"


def test_a_commit_status_in_error_is_failing_and_pending_is_running():
    status = lambda st: {"__typename": "StatusContext", "context": f"ci/{st}", "state": st,
                         "targetUrl": "", "startedAt": "2026-10-06T12:00:00Z"}
    pr = prstatus.normalize(_raw(statusCheckRollup=[status("ERROR"), status("PENDING")]))
    assert [(c["name"], c["state"]) for c in pr["checks"]] == [("ci/ERROR", "fail"), ("ci/PENDING", "run")]


def test_a_rerun_keeps_only_the_newest_attempt():
    pr = prstatus.normalize(_raw(statusCheckRollup=[
        _run("backend", conclusion="FAILURE", started="2026-10-06T12:01:00Z"),
        _run("backend", started="2026-10-06T12:09:00Z"),
    ]))
    assert [(c["name"], c["state"]) for c in pr["checks"]] == [("backend", "pass")]


@pytest.mark.parametrize("over, want", [
    ({"state": "MERGED"}, "merged"),
    ({"state": "CLOSED"}, "closed"),
    ({"statusCheckRollup": [_run("a", conclusion="TIMED_OUT")]}, "failing"),
    ({"reviewDecision": "CHANGES_REQUESTED",
      "latestReviews": [{"author": {"login": "mahdi"}, "state": "CHANGES_REQUESTED",
                         "submittedAt": "2026-10-06T12:30:00Z", "body": ""}]}, "changes"),
    ({"statusCheckRollup": [_run("a"), _run("b", status="QUEUED")]}, "running"),
    ({"statusCheckRollup": [_run("a")], "reviewDecision": "APPROVED"}, "ready"),
    ({"statusCheckRollup": [_run("a")]}, "ready"),        # no review asked for anywhere
    ({"statusCheckRollup": [_run("a")], "reviewDecision": "REVIEW_REQUIRED"}, "review"),
    ({"statusCheckRollup": [_run("a")],
      "reviewRequests": [{"__typename": "User", "login": "mahdi"}]}, "review"),
])
def test_chip_state_is_sheet_c(over, want):
    assert prstatus.normalize(_raw(**over))["status"] == want


# --- failure_tail -------------------------------------------------------------

LOG = (
    "backend\tUNKNOWN STEP\t\N{BYTE ORDER MARK}2026-10-04T17:58:16.1814983Z ##[group]Runner Image Provisioner\n"
    "backend\tUNKNOWN STEP\t2026-10-04T17:59:15.6636537Z ##[group]Run pnpm test\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:41.0000000Z FAIL portal/portal-auth.service.spec.ts\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:41.1000000Z   ^[[31m● keeps a new secret sealed^[[39m\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:42.9000000Z Tests:       2 failed, 1950 passed\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:42.9483346Z ##[error]Process completed with exit code 1.\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:43.6719116Z Post job cleanup.\n"
    "backend\tUNKNOWN STEP\t2026-10-04T18:00:43.8360923Z Cleaning up orphan processes\n"
)


def test_failure_tail_cuts_cleanup_and_strips_prefixes_and_colour():
    tail = prstatus.failure_tail(LOG)
    assert tail.splitlines()[0] == "##[group]Runner Image Provisioner"   # BOM + stamp gone
    assert "  ● keeps a new secret sealed" in tail.splitlines()
    assert tail.endswith("##[error]Process completed with exit code 1.")
    assert "cleanup" not in tail.lower()
    assert prstatus.failure_tail(LOG, n=2) == (
        "Tests:       2 failed, 1950 passed\n##[error]Process completed with exit code 1.")


def test_failure_tail_without_an_error_marker_keeps_the_end():
    assert prstatus.failure_tail("a\tb\t2026-01-01T00:00:00Z x\ny\n", n=1) == "y"


# --- pings --------------------------------------------------------------------

def _pr(**over):
    pr = {"state": "OPEN", "sha": "s1", "failed": 0, "running": 0, "review": None}
    pr.update(over)
    return pr


def test_red_pings_once_per_commit_and_only_green_clears_it():
    pinged, fresh = prstatus.next_pings(set(), _pr(failed=1))
    assert fresh == ["failing:s1"]
    pinged, fresh = prstatus.next_pings(pinged, _pr(running=1))        # re-run going
    assert fresh == [] and "failing:s1" in pinged
    pinged, fresh = prstatus.next_pings(pinged, _pr(failed=1))         # same commit red again
    assert fresh == []
    pinged, fresh = prstatus.next_pings(pinged, _pr())                 # all green
    assert pinged == set()
    assert prstatus.next_pings(pinged, _pr(failed=1))[1] == ["failing:s1"]
    assert prstatus.next_pings({"failing:s1"}, _pr(sha="s2", failed=1))[1] == ["failing:s2"]


def test_a_review_pings_once_and_a_new_push_doesnt_repeat_it():
    review = {"by": "mahdi", "at": "2026-10-06T12:30:00Z"}
    pinged, fresh = prstatus.next_pings(set(), _pr(review=review))
    assert fresh == ["changes:mahdi:2026-10-06T12:30:00Z"]
    assert prstatus.next_pings(pinged, _pr(sha="s2", review=review))[1] == []
    assert prstatus.next_pings(pinged, _pr())[0] == set()              # decision moved on


def test_merged_and_closed_never_ping():
    assert prstatus.next_pings(set(), _pr(state="MERGED", failed=1)) == (set(), [])


def test_ping_text_names_the_red_checks():
    red = prstatus.normalize(_raw(statusCheckRollup=[_run("backend", conclusion="FAILURE")]))
    assert prstatus.ping_text(red, "failing:abc123").splitlines() == [
        "✕ PR #131 checks failing — backend",
        "Inbox: group action items by client · ⎇ feat/inbox-grouping",
        "https://github.com/acme/rivendell/pull/131"]
