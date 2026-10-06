"""A branch's pull request, the way the dashboard's chat header shows it: the
PR chip and its popover (review loop B/C, docs/superpowers/specs/review-loop.md).

One `gh pr view <branch> --json …` answers nearly everything: state, checks,
review decision. Why it is shaped like this:

- **gh, not the API.** The user's own `gh auth` is the credential. The bridge
  holds no GitHub token, the same as bridge/github.py.
- **Polled, cached, shared.** The dashboard asks every 60s while a session is
  open in a visible tab, on focus, and after a push. Each answer is cached for
  each (repo, branch) for TTL seconds, so two tabs on one session make one gh
  call. `force` (focus, a push) only shortens that to FORCE_FLOOR.
  ponytail: no server-side poller. A PR that no visible tab has open is not
  watched, so its pings wait for the next look. Add a timer here if pings
  must reach Telegram while every dashboard tab is closed.
- **Quiet when it can't know.** gh missing or signed out, no GitHub remote,
  the default branch, no PR, a rate limit, a timeout: each one is `pr: None`,
  and the chip just isn't drawn. Errors back off for ERR_TTL, because a rate
  limit doesn't lift in 45s. A blip after a good read keeps the last good PR
  instead of blinking the chip out.
- **The failure, not the log.** A failing GitHub Actions check carries the
  last LOG_LINES lines of its failed step (`gh run view --job <id>
  --log-failed`). The log is cut at the runner's last `##[error]` line,
  because what follows it is post-job cleanup. Timestamps and colour codes are
  stripped. Each job's log is fetched once, since a finished job's log never
  changes. Other CI (commit statuses, third-party check runs) has no log here,
  only its link.
- **Several PRs on one branch.** `gh pr view <branch>` answers with the
  newest PR whose head is that branch, open or not. It ignores forks'
  same-named branches. Checked 2026-10-06 on a repo with a closed and a merged
  PR on one branch: it returned the merged, newer one.
- **Pings once.** Checks turning red ping Telegram once per head commit. A
  changes-requested review pings once per review, so pushing a fix doesn't
  ping again. Pings are remembered in the settings table, so a bridge restart
  doesn't repeat them. An all-green read clears the failing ping, so a later
  red on the same commit pings again. The dashboard bell mirrors `pinged`.

Not built: merging (it stays on GitHub), PR state on session rows, the Mini App.
"""

import json
import re
import threading
import time

from bridge import browser, config, git, github, store, telegram

TTL = 45           # s: under the dashboard's 60s poll, so each poll reads fresh
FORCE_FLOOR = 10   # s: focus, visibilitychange and a push can all ask at once
ERR_TTL = 300      # s: gh broken or rate-limited, so wait five minutes
LOG_LINES = 60
FIELDS = ("number,title,state,url,baseRefName,headRefName,headRefOid,additions,"
          "deletions,createdAt,mergedAt,statusCheckRollup,reviewDecision,"
          "reviewRequests,latestReviews")

_PASS = {"SUCCESS", "NEUTRAL"}
_SKIP = {"SKIPPED", "STALE"}
_ORDER = {"fail": 0, "run": 1, "pass": 2}
_JOB_RE = re.compile(r"/actions/runs/\d+/job/(\d+)")
# gh starts each log line with "<job>\t<step>\t<ISO time> ", and the first one
# with a BOM as well.
_STAMP_RE = re.compile(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ?")
# Colour codes arrive raw, and also as caret text ("^[[31m"). A real Jest
# failure had both, 2026-10-06.
_ANSI_RE = re.compile(r"(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]")

_cache: dict = {}   # (repo_dir, branch) -> {"at", "ttl", "pr", "pinged"}
_locks: dict = {}   # (repo_dir, branch) -> Lock: one gh read per key at a time
_logs: dict = {}    # job id -> failure tail


def _ts(v) -> str:
    """For a check that hasn't started or finished, gh writes Go's zero time."""
    return "" if not v or str(v).startswith("0001-") else str(v)


def _check(c: dict) -> "dict | None":
    if c.get("__typename") == "StatusContext":
        st = c.get("state") or ""
        # A commit status has a creation time and no duration, so it gets no start.
        return {"name": c.get("context") or "status", "workflow": "",
                "state": "pass" if st == "SUCCESS" else
                         "fail" if st in ("FAILURE", "ERROR") else "run",
                "url": c.get("targetUrl") or "", "started": "", "completed": ""}
    concl = c.get("conclusion") or ""
    if c.get("status") != "COMPLETED":
        state = "run"
    elif concl in _SKIP:
        return None
    else:
        state = "pass" if concl in _PASS else "fail"
    return {"name": c.get("name") or "check", "workflow": c.get("workflowName") or "",
            "state": state, "url": c.get("detailsUrl") or "",
            "started": _ts(c.get("startedAt")), "completed": _ts(c.get("completedAt"))}


def _checks(rollup: list) -> "list[dict]":
    """One row for each check, with the newest attempt winning. A re-run, or one
    workflow fired by both push and pull_request, repeats a name, and `gh pr
    checks` dedupes it the same way. Skipped checks are dropped. Failures
    come first."""
    latest: dict = {}
    for c in sorted(rollup, key=lambda c: _ts(c.get("startedAt"))):
        latest[(c.get("workflowName") or "", c.get("name") or c.get("context") or "")] = c
    rows = [r for r in map(_check, latest.values()) if r]
    return sorted(rows, key=lambda r: (_ORDER[r["state"]], r["name"]))


def chip_state(pr: dict) -> str:
    """Sheet C as one word. Merged and closed end it. Otherwise it is whatever
    needs doing next: a red check comes before a review's comments, and both
    come before waiting on CI."""
    if pr["state"] == "MERGED":
        return "merged"
    if pr["state"] == "CLOSED":
        return "closed"
    if pr["failed"]:
        return "failing"
    if pr["decision"] == "CHANGES_REQUESTED":
        return "changes"
    if pr["running"]:
        return "running"
    if pr["decision"] == "APPROVED" or (not pr["decision"] and not pr["requested"]):
        return "ready"      # approved, or nothing in the repo asks for a review
    return "review"


def _login(r) -> str:
    return ((r or {}).get("author") or {}).get("login") or ""


def normalize(raw: dict) -> dict:
    """gh's JSON → the chip's. `review` is the changes-requested review,
    whose inline comments fetch() adds."""
    checks = _checks(raw.get("statusCheckRollup") or [])
    latest = raw.get("latestReviews") or []
    decision = raw.get("reviewDecision") or ""
    asked = [r for r in latest if r.get("state") == "CHANGES_REQUESTED"]
    last = max(asked, key=lambda r: r.get("submittedAt") or "", default=None)
    pr = {
        "number": raw["number"], "title": raw.get("title") or "",
        "url": raw.get("url") or "", "state": raw.get("state") or "OPEN",
        "base": raw.get("baseRefName") or "", "head": raw.get("headRefName") or "",
        "sha": raw.get("headRefOid") or "",
        "additions": raw.get("additions") or 0, "deletions": raw.get("deletions") or 0,
        "created": _ts(raw.get("createdAt")), "merged_at": _ts(raw.get("mergedAt")),
        "checks": checks,
        "passed": sum(c["state"] == "pass" for c in checks),
        "failed": sum(c["state"] == "fail" for c in checks),
        "running": sum(c["state"] == "run" for c in checks),
        "total": len(checks),
        "decision": decision,
        "requested": [r.get("login") or r.get("name") or r.get("slug") or ""
                      for r in raw.get("reviewRequests") or []],
        "reviews": [{"by": _login(r), "state": r.get("state") or "",
                     "at": r.get("submittedAt") or ""} for r in latest],
        "review": ({"by": _login(last), "at": last.get("submittedAt") or "",
                    "body": (last.get("body") or "").strip(), "comments": []}
                   if decision == "CHANGES_REQUESTED" and last else None),
    }
    pr["status"] = chip_state(pr)
    return pr


def failure_tail(log: str, n: int = LOG_LINES) -> str:
    """The end of a failed step's log, read the way a person would read it:
    prefixes, colour and post-job cleanup off. With "UNKNOWN STEP" (gh can't
    always map a log to its step) --log-failed returns the whole job, and only
    the cut at `##[error]` finds the failure in it."""
    lines = []
    for raw in log.splitlines():
        parts = raw.split("\t", 2)
        text = (parts[2] if len(parts) == 3 else raw).lstrip("\N{BYTE ORDER MARK}")
        lines.append(_ANSI_RE.sub("", _STAMP_RE.sub("", text)).rstrip())
    errors = [i for i, line in enumerate(lines) if line.startswith("##[error]")]
    if errors:
        lines = lines[:errors[-1] + 1]
    return "\n".join(lines[-n:]).strip("\n")


def alerts(pr: dict) -> "set[str]":
    """What is worth a ping right now, keyed so that each one fires once."""
    if pr["state"] != "OPEN":
        return set()
    out = set()
    if pr["failed"]:
        out.add(f"failing:{pr['sha']}")
    if pr["review"]:
        out.add(f"changes:{pr['review']['by']}:{pr['review']['at']}")
    return out


def next_pings(pinged: "set[str]", pr: dict) -> "tuple[set[str], list[str]]":
    """Returns (what is pinged now, what to ping now). While a re-run is going,
    the red commit stays pinged, so it pings once per head commit. Only an
    all-green read clears it, and a red after that green pings again. A review
    stops counting once the decision is no longer CHANGES_REQUESTED."""
    cur = alerts(pr)
    keep = pinged | cur
    if pr["state"] != "OPEN" or (not pr["failed"] and not pr["running"]):
        keep = {k for k in keep if not k.startswith("failing:")}
    if not pr["review"]:
        keep = {k for k in keep if not k.startswith("changes:")}
    return keep, sorted(cur - pinged)


def ping_text(pr: dict, key: str) -> str:
    where = f"{pr['title']} · ⎇ {pr['head']}\n{pr['url']}"
    if key.startswith("failing:"):
        names = ", ".join(c["name"] for c in pr["checks"] if c["state"] == "fail")
        return f"✕ PR #{pr['number']} checks failing — {names}\n{where}"
    by = pr["review"]["by"] if pr["review"] else ""
    return f"◆ PR #{pr['number']} changes requested{f' by {by}' if by else ''}\n{where}"
