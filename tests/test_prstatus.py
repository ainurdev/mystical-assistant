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
           "latestReviews": [], "reviews": []}
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


def _review(login, state, at, assoc="MEMBER", body=""):
    return {"author": {"login": login}, "authorAssociation": assoc, "state": state,
            "submittedAt": at, "body": body}


def test_a_comment_after_a_request_for_changes_leaves_the_request_standing():
    """mattermost/matterwick#104's shape: a reviewer asked for changes, then
    commented, so latestReviews shows only the comment. Their standing review
    is still the request. A bot with no write access doesn't count, as it
    doesn't for reviewDecision."""
    asked = _review("mahdi", "CHANGES_REQUESTED", "2026-10-06T12:30:00Z", body="two things")
    later = _review("mahdi", "COMMENTED", "2026-10-06T12:40:00Z")
    bot = _review("coderabbitai", "CHANGES_REQUESTED", "2026-10-06T12:50:00Z", assoc="NONE")
    pr = prstatus.normalize(_raw(reviewDecision="CHANGES_REQUESTED",
                                 latestReviews=[later, bot], reviews=[asked, later, bot]))
    assert pr["review"]["by"] == "mahdi" and pr["review"]["body"] == "two things"
    assert pr["reviews"] == [{"by": "mahdi", "state": "CHANGES_REQUESTED", "at": "2026-10-06T12:30:00Z"}]
    assert prstatus.alerts(pr) == {"changes:mahdi:2026-10-06T12:30:00Z"}   # so it pings


def test_the_request_is_found_when_latest_reviews_is_empty():
    pr = prstatus.normalize(_raw(reviewDecision="CHANGES_REQUESTED", latestReviews=[],
                                 reviews=[_review("mahdi", "CHANGES_REQUESTED", "2026-10-06T12:30:00Z")]))
    assert pr["review"]["by"] == "mahdi"


def test_an_approval_after_a_request_for_changes_replaces_it():
    pr = prstatus.normalize(_raw(reviewDecision="APPROVED", reviews=[
        _review("mahdi", "CHANGES_REQUESTED", "2026-10-06T12:30:00Z"),
        _review("mahdi", "APPROVED", "2026-10-06T13:00:00Z"),
        _review("mahdi", "COMMENTED", "2026-10-06T13:10:00Z")]))
    assert pr["review"] is None
    assert [r["state"] for r in pr["reviews"]] == ["APPROVED"]


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
    ({"statusCheckRollup": [_run("a")], "isDraft": True}, "review"),        # a draft is never READY
    ({"statusCheckRollup": [_run("a")], "isDraft": True, "reviewDecision": "APPROVED"}, "review"),
    # Conflicts block the merge button whatever CI says, so they come before a red check.
    ({"mergeable": "CONFLICTING", "statusCheckRollup": [_run("a", conclusion="FAILURE")]}, "conflicts"),
    ({"mergeable": "CONFLICTING", "state": "MERGED"}, "merged"),
    ({"mergeable": "UNKNOWN", "statusCheckRollup": [_run("a")]}, "ready"),   # GitHub still computing
])
def test_chip_state_is_sheet_c(over, want):
    assert prstatus.normalize(_raw(**over))["status"] == want


def test_conflicts_come_from_gh_mergeable():
    """gh's mergeable: CONFLICTING is the one answer that means it. MERGEABLE,
    UNKNOWN (GitHub computes it lazily) and a missing field are not conflicts."""
    assert prstatus.normalize(_raw(mergeable="CONFLICTING"))["conflicts"] is True
    for v in ("MERGEABLE", "UNKNOWN", None):
        assert prstatus.normalize(_raw(mergeable=v))["conflicts"] is False
    assert "mergeable" in prstatus.FIELDS.split(",")


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
    pr.setdefault("checks", [{"state": "fail"}] * pr["failed"])
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


def test_ping_text_caps_the_title_and_the_list_of_checks():
    pr = prstatus.normalize(_raw(title="[click me](https://evil.example) " + "x" * 300,
                                 statusCheckRollup=[_run(f"job{i}", conclusion="FAILURE") for i in range(7)]))
    first, where, _url = prstatus.ping_text(pr, "failing:abc123").splitlines()
    assert first == "✕ PR #131 checks failing — job0, job1, job2, job3, job4 +2 more"
    assert len(where.split(" · ⎇ ")[0]) <= 120


def test_pings_go_to_telegram_as_plain_text(monkeypatch):
    """A PR title is anyone's words: send()'s markdown → HTML would turn a
    [label](url) in it into a link, so pings skip it."""
    seen = []
    monkeypatch.setattr(prstatus.config, "NOTIFY_ENABLE", True)
    monkeypatch.setattr(prstatus.config, "DASH_CHAT_ID", 555)
    monkeypatch.setattr(prstatus.telegram, "tg", lambda method, **params: seen.append((method, params)))
    monkeypatch.setattr(prstatus.telegram, "send", lambda *a, **k: seen.append(("send", a)))
    pr = prstatus.normalize(_raw(title="[click](https://evil.example)",
                                 statusCheckRollup=[_run("backend", conclusion="FAILURE")]))
    prstatus._telegram("/r", "sid", pr, ["failing:abc123"])
    assert [m for m, _ in seen] == ["sendMessage"]
    assert "parse_mode" not in seen[0][1] and seen[0][1]["text"].startswith("✕ PR #131")


# --- reading gh: fetch, snapshot, Telegram ------------------------------------

def _fake_gh(monkeypatch, routes):
    """routes: [(args prefix, (rc, stdout, stderr))], matched in order."""
    calls = []

    def fake(*args, timeout=20):
        calls.append(args)
        for prefix, answer in routes:
            if args[:len(prefix)] == prefix:
                return answer
        raise AssertionError(f"unexpected gh call {args}")
    monkeypatch.setattr(prstatus, "_gh", fake)
    return calls


@pytest.fixture(autouse=True)
def sent(monkeypatch):
    """Fresh caches. gh's repo lookups are pinned. Telegram is captured and
    synchronous."""
    store.init()
    prstatus._cache.clear()
    prstatus._logs.clear()
    monkeypatch.setattr(prstatus.github, "remote_slug", lambda d: "acme/rivendell")
    monkeypatch.setattr(prstatus.git, "default_branch", lambda d: "main")
    monkeypatch.setattr(prstatus.git, "branches", lambda d: [
        "main", "feat/x", "feat/share", "feat/blip", "feat/ping", "feat/tg-down", "59", "#59",
        "+59", "--web"])
    monkeypatch.setattr(prstatus, "_spawn", lambda fn, *a: fn(*a))
    monkeypatch.setattr(prstatus.config, "NOTIFY_ENABLE", True)
    monkeypatch.setattr(prstatus.config, "DASH_CHAT_ID", 555)
    box = []
    monkeypatch.setattr(prstatus.telegram, "tg",
                        lambda method, **params: box.append(params["text"]))
    return box


# --- fetch --------------------------------------------------------------------

@pytest.mark.parametrize("answer, ttl", [
    ((1, "", 'no pull requests found for branch "feat/x"'), prstatus.TTL),
    ((4, "", "To get started with GitHub CLI, please run:  gh auth login"), prstatus.ERR_TTL),
    ((127, "", "[Errno 2] No such file or directory: 'gh'"), prstatus.ERR_TTL),
    ((1, "", "GraphQL: API rate limit exceeded for user ID 1."), prstatus.ERR_TTL),
    ((0, "not json", ""), prstatus.ERR_TTL),
])
def test_fetch_is_quiet_about_every_way_gh_cant_answer(monkeypatch, answer, ttl):
    _fake_gh(monkeypatch, [(("pr", "view"), answer)])
    assert prstatus.fetch("acme/rivendell", "feat/x") == (None, ttl)


def test_a_failing_check_carries_its_log_fetched_once_per_job(monkeypatch):
    calls = _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(_raw(statusCheckRollup=[
            _run("backend", conclusion="FAILURE", job=7)])), "")),
        (("run", "view", "--job", "7"), (0, LOG, "")),
    ])
    pr, _ = prstatus.fetch("acme/rivendell", "feat/x")
    assert pr["checks"][0]["log"].endswith("exit code 1.")
    prstatus.fetch("acme/rivendell", "feat/x")
    assert sum(1 for c in calls if c[0] == "run") == 1      # the job's log is cached


def test_a_log_that_isnt_there_yet_is_asked_for_again(monkeypatch):
    calls = _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(_raw(statusCheckRollup=[
            _run("backend", conclusion="FAILURE", job=7)])), "")),
        (("run", "view"), (1, "", "run 9 is still in progress; logs will be available when it is complete")),
    ])
    assert prstatus.fetch("acme/rivendell", "feat/x")[0]["checks"][0]["log"] == ""
    prstatus.fetch("acme/rivendell", "feat/x")
    assert sum(1 for c in calls if c[0] == "run") == 2


def test_a_log_gh_returns_empty_is_not_asked_for_again(monkeypatch):
    calls = _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(_raw(statusCheckRollup=[
            _run("backend", conclusion="FAILURE", job=7)])), "")),
        (("run", "view"), (0, "", "")),
    ])
    assert prstatus.fetch("acme/rivendell", "feat/x")[0]["checks"][0]["log"] == ""
    prstatus.fetch("acme/rivendell", "feat/x")
    assert sum(1 for c in calls if c[0] == "run") == 1


def test_a_cancelled_check_is_red_but_does_not_ping():
    pr = prstatus.normalize(_raw(statusCheckRollup=[_run("backend", conclusion="CANCELLED")]))
    assert pr["status"] == "failing"
    assert prstatus.alerts(pr) == set()
    both = prstatus.normalize(_raw(statusCheckRollup=[
        _run("backend", conclusion="CANCELLED"), _run("lint", conclusion="FAILURE")]))
    assert prstatus.alerts(both) == {"failing:abc123"}


def test_a_merged_pr_is_trusted_longer_and_fetches_no_logs(monkeypatch):
    calls = _fake_gh(monkeypatch, [(("pr", "view"), (0, json.dumps(_raw(state="MERGED", statusCheckRollup=[
        _run("backend", conclusion="FAILURE", job=7)])), ""))])
    pr, ttl = prstatus.fetch("acme/rivendell", "feat/x")
    assert pr["status"] == "merged" and ttl == prstatus.DONE_TTL > prstatus.TTL
    assert [c[0] for c in calls] == ["pr"]


def test_changes_requested_brings_that_reviews_inline_comments(monkeypatch):
    asked = _review("mahdi", "CHANGES_REQUESTED", "2026-10-06T12:30:00Z", body="two things")
    raw = _raw(reviewDecision="CHANGES_REQUESTED", latestReviews=[asked], reviews=[asked])
    _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(raw), "")),
        (("api", "repos/acme/rivendell/pulls/131/reviews?per_page=100"), (0, json.dumps([
            {"id": 11, "user": {"login": "mahdi"}, "state": "COMMENTED",
             "submitted_at": "2026-10-06T11:00:00Z"},
            {"id": 12, "user": {"login": "mahdi"}, "state": "CHANGES_REQUESTED",
             "submitted_at": "2026-10-06T12:30:00Z"}]), "")),
        (("api", "repos/acme/rivendell/pulls/131/comments?per_page=100"), (0, json.dumps([
            {"pull_request_review_id": 11, "path": "old.ts", "line": 1, "body": "earlier"},
            {"pull_request_review_id": 12, "path": "backend/src/group.service.ts",
             "line": 45, "original_line": 44, "body": "sort by client name"},
            {"pull_request_review_id": 12, "path": "frontend/inbox.tsx",
             "line": None, "original_line": 88, "body": "show the name "}]), "")),
    ])
    pr, _ = prstatus.fetch("acme/rivendell", "feat/x")
    assert pr["status"] == "changes"
    assert pr["review"]["body"] == "two things"
    assert pr["review"]["comments"] == [
        {"path": "backend/src/group.service.ts", "line": 45, "body": "sort by client name"},
        {"path": "frontend/inbox.tsx", "line": 88, "body": "show the name"}]   # outdated: original_line


# --- snapshot -----------------------------------------------------------------

def _clock(monkeypatch, t=1000.0):
    now = [t]
    monkeypatch.setattr(prstatus.time, "time", lambda: now[0])
    return now


def test_two_reads_inside_the_ttl_share_one_gh_call_and_force_has_a_floor(monkeypatch):
    now = _clock(monkeypatch)
    calls = _fake_gh(monkeypatch, [(("pr", "view"), (0, json.dumps(_raw()), ""))])
    a = prstatus.snapshot("/r", "feat/share")
    b = prstatus.snapshot("/r", "feat/share")
    assert len(calls) == 1 and a == b and a["pr"]["number"] == 131
    now[0] += 5
    prstatus.snapshot("/r", "feat/share", force=True)      # inside the floor: still cached
    assert len(calls) == 1
    now[0] += prstatus.FORCE_FLOOR
    prstatus.snapshot("/r", "feat/share", force=True)
    assert len(calls) == 2
    now[0] += prstatus.TTL
    prstatus.snapshot("/r", "feat/share")
    assert len(calls) == 3


def test_an_error_backs_off_keeps_the_last_chip_and_outlasts_force(monkeypatch):
    now = _clock(monkeypatch)
    _fake_gh(monkeypatch, [(("pr", "view"), (0, json.dumps(_raw()), ""))])
    prstatus.snapshot("/r", "feat/blip")
    calls = _fake_gh(monkeypatch, [(("pr", "view"), (1, "", "HTTP 403: API rate limit exceeded"))])
    now[0] += prstatus.TTL
    assert prstatus.snapshot("/r", "feat/blip")["pr"]["number"] == 131   # the last good chip stays
    now[0] += prstatus.FORCE_FLOOR
    prstatus.snapshot("/r", "feat/blip", force=True)
    assert len(calls) == 1                                  # backing off, force or not
    now[0] += prstatus.ERR_TTL
    prstatus.snapshot("/r", "feat/blip")
    assert len(calls) == 2


def test_no_chip_without_a_remote_or_on_the_default_branch(monkeypatch):
    calls = _fake_gh(monkeypatch, [])
    assert prstatus.snapshot("/r", "main")["pr"] is None
    assert prstatus.snapshot("/r", "")["pr"] is None
    monkeypatch.setattr(prstatus.github, "remote_slug", lambda d: None)
    assert prstatus.snapshot("/r2", "feat/x")["pr"] is None
    assert calls == []


def test_red_pings_telegram_once_even_across_a_restart(monkeypatch, sent):
    now = _clock(monkeypatch)
    _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(_raw(headRefOid="r1", statusCheckRollup=[
            _run("backend", conclusion="FAILURE", job=8)])), "")),
        (("run", "view"), (0, LOG, "")),
    ])
    snap = prstatus.snapshot("/r", "feat/ping", session="sid")
    assert snap["pinged"] == ["failing:r1"]
    assert len(sent) == 1 and sent[0].startswith("✕ PR #131 checks failing — backend")
    prstatus._cache.clear()                               # what a bridge restart does
    now[0] += prstatus.TTL
    assert prstatus.snapshot("/r", "feat/ping")["pinged"] == ["failing:r1"]
    assert len(sent) == 1


def test_an_all_digit_branch_gets_no_chip_rather_than_pr_number_59(monkeypatch):
    calls = _fake_gh(monkeypatch, [])
    assert prstatus.snapshot("/r", "59")["pr"] is None
    assert prstatus.snapshot("/r", "#59")["pr"] is None
    assert prstatus.snapshot("/r", "+59")["pr"] is None       # gh reads "+59" as 59 too
    assert calls == []


def test_the_branch_goes_to_gh_after_a_double_dash(monkeypatch):
    """A local branch can be called "--web"; after `--` gh reads it as a branch."""
    calls = _fake_gh(monkeypatch, [(("pr", "view"), (1, "", 'no pull requests found for branch "--web"'))])
    assert prstatus.snapshot("/r", "--web")["pr"] is None
    assert calls == [("pr", "view", "-R", "acme/rivendell", "--json", prstatus.FIELDS, "--", "--web")]


def test_telegram_failing_never_breaks_the_read(monkeypatch):
    _fake_gh(monkeypatch, [
        (("pr", "view"), (0, json.dumps(_raw(statusCheckRollup=[
            _run("backend", conclusion="FAILURE", job=9)])), "")),
        (("run", "view"), (1, "", "expired")),
    ])

    def down(*a, **k):
        raise OSError("telegram unreachable")
    monkeypatch.setattr(prstatus.telegram, "tg", down)
    snap = prstatus.snapshot("/r", "feat/tg-down")
    assert snap["pr"]["status"] == "failing" and snap["pinged"] == ["failing:abc123"]


def test_only_a_local_branch_reaches_gh(monkeypatch):
    """The route takes `branch` from a GET that any page can fire at the
    bridge (Host-gated, not token-gated), so only one of the repo's own
    branches is handed to gh: not a flag (`--web` opens a browser), not
    another repo's PR url, not a branch that isn't here."""
    calls = _fake_gh(monkeypatch, [])
    for branch in ("--help", "https://github.com/evil/repo/pull/1", "feat/not-here"):
        assert prstatus.snapshot("/r", branch)["pr"] is None
    assert calls == []


def test_a_branch_with_no_chip_is_not_cached(monkeypatch):
    """Any caller can make up branch names; refusing one must not leave a lock
    and a cache entry behind for each."""
    prstatus._locks.clear()
    _fake_gh(monkeypatch, [])
    for branch in ("feat/made-up-1", "feat/made-up-2", "main", "59", ""):
        prstatus.snapshot("/r", branch)
    assert prstatus._cache == {} and prstatus._locks == {}
