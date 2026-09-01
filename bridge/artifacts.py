"""Standalone HTML pages a session left on disk, listed for the dashboard's
ARTIFACTS tab.

An artifact here is a page you open and *read*: a /design-first mockup under
`.mystical/design-drafts/`, a built graphify map, a one-off report. Two kinds of
`.html` are not that, and both are filtered out.

*Source* is a build input nobody reads — a bundler's entry `index.html`, a
`popup.html` under `src/`, a vendored library's README. So `src` and `vendor`
join the pruned dirs, and an `index.html` sitting next to a `package.json` is
skipped.

*Fragments* are the other half: a `_body-01.html` a build script inlines, an SVG
`_sprite.html`, a `<script>` snippet a template includes. Each is real content
but not a whole page — opened alone it renders as unstyled soup. A fragment
starts straight into content, so requiring a document root (`<!doctype`,
`<html`, `<body`) in the first few KB is the whole test.

Why a walk and not an index. Nothing writes these *through* the bridge — the
model calls Write and a file appears — so a registry would be a second source of
truth that goes stale the first time a session writes a page somewhere it
doesn't know about. The tree is the index. With SKIP_DIRS pruned the walk is a
few milliseconds per repo, and the tab reads it on mount, not per frame.

Dotted directories are *not* skipped: the whole design-draft shelf lives under
`.mystical/`, which is the point of the tab.
"""

import html
import os

from bridge import config

# Build output, dependency trees and package source — everything else, including
# dotted dirs, is walked. `dist`/`build` are where a page gets copied to, never
# authored; `vendor` is composer's `node_modules`; `.claude` holds a skill's own
# swatch pages, which are tooling rather than anything you sat down to read.
SKIP_DIRS = {".git", "node_modules", "dist", "build", ".next", "coverage",
             "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
             ".bridge_uploads", "src", "vendor", ".claude"}

_MAX_PER_REPO = 300
_MAX_ALL = 800
_HEAD_BYTES = 4096
_ROOTS = ("<!doctype", "<html", "<body")


def _head(path: str) -> str:
    """The first few KB — enough for both questions asked of a page, is this a
    document and what is it called. A self-contained mockup can be megabytes;
    its <head> never is."""
    try:
        with open(path, "rb") as f:
            return f.read(_HEAD_BYTES).decode("utf-8", "replace")
    except OSError:
        return ""


def _title(head: str) -> str:
    """The page's <title>, if it declared one."""
    lo = head.lower()
    i = lo.find("<title")
    if i < 0:
        return ""
    j = head.find(">", i)
    k = lo.find("</title>", j)
    if not 0 < j < k:
        return ""
    # Entities, because a <title> is markup: "Widgets &mdash; Mini App" has to
    # read as an em dash in the list, not as its source.
    return html.unescape(" ".join(head[j + 1:k].split()))[:80]


def artifacts(cwd: str) -> list[dict]:
    """Every standalone HTML page in a repo, newest first. `path` is repo-rel
    with forward slashes (it round-trips through a URL); `dir` is what the tab
    groups by — the folder is the subject."""
    out: list[dict] = []
    for root, dirs, names in os.walk(cwd):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        entry = "package.json" in names
        for n in names:
            if not n.endswith(".html") or (n == "index.html" and entry):
                continue
            p = os.path.join(root, n)
            head = _head(p)
            if not any(r in head.lower() for r in _ROOTS):
                continue    # a fragment, not a page
            try:
                st = os.stat(p)
            except OSError:
                continue
            d = os.path.relpath(root, cwd)
            out.append({
                "path": os.path.relpath(p, cwd).replace(os.sep, "/"),
                "dir": "" if d == "." else d.replace(os.sep, "/"),
                "name": n,
                "title": _title(head),
                "at": st.st_mtime,
                "size": st.st_size,
            })
    out.sort(key=lambda a: a["at"], reverse=True)
    return out[:_MAX_PER_REPO]


def all_artifacts() -> list[dict]:
    """Every repo's pages in one list, each tagged with the project that holds
    it — the tab's default scope, because a mockup belongs to the repo it was
    drawn for, not to whichever session happens to be focused."""
    from bridge import browser   # local import: browser imports config too

    out = []
    for p in browser.list_projects():
        for a in artifacts(os.path.join(config.BASE_PATH, p.lstrip("/"))):
            out.append({**a, "project": p})
    out.sort(key=lambda a: a["at"], reverse=True)
    return out[:_MAX_ALL]


def read(cwd: str, path: str) -> "bytes | None":
    """One page's bytes. `path` arrives from the browser, so it is matched
    against what the walk actually found rather than joined onto a path — the
    containment check is the listing itself, so `../` never resolves.

    ponytail: re-walks the repo per open (milliseconds at this size). Cache the
    listing if a repo ever makes that show.
    """
    if path not in {a["path"] for a in artifacts(cwd)}:
        return None
    try:
        with open(os.path.join(cwd, path), "rb") as f:
            return f.read()
    except OSError:
        return None
