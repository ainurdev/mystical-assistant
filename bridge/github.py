"""List and create GitHub issues for a repo via the user's authed `gh` CLI.
Stdlib + subprocess; the slug is derived from the repo's `origin` remote."""

import json
import pathlib
import re
import subprocess

_SLUG_RE = re.compile(
    r"^(?:https?://github\.com/|git@github\.com:)([^/]+)/(.+?)(?:\.git)?/?$",
    re.IGNORECASE,
)


def _parse_slug(url: str) -> str | None:
    m = _SLUG_RE.match((url or "").strip())
    if not m:
        return None
    owner, repo = m.group(1), m.group(2)
    if not owner or not repo:
        return None
    return f"{owner}/{repo}"


def _run(*args: str, cwd: str | None = None, timeout: int = 15) -> tuple[int, str, str]:
    try:
        p = subprocess.run(list(args), capture_output=True, text=True,
                           timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as e:
        return 127, "", str(e)


def remote_slug(cwd: str) -> str | None:
    rc, out, _ = _run("git", "-C", cwd, "remote", "get-url", "origin")
    return _parse_slug(out) if rc == 0 else None


def remote_slugs(cwd: str) -> set[str]:
    """Every remote's slug, not just origin's: a fork cloned from a mirror
    (origin ainurdev/apex) tracks the upstream under another name (nr ->
    nationalerijschool/apex). Fetch urls only — a push url can be some other
    repo entirely."""
    rc, out, _ = _run("git", "-C", cwd, "remote", "-v")
    if rc != 0:
        return set()
    slugs = (_parse_slug(line.split()[1]) for line in out.splitlines()
             if line.endswith("(fetch)"))
    return {s for s in slugs if s}


# The url line inside the [remote "origin"] section: `[^[` can't leave the
# section, `^\s*url` can't be fooled by a pushurl.
_ORIGIN_URL_RE = re.compile(r'\[remote "origin"\][^\[]*?^\s*url\s*=\s*(\S+)',
                            re.MULTILINE)


def origin_slug(repo_dir: str) -> str | None:
    """Same answer as remote_slug, read straight out of .git/config. The
    dashboard wants it for every repo it lists, every ten seconds; that is a
    file read each, not a git process each."""
    try:
        cfg = (pathlib.Path(repo_dir) / ".git" / "config").read_text(
            encoding="utf-8", errors="replace")
    except OSError:
        return None
    m = _ORIGIN_URL_RE.search(cfg)
    return _parse_slug(m.group(1)) if m else None


_ISSUE_RE = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/issues/(\d+)")
_HEADING_RE = re.compile(r"^#{1,6}\s")
_OPENING_MAX = 700


def _opening(body: str) -> str:
    """An issue body's opening, for a peek: its title heading dropped (the task
    already shows the name), the rest up to the first section heading, cut at a
    paragraph to stay under _OPENING_MAX."""
    lines = body.strip().splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    head = []
    for ln in lines:
        if _HEADING_RE.match(ln):
            break
        head.append(ln)
    out = "\n".join(head).strip()
    if len(out) <= _OPENING_MAX:
        return out
    cut = out.rfind("\n\n", 0, _OPENING_MAX)
    return out[:cut if cut > 0 else _OPENING_MAX].rstrip() + "…"


def issue_spec(text: "str | None") -> "dict | None":
    """The first GitHub issue `text` links to, read with `gh`: its number, title,
    state, url and opening. A Rivendell task whose description says "the spec
    stays in #43" shows #43's words in the RIVENDELL tab's peek. gh failing (no
    access, no network) keeps the link and nothing else."""
    m = _ISSUE_RE.search(text or "")
    if not m:
        return None
    slug, num = m.group(1), m.group(2)
    url = f"https://github.com/{slug}/issues/{num}"
    rc, out, _ = _run("gh", "issue", "view", num, "-R", slug,
                      "--json", "number,title,state,url,body")
    try:
        d = json.loads(out) if rc == 0 else None
    except ValueError:
        d = None
    if not isinstance(d, dict):
        return {"number": int(num), "url": url, "title": None, "state": None, "body": None}
    return {"number": d.get("number") or int(num), "url": d.get("url") or url,
            "title": d.get("title"), "state": d.get("state"),
            "body": _opening(d.get("body") or "")}


def _count(slug: str, state: str) -> int:
    rc, out, _ = _run(
        "gh", "api",
        f"search/issues?q=repo:{slug}+type:issue+state:{state}&per_page=1",
        "--jq", ".total_count")
    try:
        return int(out.strip())
    except ValueError:
        return 0


def issues(cwd: str) -> dict:
    slug = remote_slug(cwd)
    if slug is None:
        return {"has_remote": False, "slug": None, "gh_ok": False, "error": "",
                "open_count": 0, "closed_count": 0, "issues": []}
    rc, out, err = _run("gh", "issue", "list", "-R", slug, "--state", "open",
                        "--limit", "30", "--json",
                        "number,title,url,updatedAt,labels,body")
    if rc != 0:
        return {"has_remote": True, "slug": slug, "gh_ok": False,
                "error": err.strip() or "gh failed", "open_count": 0,
                "closed_count": 0, "issues": []}
    try:
        raw = json.loads(out or "[]")
    except ValueError:
        raw = []
    items = [{
        "number": i.get("number"),
        "title": i.get("title", ""),
        "url": i.get("url", ""),
        "updated": i.get("updatedAt", ""),
        "body": i.get("body", ""),
        "labels": [{"name": l.get("name", ""), "color": l.get("color", "")}
                   for l in (i.get("labels") or [])],
    } for i in raw]
    open_count = len(items) if len(items) < 30 else _count(slug, "open")
    return {"has_remote": True, "slug": slug, "gh_ok": True, "error": "",
            "open_count": open_count, "closed_count": _count(slug, "closed"),
            "issues": items}


def create_issue(cwd: str, title: str, body: str) -> tuple[bool, str]:
    slug = remote_slug(cwd)
    if slug is None:
        return False, "no GitHub remote"
    rc, out, err = _run("gh", "issue", "create", "-R", slug,
                        "--title", title, "--body", body or "", timeout=30)
    return rc == 0, (out + err).strip()


# Owner and repo as GitHub spells them: pr_ref runs this over free model text,
# and a "URL" with a space or <> in it fails Rivendell's IsUrl on a result.
_PR_URL_RE = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/(\d+)")


def pr_ref(text: str) -> "dict | None":
    """The first pull request URL in `text`, as {number, url}: how a run's
    closing summary names the PR it opened (Rivendell's prompts ask for the
    link). None when it names none."""
    m = _PR_URL_RE.search(text or "")
    return {"number": int(m.group(1)), "url": m.group(0)} if m else None


_CHECKS_FAIL = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
_CHECKS_OK = {"SUCCESS", "NEUTRAL", "SKIPPED"}


def checks_state(rollup) -> "str | None":
    """GitHub's statusCheckRollup as one word: fail if any check failed, pending
    while any is still running, pass when every one passed; None when there are
    none. A CheckRun answers in `conclusion` (empty while it runs), a commit
    status in `state`."""
    states = [str(c.get("conclusion") or c.get("state") or "").upper()
              for c in rollup or () if isinstance(c, dict)]
    if not states:
        return None
    if any(s in _CHECKS_FAIL for s in states):
        return "fail"
    return "pass" if all(s in _CHECKS_OK for s in states) else "pending"


def pr_checks(url: str) -> "str | None":
    """checks_state for the PR at `url`, via the user's authed `gh`. None when gh
    can't say (not installed, no access, not a PR)."""
    rc, out, _ = _run("gh", "pr", "view", url, "--json", "statusCheckRollup")
    if rc != 0:
        return None
    try:
        return checks_state(json.loads(out or "{}").get("statusCheckRollup"))
    except ValueError:
        return None


def create_pr(cwd: str, head: str, base: str, title: str,
              body: str = "") -> tuple[bool, dict]:
    """Push `head` and open a PR into `base`. Returns (ok, {url, number, output})."""
    slug = remote_slug(cwd)
    if slug is None:
        return False, {"output": "no GitHub remote", "url": "", "number": None}
    # The PR head must exist on the remote — push it (sets upstream if new).
    prc, pout, perr = _run("git", "-C", cwd, "push", "-u", "origin", head, timeout=40)
    if prc != 0:
        return False, {"output": (pout + perr).strip() or "push failed",
                       "url": "", "number": None}
    rc, out, err = _run("gh", "pr", "create", "-R", slug, "--base", base,
                        "--head", head, "--title", title, "--body", body or "",
                        timeout=40)
    output = (out + err).strip()
    m = _PR_URL_RE.search(output)
    return rc == 0, {"output": output, "url": m.group(0) if m else "",
                     "number": int(m.group(1)) if m else None}


def pr_url(cwd: str, branch: str) -> str:
    """The open PR for `branch`, or "". What a tracker update links to."""
    slug = remote_slug(cwd)
    if slug is None or not branch:
        return ""
    rc, out, _ = _run("gh", "pr", "list", "-R", slug, "--head", branch, "--state", "open",
                      "--limit", "1", "--json", "url", "--jq", ".[0].url // \"\"")
    return out.strip() if rc == 0 else ""
