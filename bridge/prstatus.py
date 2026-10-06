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
DONE_TTL = 600     # s: a merged or closed PR barely changes (a reopen waits this long)
LOG_LINES = 60
FIELDS = ("number,title,state,url,baseRefName,headRefName,headRefOid,additions,"
          "deletions,createdAt,mergedAt,statusCheckRollup,reviewDecision,"
          "reviewRequests,latestReviews,reviews")

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
    row = {"name": c.get("name") or "check", "workflow": c.get("workflowName") or "",
           "state": state, "url": c.get("detailsUrl") or "",
           "started": _ts(c.get("startedAt")), "completed": _ts(c.get("completedAt"))}
    if concl == "CANCELLED":
        row["cancelled"] = True   # red on the chip, but someone stopped it: no ping
    return row


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


_WRITE = {"OWNER", "MEMBER", "COLLABORATOR"}


def _standing(raw: dict) -> "list[dict]":
    """Each reviewer's standing review: their newest one that isn't a comment.
    latestReviews alone loses a request for changes once its author comments
    again (mattermost/matterwick#104). Only reviewers with write access count,
    as for reviewDecision; a bot or an outsider asking for changes doesn't.
    latestReviews is merged in for a PR whose `reviews` list gh cut short."""
    newest: dict = {}
    for r in (raw.get("reviews") or []) + (raw.get("latestReviews") or []):
        if r.get("state") in ("COMMENTED", "PENDING") or r.get("authorAssociation") not in _WRITE:
            continue
        who = _login(r)
        if who not in newest or (r.get("submittedAt") or "") > (newest[who].get("submittedAt") or ""):
            newest[who] = r
    return list(newest.values())


def normalize(raw: dict) -> dict:
    """gh's JSON → the chip's. `review` is the changes-requested review,
    whose inline comments fetch() adds."""
    checks = _checks(raw.get("statusCheckRollup") or [])
    latest = _standing(raw)
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
    if any(c["state"] == "fail" and not c.get("cancelled") for c in pr["checks"]):
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


def _gh(*args: str, timeout: int = 20) -> "tuple[int, str, str]":
    return github._run("gh", *args, timeout=timeout)


def _failure_log(slug: str, url: str) -> str:
    m = _JOB_RE.search(url or "")
    if not m:
        return ""          # not GitHub Actions: only the link, no log we can fetch
    job = m.group(1)
    tail = _logs.get(job)
    if tail is None:
        rc, out, _ = _gh("run", "view", "--job", job, "-R", slug, "--log-failed",
                         timeout=40)
        if rc != 0:
            return ""      # the run is still going, or gh couldn't say: ask next read
        tail = failure_tail(out)   # an empty answer is still the answer: kept
        if len(_logs) > 200:
            _logs.clear()  # ponytail: a crude bound, far above one session's failures
        _logs[job] = tail
    return tail


def _review_comments(slug: str, number: int, review: dict) -> "list[dict]":
    """The changes-requested review's inline comments. gh pr view has no
    comment text, and the per-review REST list has no line numbers (checked
    2026-10-06). So the code finds the review's id first, then filters the
    PR's comment list by that id.
    ponytail: only the first page (100) of each, and three gh calls per read
    while changes are requested. Cache by review id if that ever shows up in
    the rate limit."""
    try:
        rc, out, _ = _gh("api", f"repos/{slug}/pulls/{number}/reviews?per_page=100")
        if rc != 0:
            return []
        rid = next((r["id"] for r in json.loads(out)
                    if r.get("submitted_at") == review["at"]
                    and (r.get("user") or {}).get("login") == review["by"]), None)
        if rid is None:
            return []
        rc, out, _ = _gh("api", f"repos/{slug}/pulls/{number}/comments?per_page=100")
        if rc != 0:
            return []
        return [{"path": c.get("path") or "",
                 "line": c.get("line") or c.get("original_line"),
                 "body": (c.get("body") or "").strip()}
                for c in json.loads(out) if c.get("pull_request_review_id") == rid]
    except (ValueError, TypeError, KeyError):
        return []


def fetch(slug: str, branch: str) -> "tuple[dict | None, int]":
    """Returns (pr, how long to trust the answer). A None pr means no chip."""
    # `--` first: a local branch can be named "--web", and gh reads it as a
    # branch after `--` (checked with gh 2.92).
    rc, out, err = _gh("pr", "view", "-R", slug, "--json", FIELDS, "--", branch)
    if rc != 0:
        # "no pull requests found" is an answer. Anything else (signed out,
        # rate-limited, offline, gh missing) means gh doesn't know, so back off.
        return None, (TTL if "no pull requests found" in err else ERR_TTL)
    try:
        pr = normalize(json.loads(out))
    except (ValueError, KeyError, TypeError):
        return None, ERR_TTL
    if pr["state"] != "OPEN":
        return pr, DONE_TTL   # its popover shows no checks or review: no logs, no comments
    for c in pr["checks"]:
        if c["state"] == "fail":
            c["log"] = _failure_log(slug, c["url"])
    if pr["review"]:
        pr["review"]["comments"] = _review_comments(slug, pr["number"], pr["review"])
    return pr, TTL


def _spawn(fn, *args) -> None:
    threading.Thread(target=fn, args=args, daemon=True).start()


def _telegram(project: str, session: str, pr: dict, keys: "list[str]") -> None:
    """Best effort, like runner._notify: a failed ping is only a missed ping."""
    if not (config.NOTIFY_ENABLE and config.TOKEN and config.DASH_CHAT_ID):
        return
    try:
        kb = telegram.panel_kb(config.DASH_CHAT_ID, session or None, project)
        for k in keys:
            telegram.send(config.DASH_CHAT_ID, ping_text(pr, k), kb)
    except Exception as e:  # noqa: BLE001: a ping must never break a read
        print(f"prstatus: Telegram ping failed: {e}")


def _pings(repo_dir: str, slug: str, branch: str, pr: dict, session: str) -> "list[str]":
    key = f"pr_pinged:{slug}:{branch}"
    try:
        old = set(json.loads(store.get_setting(key) or "[]"))
    except ValueError:
        old = set()
    new, fresh = next_pings(old, pr)
    if new != old:
        store.set_setting(key, json.dumps(sorted(new)) if new else None)
    if fresh:
        _spawn(_telegram, browser.rel(repo_dir), session, pr, fresh)
    return sorted(new)


def _slug_for(repo_dir: str, branch: str) -> "str | None":
    """The repo's GitHub slug when `branch` can have a PR to show, else None.
    PRs land on the default branch; they don't come from it. gh pr view reads
    "59" (or "#59", "+59") as PR number 59, not as a branch.
    ponytail: an all-digit branch gets no chip. `gh pr list --head` if one matters.
    Only the repo's own branches reach gh at all: `branch` comes from the
    query string, and gh would read another repo's PR url as the PR (the same
    rule as /local/git/diff)."""
    slug = github.remote_slug(repo_dir) if branch else None
    if (not slug or re.fullmatch(r"#?\+?\d+", branch) or branch == git.default_branch(repo_dir)
            or branch not in git.branches(repo_dir)):
        return None
    return slug


def _read(repo_dir: str, slug: str, branch: str, session: str, old: "dict | None") -> dict:
    now = time.time()
    pr, ttl = fetch(slug, branch)
    if pr is None and ttl == ERR_TTL and old:
        pr = old["pr"]      # a blip keeps the last good chip instead of blinking it out
    pinged = _pings(repo_dir, slug, branch, pr, session) if pr else []
    return {"at": now, "ttl": ttl, "pr": pr, "pinged": pinged}


def snapshot(repo_dir: str, branch: str, *, force: bool = False,
             session: str = "") -> dict:
    """The PR for `branch` of the repo at `repo_dir`, in the shape the chip
    wants: {"pr": dict | None, "pinged": [alert keys], "checked": epoch s}.
    `session` is only used for the Telegram button."""
    slug = _slug_for(repo_dir, branch)
    if slug is None:
        # Not cached: a made-up branch name must not leave a lock and an entry.
        return {"pr": None, "pinged": [], "checked": time.time()}
    key = (repo_dir, branch)
    with _locks.setdefault(key, threading.Lock()):
        hit = _cache.get(key)
        trust = hit["ttl"] if hit else 0
        if force and trust <= TTL:
            trust = min(trust, FORCE_FLOOR)   # a rate-limit backoff outlasts force
        if hit is None or time.time() - hit["at"] >= trust:
            hit = _cache[key] = _read(repo_dir, slug, branch, session, hit)
    return {"pr": hit["pr"], "pinged": hit["pinged"], "checked": hit["at"]}
