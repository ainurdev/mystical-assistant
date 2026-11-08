"""A project's docs: for you to read, and for agents to work from.

Nothing is written unless you ask. Without generated docs, the Docs tab lists the Markdown it can
find (README, docs/) and says plainly that nobody has checked it. Generating goes in two steps, as
a table of contents is cheap to fix and a wrong one is expensive to write out: an agent reads the
project and calls docs_outline, you see the contents in the sidebar, and then it writes pages with
doc_page, all of them or the ones you pick.

They live where you chose: hidden in .mystical/wiki, which never reaches git, or in a folder of the
project like docs/, for you to commit. .docs.json beside the pages is the contents, and pages are plain
Markdown, so they read fine in a repo. A page can hold a live view: a fenced ```view block with the
same arguments as show_data. It's checked as it's written (data_views), so a page can't carry a chart
that won't draw, and totals are computed the same way.

Each page remembers which files it's about and the commit it was written at, so the tab can say what's
gone stale. It's a hint from git, not a judgement: a changed file doesn't always mean a wrong page.

read_docs gives agents the same pages. What's on a page was written by a model and may be wrong, so
agents are told to trust the code over it. Stdlib only.
"""

import json
import os
import re
import subprocess
import time

from bridge import data_views

HIDDEN = os.path.join(".mystical", "wiki")
MANIFEST = ".docs.json"
MAX_PAGES = 80
MAX_PAGE_BYTES = 400 * 1024
_VIEW = re.compile(r"```view[ \t]*\n(.*?)\n```", re.S)
_FOUND_NAMES = re.compile(r"^(readme|contributing|architecture|changelog|design|security|development|install|usage|faq|glossary)[\w.-]*\.(md|mdx|markdown)$", re.I)
_SKIP = re.compile(r"(^|/)(node_modules|vendor|dist|build|\.next|\.venv|venv|__pycache__|\.mystical|\.claude|third_party)(/|$)")


class Refused(ValueError):
    """A sentence for whoever asked: what to change."""


def _slug(text, fallback="page") -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")[:60] or fallback


def _git(root: str, *args) -> str:
    try:
        p = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, timeout=8)
        return p.stdout if p.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _files(root: str) -> list:
    return _git(root, "ls-files", "--cached", "--others", "--exclude-standard").splitlines()


def _folder(root: str, location) -> str:
    """Where the pages go: hidden, or a folder of the project."""
    where = str(location or "hidden").strip()
    if where == "hidden":
        return HIDDEN
    real = os.path.realpath(os.path.join(root, where))
    if real == os.path.realpath(root) or not real.startswith(os.path.realpath(root) + os.sep):
        raise Refused("Docs go in a folder inside the project, or hidden.")
    return os.path.relpath(real, root)


def _find(root: str) -> "tuple[str, dict] | None":
    """(folder, manifest) of the project's generated docs, wherever they were put."""
    candidates = [HIDDEN] + [os.path.dirname(f) for f in _files(root) if os.path.basename(f) == MANIFEST]
    for d in candidates:
        try:
            with open(os.path.join(root, d, MANIFEST), encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("pages"), list):
            return d, data
    return None


def _write(root: str, folder: str, data: dict) -> None:
    d = os.path.join(root, folder)
    if folder == HIDDEN:
        from bridge import devserver
        devserver.mystical_dir(root)
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, f"{MANIFEST}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(d, MANIFEST))


def outline(root: str, a: dict) -> dict:
    """docs_outline: the contents, before any page. Keeps pages already written whose id stays."""
    raw = a.get("pages")
    if not isinstance(raw, list) or not raw:
        raise Refused("Give pages: [{id, title, group, summary, sources}].")
    if len(raw) > MAX_PAGES:
        raise Refused(f"At most {MAX_PAGES} pages: fewer, better ones get read.")
    found = _find(root)
    folder = _folder(root, a["location"]) if a.get("location") else (found[0] if found else HIDDEN)
    old = {p["id"]: p for p in found[1]["pages"]} if found else {}
    pages, seen = [], set()
    for p in raw:
        if not isinstance(p, dict) or not str(p.get("title") or "").strip():
            raise Refused("Each page needs a title.")
        pid = _slug(p.get("id") or p["title"])
        if pid in seen:
            raise Refused(f"Two pages have the id {pid}.")
        seen.add(pid)
        prev = old.get(pid, {})
        sources = [str(x)[:300] for x in (p.get("sources") or []) if str(x).strip()][:40] if isinstance(p.get("sources"), list) else prev.get("sources", [])
        pages.append({"id": pid, "title": " ".join(str(p["title"]).split())[:120], "group": " ".join(str(p.get("group") or "").split())[:60],
                      "summary": " ".join(str(p.get("summary") or "").split())[:300], "sources": sources,
                      **{k: prev[k] for k in ("written", "commit") if k in prev}})
    title = " ".join(str(a.get("title") or (found[1].get("title") if found else "") or os.path.basename(root)).split())[:120]
    _write(root, folder, {"title": title, "pages": pages, "updated": time.time()})
    return {"folder": folder, "pages": len(pages)}


def _check_views(markdown: str) -> str:
    """Each view as it'll be drawn, or Refused naming the one that won't."""
    def check(m: "re.Match") -> str:
        try:
            spec = json.loads(m.group(1))
        except ValueError as e:
            raise Refused(f"A view block isn't valid JSON: {e}") from None
        try:
            ev, _ = data_views.build(spec)
        except data_views.Refused as e:
            raise Refused(f"The view {str(spec.get('title') or '')!r} can't be drawn: {e}") from None
        return "```view\n" + json.dumps(ev, ensure_ascii=False) + "\n```"
    return _VIEW.sub(check, markdown)


def write_page(root: str, a: dict) -> dict:
    """doc_page: one page's Markdown, on the contents already."""
    found = _find(root)
    if not found:
        raise Refused("There's no outline yet. Call docs_outline first, so the user can see the contents.")
    folder, data = found
    pid = _slug(a.get("id"))
    page = next((p for p in data["pages"] if p["id"] == pid), None)
    if not page:
        raise Refused(f"No page {pid} in the contents. Its ids are: {', '.join(p['id'] for p in data['pages'][:40])}.")
    text = str(a.get("markdown") or "").strip()
    if not text:
        raise Refused("The page is empty.")
    if len(text.encode()) > MAX_PAGE_BYTES:
        raise Refused("That's too long for one page. Split it in the outline.")
    text = _check_views(text)
    with open(os.path.join(root, folder, f"{pid}.md"), "w", encoding="utf-8") as f:
        f.write(text + "\n")
    if isinstance(a.get("sources"), list):
        page["sources"] = [str(x)[:300] for x in a["sources"] if str(x).strip()][:40]
    page["written"] = time.time()
    page["commit"] = _git(root, "rev-parse", "--short", "HEAD").strip()
    _write(root, folder, data)
    return {"page": pid, "path": os.path.join(folder, f"{pid}.md"), "views": len(_VIEW.findall(text))}


def _changed_since(root: str, page: dict) -> list:
    """Which of a page's files have changed since it was written, committed or not."""
    if not page.get("commit") or not page.get("sources"):
        return []
    out = _git(root, "diff", "--name-only", page["commit"], "--", *page["sources"])
    return [ln for ln in out.splitlines() if ln][:10]


def _found_docs(root: str, skip: "str | None") -> list:
    """Markdown already in the project. Named files anywhere near the top, and all of a docs folder."""
    out = []
    for f in _files(root):
        low = f.lower()
        if _SKIP.search(f) or (skip and f.startswith(skip + "/")) or not low.endswith((".md", ".mdx", ".markdown")):
            continue
        if low.startswith(("docs/", "doc/", "documentation/")) or (f.count("/") <= 2 and _FOUND_NAMES.match(os.path.basename(f))):
            out.append({"path": f, "name": os.path.basename(f), "folder": os.path.dirname(f)})
    return sorted(out, key=lambda x: (x["folder"].count("/"), x["folder"], x["name"].lower()))[:300]


def listed(root: str) -> dict:
    """POST chat/docs: the contents if there are generated docs, and what else is lying around."""
    found = _find(root)
    out: dict = {"found": _found_docs(root, found[0] if found else None), "generated": None}
    if found:
        folder, data = found
        pages = []
        for p in data["pages"]:
            exists = os.path.isfile(os.path.join(root, folder, f"{p['id']}.md"))
            pages.append({**p, "written": exists, "written_at": p.get("written"), "changed": _changed_since(root, p) if exists else []})
        out["generated"] = {"title": data.get("title") or "", "folder": folder, "hidden": folder == HIDDEN, "pages": pages}
    return out


def read(root: str, body: dict) -> "tuple[dict, int]":
    """POST chat/doc-read: a page's text, by id for generated ones or by path for found ones."""
    if body.get("id"):
        found = _find(root)
        pid = _slug(body["id"])
        if not found or not any(p["id"] == pid for p in found[1]["pages"]):
            return {"error": "No such page."}, 404
        path = os.path.join(root, found[0], f"{pid}.md")
    else:
        path = os.path.realpath(os.path.join(root, str(body.get("path") or "")))
        real_root = os.path.realpath(root)
        if not path.startswith(real_root + os.sep) or not path.lower().endswith((".md", ".mdx", ".markdown")):
            return {"error": "That isn't a document in this project."}, 400
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return {"text": f.read(MAX_PAGE_BYTES)}, 200
    except OSError:
        return {"error": "That page hasn't been written yet."}, 404


def for_agents(root: str, a: dict) -> str:
    """read_docs: the contents, or a page, or the pages that mention something."""
    got = listed(root)
    gen = got["generated"]
    caution = "Written by a model at some point: where it disagrees with the code, trust the code and say so."
    if a.get("id") or a.get("path"):
        out, code = read(root, a)
        if code != 200:
            raise Refused(out["error"])
        return f"{caution}\n\n{out['text']}"
    if a.get("query"):
        q = str(a["query"]).lower()
        hits = []
        for p in (gen["pages"] if gen else []):
            if p["written"]:
                text = read(root, {"id": p["id"]})[0].get("text", "")
                if q in text.lower() or q in p["title"].lower():
                    hits.append(f"{p['id']}: {p['title']}")
        return "\n".join(hits) or "No generated page mentions that."
    lines = []
    if gen:
        lines.append(f"Generated docs in {gen['folder']}. {caution}")
        for p in gen["pages"]:
            state = "not written" if not p["written"] else f"its files changed: {', '.join(p['changed'][:3])}" if p["changed"] else "written"
            lines.append(f"- {p['id']}: {p['title']} ({state}). {p['summary']}")
    else:
        lines.append("No generated docs here.")
    if got["found"]:
        lines.append("Other Markdown in the project, unchecked: " + ", ".join(f["path"] for f in got["found"][:40]))
    return "\n".join(lines)
