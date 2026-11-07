"""Design boards: pages an agent designs, and what you say about them, in the project.

An agent calls show_design with one or more pages, the chat gets a PREVIEW DESIGN button, and the
button opens the design-chat view: the chat beside the page, in a sandboxed frame you can point at.
Rough directions are simply pages on one board, so comparing and remixing them needs nothing else.

A board is a folder, .mystical/design/<id>/, which never reaches git and goes when the project
goes: board.json, the pages it wrote, comments.json, and versions/ for before-and-after. A page can
also be any HTML file in the project. The agent keeps editing the file and the view polls, so
you watch edits land with no further tool call and no HTML going back through the model. Every
new content a poll sees is kept as a version, up to KEEP per page.

The HTML is agent-written and runs, so the client frames it with sandbox="allow-scripts" and no
same-origin, under a strict CSP (lib/designframe). What the frame can't fetch, this inlines:
a local image in a page becomes a data URL at read time, within the project, images only.

Stdlib only.
"""

import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import threading
import time

from bridge import chat_images, config, devserver

DIR = os.path.join(".mystical", "design")
MAX_PAGES = 12
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_INLINE_IMAGES = 6 * 1024 * 1024
MAX_COMMENTS = 300
KEEP = 30
_lock = threading.Lock()
_THEME_META = re.compile(r"<meta[^>]*name\s*=\s*[\"']mystical-theme[\"'][^>]*>", re.I)
_IMG = re.compile(r"""(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2""", re.I | re.S)


class Refused(ValueError):
    """A sentence for whoever asked: what to change."""


def _slug(text: str, fallback: str = "design") -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")[:50] or fallback


def _board_dir(root: str, board: str) -> str:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", str(board or "")):
        raise Refused("No such board.")
    return os.path.join(root, DIR, board)


def _write_json(path: str, data) -> None:
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def _read_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load(root: str, board: str) -> dict:
    meta = _read_json(os.path.join(_board_dir(root, board), "board.json"), None)
    if not isinstance(meta, dict):
        raise Refused("No such board.")
    return meta


def _allowed_file(path: str, root: str, cwd: "str | None") -> "str | None":
    """The real path of an HTML file an agent named, inside this project or its worktree."""
    base = cwd or root
    real = os.path.realpath(path if os.path.isabs(path) else os.path.join(base, path))
    roots = [os.path.realpath(p) for p in (root, cwd, config.BASE_PATH) if p]
    inside = any(real == r or real.startswith(r.rstrip(os.sep) + os.sep) for r in roots)
    return real if inside and os.path.isfile(real) and real.lower().endswith((".html", ".htm")) else None


def put(root: str, cwd: "str | None", spec: dict) -> dict:
    """Create or update a board from show_design's arguments. Returns its metadata."""
    title = " ".join(str(spec.get("title") or "").split())[:120]
    raw = spec.get("pages")
    board = spec.get("board") or _slug(title)
    if not isinstance(raw, list) or not raw:
        if not spec.get("board"):
            raise Refused("Give pages: [{name, file or html}], one per page or direction.")
        raw = []
    if len(raw) > MAX_PAGES:
        raise Refused(f"A board holds {MAX_PAGES} pages. Make another board for the rest.")
    devserver.mystical_dir(root)
    d = _board_dir(root, _slug(board))
    with _lock:
        os.makedirs(d, exist_ok=True)
        meta = _read_json(os.path.join(d, "board.json"), None)
        if not isinstance(meta, dict):
            if not title:
                raise Refused("Give the board a title: what's being designed.")
            meta = {"id": os.path.basename(d), "title": title, "pages": [], "created": time.time()}
        if title:
            meta["title"] = title
        pages = {p["name"]: p for p in meta["pages"]}
        for p in raw:
            if not isinstance(p, dict):
                raise Refused("Each page is an object: {name, file or html}.")
            name = " ".join(str(p.get("name") or "").split())[:80]
            if not name:
                raise Refused("Each page needs a name, as it'll read in the dropdown.")
            entry = pages.get(name) or {"name": name}
            if isinstance(p.get("html"), str) and p["html"].strip():
                if len(p["html"].encode()) > MAX_PAGE_BYTES:
                    raise Refused(f"{name} is over {MAX_PAGE_BYTES // 1024 // 1024} MB. Inline less.")
                path = os.path.join(d, f"{_slug(name, 'page')}.html")
                with open(path, "w", encoding="utf-8") as f:
                    f.write(p["html"])
                entry["file"] = path
            elif p.get("file"):
                real = _allowed_file(str(p["file"]), root, cwd)
                if not real:
                    raise Refused(f"{name}: {p['file']} isn't an HTML file in this project.")
                entry["file"] = real
            elif "file" not in entry:
                raise Refused(f"{name} needs html, or file: a path to an HTML file in the project.")
            if p.get("direction"):
                entry["direction"] = " ".join(str(p["direction"]).split())[:120]
            if name not in pages:
                meta["pages"].append(entry)
            pages[name] = entry
        if len(meta["pages"]) > MAX_PAGES:
            raise Refused(f"A board holds {MAX_PAGES} pages. Make another board for the rest.")
        meta["updated"] = time.time()
        _write_json(os.path.join(d, "board.json"), meta)
    for entry in meta["pages"]:
        _read_page(root, d, entry)
    return meta


def _inline_images(html: str, base: str, root: str) -> str:
    """The frame has no network and no origin, so a local image has to travel in the page."""
    spent = [0]

    def swap(m: "re.Match") -> str:
        src = m.group(3).strip()
        if re.match(r"^(data:|https?:|//)", src, re.I):
            return m.group(0)
        real = chat_images.resolve(os.path.join(base, src) if not os.path.isabs(src) else src, root)
        if not real:
            return m.group(0)
        try:
            size = os.path.getsize(real)
            if spent[0] + size > MAX_INLINE_IMAGES:
                return m.group(0)
            with open(real, "rb") as f:
                data = base64.b64encode(f.read()).decode()
        except OSError:
            return m.group(0)
        spent[0] += size
        return f"{m.group(1)}{m.group(2)}data:{mimetypes.guess_type(real)[0]};base64,{data}{m.group(2)}"
    return _IMG.sub(swap, html)


def _theme_path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "design_theme.json")


def save_theme(body: dict) -> "tuple[dict, int]":
    """POST design-theme: the dashboard says what it's wearing, as only it knows. These land in a
    <style> in every page that asks for them, so a value can't close the block or start a tag."""
    tokens = body.get("tokens")
    if not isinstance(tokens, dict):
        return {"error": "tokens must be an object."}, 400
    clean = {k: " ".join(str(v).split())[:200] for k, v in list(tokens.items())[:80]
             if isinstance(k, str) and re.fullmatch(r"--[\w-]{1,40}", k) and v and not re.search(r"[;{}<>]", str(v))}
    data = {"name": str(body.get("theme") or "")[:60], "light": body.get("light") is True, "tokens": clean}
    with _lock:
        _write_json(_theme_path(), data)
    return {"ok": True}, 200


def theme() -> dict:
    got = _read_json(_theme_path(), {})
    return got if isinstance(got, dict) and isinstance(got.get("tokens"), dict) else {}


def is_mystical(root: "str | None") -> bool:
    """Is this project Mystical itself? Its theme is how Mystical looks, and says nothing about any
    other project, whose design is its own: DESIGN.md, CSS, components (design_audit.context)."""
    here = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    return bool(root) and os.path.realpath(root) == here


def _with_theme(html: str, root: "str | None") -> str:
    """A page of Mystical's that asks for it (<meta name="mystical-theme">) gets the live theme as
    CSS variables ahead of its own CSS. Per page, as a draft may be going somewhere new on purpose."""
    m = _THEME_META.search(html) if is_mystical(root) else None
    tokens = theme().get("tokens") if m else None
    if not m or not tokens:
        return html
    css = ":root{" + ";".join(f"{k}:{v}" for k, v in tokens.items()) + "}"
    return f"{html[:m.end()]}<style data-mystical-theme>{css}</style>{html[m.end():]}"


def render(root: str, entry: dict, html: str) -> str:
    """A page as it's shown: images in it, and the theme if it asked."""
    return _with_theme(_inline_images(html, os.path.dirname(entry["file"]), root), root)


def _read_page(root: str, d: str, entry: dict) -> "dict | None":
    """{html, version, hash} for a page, keeping a version when its content is new."""
    try:
        if os.path.getsize(entry["file"]) > MAX_PAGE_BYTES:
            return None
        with open(entry["file"], encoding="utf-8", errors="replace") as f:
            html = f.read()
    except OSError:
        return None
    digest = hashlib.sha256(html.encode()).hexdigest()[:16]
    vdir = os.path.join(d, "versions", _slug(entry["name"], "page"))
    with _lock:
        os.makedirs(vdir, exist_ok=True)
        names = sorted(n for n in os.listdir(vdir) if n.endswith(".html"))
        last = names[-1] if names else ""
        if not last.endswith(f"-{digest}.html"):
            number = int(last.split("-")[0]) + 1 if last else 1
            with open(os.path.join(vdir, f"{number:05d}-{digest}.html"), "w", encoding="utf-8") as f:
                f.write(html)
            names.append(f"{number:05d}-{digest}.html")
            for old in names[:-KEEP]:
                os.remove(os.path.join(vdir, old))
                names.remove(old)
    version = int(names[-1].split("-")[0])
    shown = render(root, entry, html)
    # A new theme is new to the viewer without being a new version of the page.
    stamp = hashlib.sha256(shown.encode()).hexdigest()[:8] if _THEME_META.search(html) else ""
    return {"html": shown, "version": version, "hash": digest + stamp}


def versions(root: str, board: str, page: str) -> "list[int]":
    d = _board_dir(root, board)
    vdir = os.path.join(d, "versions", _slug(page, "page"))
    try:
        return sorted(int(n.split("-")[0]) for n in os.listdir(vdir) if n.endswith(".html"))
    except OSError:
        return []


def read_version(root: str, board: str, page: str, version: int) -> "str | None":
    d = _board_dir(root, board)
    meta = load(root, board)
    entry = next((p for p in meta["pages"] if p["name"] == page), None)
    vdir = os.path.join(d, "versions", _slug(page, "page"))
    if not entry or not os.path.isdir(vdir):
        return None
    for n in os.listdir(vdir):
        if n.startswith(f"{int(version):05d}-") and n.endswith(".html"):
            with open(os.path.join(vdir, n), encoding="utf-8", errors="replace") as f:
                return render(root, entry, f.read())
    return None


def _public(meta: dict, root: str) -> dict:
    """What a client sees: never the absolute paths, except as words relative to the project."""
    pages = []
    for p in meta["pages"]:
        file = p["file"]
        pages.append({"name": p["name"], "direction": p.get("direction", ""),
                      "file": os.path.relpath(file, root) if file.startswith(root + os.sep) else file})
    return {"id": meta["id"], "title": meta["title"], "pages": pages, "updated": meta.get("updated", 0)}


def poll(root: str, body: dict) -> "tuple[dict, int]":
    """POST chat/design: the board, its comments, and a page's HTML if it isn't the one you have."""
    board = str(body.get("board") or "")
    try:
        meta = load(root, board)
    except Refused as e:
        return {"error": str(e)}, 404
    d = _board_dir(root, board)
    out = {**_public(meta, root), "comments": comments(root, board)}
    name = body.get("page") or (meta["pages"][0]["name"] if meta["pages"] else "")
    entry = next((p for p in meta["pages"] if p["name"] == name), None)
    if entry:
        got = _read_page(root, d, entry)
        out["page"] = name
        if got:
            out["version"], out["hash"] = got["version"], got["hash"]
            out["versions"] = versions(root, board, name)
            if body.get("have") != got["hash"]:
                out["html"] = got["html"]
        else:
            out["missing"] = True
    return out, 200


def listed(root: "str | None") -> "tuple[dict, int]":
    """GET design-boards: this project's boards, newest first."""
    d = os.path.join(root, DIR) if root else ""
    boards = []
    try:
        names = os.listdir(d) if d else []
    except OSError:
        names = []
    for name in names:
        meta = _read_json(os.path.join(d, name, "board.json"), None)
        if isinstance(meta, dict) and meta.get("pages"):
            pub = _public(meta, root)
            pub["open"] = sum(1 for c in comments(root, name) if c.get("status") != "sent")
            boards.append(pub)
    return {"boards": sorted(boards, key=lambda b: -b["updated"])}, 200


def comments(root: str, board: str) -> list:
    got = _read_json(os.path.join(_board_dir(root, board), "comments.json"), [])
    return got if isinstance(got, list) else []


_KINDS = ("comment", "draw", "tweak")


def _clean_comment(c: dict) -> dict:
    kind = c.get("kind") if c.get("kind") in _KINDS else "comment"
    num = lambda v: round(float(v), 1) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0  # noqa: E731
    out = {"id": re.sub(r"[^\w-]", "", str(c.get("id") or ""))[:40] or f"c{time.time_ns()}", "kind": kind,
           "page": str(c.get("page") or "")[:80], "text": str(c.get("text") or "")[:2000],
           "x": num(c.get("x")), "y": num(c.get("y")), "status": "sent" if c.get("status") == "sent" else "open",
           "selector": str(c.get("selector") or "")[:300], "about": str(c.get("about") or "")[:300],
           "at": num(c.get("at")) or time.time()}
    styles = c.get("styles")
    if isinstance(styles, dict):
        out["styles"] = {str(k)[:40]: str(v)[:120] for k, v in list(styles.items())[:16]}
    if kind == "draw" and isinstance(c.get("points"), list):
        out["points"] = [[num(p[0]), num(p[1])] for p in c["points"][:800] if isinstance(p, list) and len(p) == 2]
    if kind == "tweak" and isinstance(c.get("changes"), list):
        out["changes"] = [{k: str(ch.get(k) or "")[:120] for k in ("prop", "from", "to")} for ch in c["changes"][:24] if isinstance(ch, dict)]
    return out


def edit_comments(root: str, body: dict) -> "tuple[dict, int]":
    """POST chat/design-comments: {board, put: {...}} or {board, drop: id} or {board, sent: [ids]}."""
    board = str(body.get("board") or "")
    try:
        load(root, board)
    except Refused as e:
        return {"error": str(e)}, 404
    path = os.path.join(_board_dir(root, board), "comments.json")
    with _lock:
        rows = comments(root, board)
        if isinstance(body.get("put"), dict):
            c = _clean_comment(body["put"])
            for i, r in enumerate(rows):
                if r.get("id") == c["id"]:
                    rows[i] = c
                    break
            else:
                if len(rows) >= MAX_COMMENTS:
                    return {"error": f"A board holds {MAX_COMMENTS} comments. Remove some first."}, 400
                rows.append(c)
        if body.get("drop"):
            rows = [r for r in rows if r.get("id") != body["drop"]]
        if isinstance(body.get("sent"), list):
            sent = set(body["sent"])
            for r in rows:
                if r.get("id") in sent:
                    r["status"] = "sent"
        _write_json(path, rows)
    return {"comments": rows}, 200


def delete(root: str, board: str) -> "tuple[dict, int]":
    """POST chat/design-delete. Only ever the board's own folder; a page elsewhere in the project stays."""
    try:
        d = _board_dir(root, str(board or ""))
    except Refused as e:
        return {"error": str(e)}, 404
    if not os.path.isfile(os.path.join(d, "board.json")):
        return {"error": "No such board."}, 404
    shutil.rmtree(d)
    return {"ok": True}, 200
