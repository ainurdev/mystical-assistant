"""List and create GitHub issues for a repo via the user's authed `gh` CLI.
Stdlib + subprocess; the slug is derived from the repo's `origin` remote."""

import json
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
                        "number,title,url,updatedAt,labels")
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
