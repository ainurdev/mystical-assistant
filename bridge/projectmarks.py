"""Project marks: what a project's tile shows, and the colour it wears.

A mark is either letters, a lucide icon picked on the dashboard, or a logo
image. Letters are the default and are not stored. Any mark can carry a colour.
It is stored per project rel in project_config.json under "mark", for the whole
project like "name", so every browser and Mystical.app agree. The dashboard
used to keep the colour per browser in localStorage (hud-project-tints); it
moves it here once.

Logo bytes live in project_marks.json beside the DB as base64, keyed by
"<sha256>.<ext>". A logo that changes gets a new name, so each one can be
served as immutable. It is one JSON file rather than a folder because MOVE
carries bridge state as JSON files it merges by key (move._STATE_FILES), and a
folder would need its own export and import path. Logos are small: one you
drop is at most 512 KB, and the dashboard shrinks large rasters to 256px before
upload. A picture the bridge reads or fetches itself is kept as it comes, up
to 4 MB (RAW_MAX). A logo that no mark (and no UNDO) points at is dropped on
the next save.

A repo can lend its own picture too. The files it tracks that are named for
an icon, a logo or a brand are what the editor's From this repo strip offers
(repo_images). A repo with no mark wears the best icon among them by itself
(repo_icon): a favicon or an app icon, square by convention, never a logo.*,
which is often a wordmark. That one is never stored. marks() adds it to the
projects listing, so it changes with the file, and a stored mark beats it. A
pick from the strip is stored as the file's path ("repo"), so it follows the
file as well. Both are served by their bytes' hash, like a stored logo.

PICK LOGOS (pick_all) goes further for a project that still wears letters: its
frontend's logo (unideck-api wears unideck's), then a brand file of its own,
then its GitHub organization's picture. A pick counts like the repo's own icon
(source "pick"): an icon the repo gains later wins over it. Spec:
docs/superpowers/specs/logo-picker.md.

A logo with no stored background is AUTO: the browser plates it only where it
would vanish into the ground (lib/logoinfo.ts). "none" pins it bare.

STYLE WITH AI (bridge/logostyle.py) asks a model instead, over every project
but a mark you set: style_candidates() lists what each could wear (what it
wears now, its frontend's logo, its repo's pictures) and apply_style() writes
each answer, with a background and a colour. A pick it makes is "style": the
next run may redo it, and a change by hand makes it yours. Spec:
docs/superpowers/specs/logo-stylist.md.

Marks used to follow Rivendell as well: its clients' logos and brand colours,
imported, refreshed and LINKed from here (docs/superpowers/specs/
project-marks.md, project-logos-v2.md). STYLE WITH AI made that redundant, so
it went on 2026-10-23. The marks it set stay as they were (source
"rivendell", "rv" naming who lent them): machine-set like a pick, so the
stylist may restyle them and a change by hand makes them yours.

What it doesn't do: decode images. The stdlib can't render SVG, and a PNG or
JPEG decoder isn't worth carrying here. Sampling colours and reading a logo's
shape happen in the browser (lib/logoinfo.ts), which already has a canvas.
"""

import base64
import hashlib
import json
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request

from bridge import config, project_config

_lock = threading.RLock()
_PATH = os.path.join(os.path.dirname(config.BRIDGE_DB), "project_marks.json")

LOGO_MAX = 512 * 1024
# ponytail: a repo's file, an organization's picture or a copy of a frontend's
# logo is kept as it comes, because the bridge can't shrink an image (no
# decoder), so a 1024px PNG costs its 1.9 MB here. One over 4 MB isn't kept.
# Shrink on the way in if bigger ones turn up.
RAW_MAX = 4 * 1024 * 1024
CTYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "svg": "image/svg+xml"}
_LOGO_RE = re.compile(r"^[0-9a-f]{64}\.(png|jpg|webp|svg)$")
_ICON_RE = re.compile(r"^[a-z0-9-]{1,48}$")
# A hex, or one of the theme's own inks (the editor's palette swatches).
_COLOR_RE = re.compile(r"^(#[0-9a-fA-F]{6}|var\(--[a-z0-9-]{1,24}\))$")
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
KINDS = ("letters", "icon", "logo")
PLATES = ("light", "dark", "none")   # a background pinned behind a logo; none stored is AUTO


# --- the store ---------------------------------------------------------------

def _load() -> dict:
    try:
        with open(_PATH, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict) -> None:
    os.makedirs(os.path.dirname(_PATH), exist_ok=True)
    tmp = _PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f)
    os.replace(tmp, _PATH)


def sniff(data: bytes) -> "str | None":
    """The logo's type from its own bytes, never from a name or a header."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    head = data[:8192].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if head.startswith(b"<") and b"<svg" in head:
        return "svg"
    return None


def _put_logo(d: dict, data: bytes, cap: int = LOGO_MAX) -> str:
    if not data or len(data) > cap:
        raise ValueError(f"a logo must be under {cap // 1024} KB")
    ext = sniff(data)
    if ext is None:
        raise ValueError("a logo must be a PNG, JPEG, WEBP or SVG image")
    name = f"{hashlib.sha256(data).hexdigest()}.{ext}"
    d.setdefault("logos", {})[name] = base64.b64encode(data).decode()
    return name


def _gc(d: dict) -> None:
    """Drop logos nothing points at: no mark, and not the stylist's UNDO."""
    d.pop("rivendell", None)          # the retired Rivendell sync's state, its UNDO with it
    keep = {m.get("logo") for m in project_config.marks().values()}
    keep |= {m.get("logo") for m in ((d.get("style") or {}).get("undo") or {}).values() if isinstance(m, dict)}
    d["logos"] = {k: v for k, v in (d.get("logos") or {}).items() if k in keep}


def logo(name: str) -> "tuple[bytes, str] | None":
    """A stored logo's bytes and content type, or None."""
    if not isinstance(name, str) or not _LOGO_RE.match(name):
        return None
    b64 = (_load().get("logos") or {}).get(name)
    if not b64:
        return _repo_logo(name)
    return base64.b64decode(b64), CTYPES[name.rsplit(".", 1)[1]]


def clean(m, logos: dict) -> "dict | None":
    """A mark from the dashboard, checked field by field, or None for letters
    with no colour (that is no mark at all). Raises ValueError."""
    if m is None:
        return None
    if not isinstance(m, dict) or m.get("kind") not in KINDS:
        raise ValueError("a mark is letters, an icon or a logo")
    out: dict = {"kind": m["kind"]}
    color = m.get("color")
    if color:
        if not isinstance(color, str) or not _COLOR_RE.match(color):
            raise ValueError("a colour is #rrggbb")
        out["color"] = color
    if out["kind"] == "icon":
        if not isinstance(m.get("icon"), str) or not _ICON_RE.match(m["icon"]):
            raise ValueError("unknown icon")
        out["icon"] = m["icon"]
    if out["kind"] == "logo":
        if isinstance(m.get("repo"), str) and m["repo"]:
            out["repo"] = m["repo"]        # a file in the repo, read afresh; set_mark checks it's one
        elif m.get("logo") in logos:
            out["logo"] = m["logo"]
        else:
            raise ValueError("that logo isn't stored here")
    if m.get("plate"):
        if out["kind"] != "logo" or m["plate"] not in PLATES:
            raise ValueError("a background is light or dark, behind a logo")
        out["plate"] = m["plate"]
    if out == {"kind": "letters"}:
        return None
    return out


def _sans(m: dict, *keys) -> dict:
    return {k: v for k, v in m.items() if k not in keys}


def set_mark(rel: str, mark, logo_data: "str | None" = None) -> "dict | None":
    """Your mark for a project. `logo_data` is a new logo's bytes, base64,
    stored with the mark in one go so a logo is never kept for an edit that
    was cancelled."""
    with _lock:
        d = _load()
        if logo_data:
            try:
                raw = base64.b64decode(logo_data, validate=True)
            except (ValueError, TypeError):
                raise ValueError("the logo isn't base64") from None
            mark = {**_sans(mark or {}, "repo"), "kind": "logo", "logo": _put_logo(d, raw)}
        out = clean(mark, d.get("logos") or {})
        if out and out.get("repo") and not (out["repo"] in _paths(rel) and _name(_root(rel), out["repo"])):
            raise ValueError("that isn't one of this repo's pictures")
        cur = project_config.mark(rel)
        # Back to plain letters from a mark is still your choice: kept as one,
        # or the repo's own icon (or PICK LOGOS) would dress it again.
        if out is None and (cur is not None or repo_icon(rel)):
            out = {"kind": "letters"}
        project_config.set_mark(rel, out)
        _gc(d)
        _save(d)
    if out and out.get("repo"):
        return {**out, "logo": _name(_root(rel), out["repo"])}    # as the listing shows it
    return out


# --- the repo's own picture --------------------------------------------------

# A repo's icon, best first: a vector icon, then an app icon, then a raster
# favicon. Square by convention, so it fits a tile. A logo.* is often a
# wordmark, so _LOGOISH offers it in the editor and it is never worn by itself.
# ponytail: a framework's own icon left in a new repo (SvelteKit's favicon,
# Expo's icon.png) is worn as if it were the project's; BACK TO LETTERS sticks.
# Keep a list of those icons' hashes if one turns up on a real repo.
_ICONS = [re.compile(p) for p in (
    r"(fav)?icon\.svg",
    r"(apple-touch-icon|apple-icon|android-chrome|ic_launcher|icon)([-_]?\d+(x\d+)?)?(-maskable)?\.(png|webp)",
    r"favicon([-_]?\d+(x\d+)?)?\.(png|ico)",
)]
_WORDS = ("icon", "logo", "brand", "android-chrome", "ic_launcher")     # what a picture's name holds
_LOGOISH = re.compile(rf"({'|'.join(_WORDS)})[^/]*\.(svg|png|jpe?g|webp|ico)$")
# Folders whose pictures are a test's or a dependency's. A build's output is
# rarely tracked, and a tracked build/ is where Electron keeps its app icon.
_NOT_OURS = {"test", "tests", "__tests__", "fixtures", "e2e", "screenshots", "__snapshots__",
             "node_modules", "vendor", "coverage"}
REPO_SHOWN = 24         # the most the strip offers

_found: dict = {}       # rel -> (its git index's mtime, its pictures best first)
_read: dict = {}        # a file's real path -> ((mtime, size), its name in the store's form, or None)


def _root(rel: str) -> str:
    return os.path.join(config.BASE_PATH, rel.lstrip("/"))


def _rank(path: str) -> tuple:
    """An icon before anything else, then the biggest by the size in its name,
    then the shallowest."""
    base = path.rsplit("/", 1)[-1].lower()
    tier = next((i for i, r in enumerate(_ICONS) if r.fullmatch(base)), len(_ICONS))
    return tier, -max((int(n) for n in re.findall(r"\d+", base)), default=0), path.count("/"), path


def _paths(rel: str) -> list:
    """The pictures the repo tracks that are named for an icon, a logo or a
    brand, best first. Tracked only, so a build's output or a dependency's
    isn't taken for the project's. git runs again only when the index changes:
    the projects listing asks every ten seconds."""
    from bridge import git
    root = _root(rel)
    try:
        stamp = os.stat(os.path.join(root, ".git", "index")).st_mtime_ns
    except OSError:
        stamp = 0
    hit = _found.get(rel)
    if hit and hit[0] == stamp:
        return hit[1]
    try:
        rc, out, _ = git._run(root, "-c", "core.quotePath=false", "ls-files", "-z", "--",
                              *(f":(icase)*{w}*" for w in _WORDS))
    except ValueError:                  # a tracked name that isn't UTF-8 must not sink the listing
        rc, out = 1, ""
    paths = [] if rc else sorted(
        (p for p in git._ztokens(out)
         if _LOGOISH.search(p.rsplit("/", 1)[-1].lower()) and _NOT_OURS.isdisjoint(p.lower().split("/")[:-1])),
        key=_rank)
    _found[rel] = (stamp, paths)
    return paths


def _name(root: str, path: str) -> "str | None":
    """A repo file's name in the store's form (<sha256>.<ext>), or None for one
    that isn't an image under the cap or leads out of the repo. Read again only
    when the file changes."""
    try:
        real = os.path.realpath(root)
        full = os.path.realpath(os.path.join(real, path))
        st = os.stat(full)
    except (OSError, ValueError):       # gone, or a path the filesystem refuses (a NUL)
        return None
    if not full.startswith(real + os.sep):
        return None                     # ../, an absolute path, or a symlink out
    key = (st.st_mtime_ns, st.st_size)
    hit = _read.get(full)
    if hit and hit[0] == key:
        return hit[1]
    name = None
    try:
        with open(full, "rb") as f:
            data = f.read(RAW_MAX + 1)
        ext = sniff(data) if len(data) <= RAW_MAX else None
        name = f"{hashlib.sha256(data).hexdigest()}.{ext}" if ext else None
    except OSError:
        pass
    _read[full] = (key, name)
    return name


def _repo_logo(name: str) -> "tuple[bytes, str] | None":
    """A repo file the listing or the strip named, served only while its bytes
    still hash to that name."""
    for full, (_key, n) in list(_read.items()):
        if n != name:
            continue
        try:
            with open(full, "rb") as f:
                data = f.read(RAW_MAX + 1)
        except OSError:
            continue
        if f"{hashlib.sha256(data).hexdigest()}.{sniff(data)}" == name:
            return data, CTYPES[name.rsplit(".", 1)[1]]
    return None


def repo_images(rel: str) -> list:
    """What the editor's From this repo strip offers: each picture once (a
    monorepo copies one favicon into every app), best first."""
    root, out, seen = _root(rel), [], set()
    for p in _paths(rel):
        name = _name(root, p)
        if name and name not in seen:
            seen.add(name)
            out.append({"path": p, "logo": name})
            if len(out) == REPO_SHOWN:
                break
    return out


def repo_icon(rel: str) -> "dict | None":
    """The icon a repo wears when nothing else is set: its best _ICONS file."""
    root = _root(rel)
    for p in _paths(rel):
        if _rank(p)[0] == len(_ICONS):
            return None                 # the rest are logos and such: offered, never worn
        name = _name(root, p)
        if name:
            return {"path": p, "logo": name}
    return None


def marks(rels) -> dict:
    """Every mark as the projects listing sends it. A mark on a repo file
    carries that file's logo as it is now. A listed repo with no mark wears its
    own icon (auto), and so does a colour-only mark the Rivendell sync left (its
    client lent no logo)."""
    out = project_config.marks()
    for rel, m in out.items():
        if isinstance(m.get("repo"), str):
            name = _name(_root(rel), m["repo"])
            if name:
                m["logo"] = name
    for rel in rels:
        m = out.get(rel)
        picked = (m or {}).get("source") == "pick"       # an icon of its own beats a pick
        if m is None or picked or (m.get("source") == "rivendell" and m.get("kind") == "letters"):
            got = repo_icon(rel)
            if got:
                out[rel] = {**(m if m and not picked else {}), "kind": "logo", "logo": got["logo"],
                            "repo": got["path"], "auto": True}
    return out


# --- PICK LOGOS ----------------------------------------------------------------

# A backend's name points at its frontend: unideck-api -> unideck (or unideck-app...).
_BACKEND = re.compile(r"^(?P<stem>.+?)[-_](api|server|backend|worker|service)$")
_FRONTS = ("", "-app", "-web", "-frontend", "-ui", "-portal", "-client")


def _frontend(rel: str, rels: list, shown: dict) -> "str | None":
    """The project a backend's name points at as its frontend, beside it in
    the same folder, if it wears a logo. A same-named one elsewhere is another
    client's portal, not this one's."""
    folder, _, base = rel.rpartition("/")
    m = _BACKEND.match(base.lower())
    if not m:
        return None
    names = {m["stem"] + f for f in _FRONTS}
    return min((r for r in rels if r != rel and r.rpartition("/")[0] == folder
                and r.rpartition("/")[2].lower() in names and (shown.get(r) or {}).get("logo")), default=None)


def _brand(rel: str) -> "str | None":
    """A logo or brand file of the repo's own: one with the first word of the
    repo's name among its words (NR-rgb_logo_default.svg in nr-kantoor, never
    apple-logo.svg in app), else its logo.* if it has only one. A hub's folder
    of clients' logos names none for the repo, and holds more than one logo.*."""
    root = _root(rel)
    token = next((t for t in re.split(r"[-_.]+", rel.rpartition("/")[2].lower()) if t), "")
    bare: dict = {}                       # logo.* by content: one file copied about counts once
    for p in _paths(rel):
        stem = p.rsplit("/", 1)[-1].lower().rsplit(".", 1)[0]
        name = _name(root, p)
        if not name:
            continue
        if token and token in re.split(r"[-_. ]+", stem):
            return p
        if stem == "logo":
            bare.setdefault(name, p)
    return next(iter(bare.values())) if len(bare) == 1 else None


def _owner(rel: str) -> "str | None":
    from bridge import github
    slug = github.origin_slug(_root(rel))
    return slug.split("/")[0] if slug else None


def _github_user(owner: str) -> "tuple[str, str] | None":
    """(type, avatar_url) of a GitHub account, through the gh login. None when
    gh is missing, signed out or offline."""
    from bridge import github
    rc, out, _ = github._run("gh", "api", f"users/{owner}", "--jq", "[.type, .avatar_url] | @tsv")
    kind, _, url = out.strip().partition("\t")
    return (kind, url) if rc == 0 and url else None


def _org(rel: str, seen: dict) -> "tuple[str, bytes] | None":
    """Its GitHub organization's picture: never a person's (a face), never
    GitHub's generated default. `seen` holds each owner's answer for one pass."""
    owner = _owner(rel)
    if not owner:
        return None
    if owner not in seen:
        user = _github_user(owner)
        data = _download(f"{user[1]}&s=256") if user and user[0] == "Organization" else None
        # ponytail: GitHub's generated default comes back 420x420 whatever s= asks for, and an
        # uploaded picture at the size asked; if GitHub changes that, look at its pixels instead.
        if data and data[:8] == b"\x89PNG\r\n\x1a\n" and data[16:24] == (420).to_bytes(4, "big") * 2:
            data = None
        seen[owner] = data
    return (owner, seen[owner]) if seen[owner] else None


def pick_all() -> dict:
    """PICK LOGOS: every listed project still wearing letters gets the best
    logo found for it: its frontend's (copied), a brand file of its own (by
    path, so it follows the file), or its organization's picture (copied).
    Never a mark you set, Rivendell's, or a repo's own icon. The picks are
    kept for undo_picks."""
    from bridge import browser
    rels = browser.list_projects()
    shown = marks(rels)
    todo = [r for r in rels if r not in shown]
    found: dict = {}                      # rel -> (mark, bytes to store or None)
    seen: dict = {}
    for rel in todo:
        front = _frontend(rel, rels, shown)
        got = logo(shown[front]["logo"]) if front else None
        if got:
            color = {"color": shown[front]["color"]} if shown[front].get("color") else {}
            found[rel] = ({"kind": "logo", **color, "source": "pick", "pick": {"how": "frontend", "from": front}}, got[0])
            continue
        path = _brand(rel)
        if path:
            found[rel] = ({"kind": "logo", "repo": path, "source": "pick", "pick": {"how": "brand"}}, None)
            continue
        org = _org(rel, seen)
        if org:
            found[rel] = ({"kind": "logo", "source": "pick", "pick": {"how": "org", "from": org[0]}}, org[1])
    with _lock:
        d = _load()
        cur = project_config.marks()      # again: a mark set while it looked stands
        picked = []
        for rel, (mark, data) in found.items():
            if rel in cur:
                continue
            if data:
                mark = {**mark, "logo": _put_logo(d, data, RAW_MAX)}
            project_config.set_mark(rel, mark)
            picked.append(rel)
        if picked:                        # a run that found nothing new keeps the last one's undo
            d["pick"] = {"undo": picked}
        _gc(d)
        _save(d)
    return {"picked": [{"rel": r, **found[r][0]["pick"]} for r in picked],
            "none": [r for r in todo if r not in found]}


def undo_picks() -> dict:
    """Undo the last PICK LOGOS: letters again, except where you changed it since."""
    with _lock:
        d = _load()
        undone = 0
        for rel in (d.get("pick") or {}).get("undo") or []:
            if (project_config.mark(rel) or {}).get("source") == "pick":
                project_config.set_mark(rel, None)
                undone += 1
        d["pick"] = {"undo": []}
        _gc(d)
        _save(d)
    return {"undone": undone}


# --- STYLE WITH AI ---------------------------------------------------------------

STYLE_CANDS = 8         # a project's candidates on the stylist's sheet: what it wears and the likeliest


def _about(rel: str) -> str:
    """The README's first two lines, for the stylist: what the project is."""
    for name in ("README.md", "readme.md", "README"):
        try:
            with open(os.path.join(_root(rel), name), encoding="utf-8", errors="replace") as f:
                head = f.read(4000)
        except OSError:
            continue
        lines = [t for t in (ln.strip().lstrip("#>*").strip() for ln in head.splitlines()) if t]
        return " — ".join(lines[:2])[:200]
    return ""


def _wears(m) -> str:
    if not m:
        return "letters"
    if m.get("auto"):
        return "auto"
    return m.get("source") or m.get("kind") or "letters"


def _mine(m) -> bool:
    """A mark you set by hand (no source): the stylist never touches it."""
    return isinstance(m, dict) and not m.get("auto") and m.get("source") not in ("rivendell", "pick", "style")


def style_candidates() -> dict:
    """What the stylist may choose from, per listed project but a mark you set:
    what it wears now, its frontend's logo, then its repo's pictures (best
    first), each logo once and at most STYLE_CANDS, with ids c1..cN for the
    contact sheet. `sig` lets a run check that the sheet it is handed was drawn
    from this very list."""
    from bridge import browser, github
    rels = browser.list_projects()
    shown = marks(rels)
    names = project_config.names()
    projects, yours = [], []
    for rel in rels:
        m = shown.get(rel)
        if _mine(m):
            yours.append(rel)
            continue
        cands: list = []

        def add(logo_name, **kw):
            if logo_name and len(cands) < STYLE_CANDS and all(c["logo"] != logo_name for c in cands):
                cands.append({"id": f"c{len(cands) + 1}", "logo": logo_name, **kw})
        if m and m.get("kind") == "logo":
            add(m.get("logo"), src="now", **({"path": m["repo"]} if m.get("repo") else {}))
        front = _frontend(rel, rels, shown)
        if front:
            add(shown[front]["logo"], src="frontend", **{"from": front})
        for img in repo_images(rel):
            add(img["logo"], src="repo", path=img["path"])
        projects.append({"rel": rel, "name": names.get(rel) or rel.rpartition("/")[2],
                         "remote": github.origin_slug(_root(rel)) or "", "about": _about(rel),
                         "wears": _wears(m), "cands": cands})
    sig = hashlib.sha256(json.dumps([[p["rel"], p["cands"]] for p in projects], sort_keys=True).encode()).hexdigest()
    return {"projects": projects, "yours": yours, "sig": sig[:16]}


def _hex(v) -> "str | None":
    return v if isinstance(v, str) and _HEX_RE.match(v) else None


def _near(a, b) -> bool:
    """Two hex colours a glance can't tell apart (the model's #e8562a for NR's #ea5b13)."""
    if not (_hex(a) and _hex(b)):
        return False
    return sum((int(a[i:i + 2], 16) - int(b[i:i + 2], 16)) ** 2 for i in (1, 3, 5)) < 40 ** 2


def _how(before, after) -> list:
    """What an answer changed, most telling first."""
    b, a = before or {"kind": "letters"}, after or {"kind": "letters"}
    out = []
    if a.get("kind") == "icon" and (b.get("kind"), b.get("icon")) != ("icon", a.get("icon")):
        out.append("icon")
    elif a.get("kind") == "logo" and (b.get("kind"), b.get("logo")) != ("logo", a.get("logo")):
        out.append("logo")
    if (b.get("plate") or "auto") != (a.get("plate") or "auto"):
        out.append("background")
    if b.get("color") != a.get("color"):
        out.append("colour")
    return out


def apply_style(rel: str, cand: "dict | None" = None, *, icon: "str | None" = None, plate: "str | None" = None,
                color: "str | None" = None, why: str = "", run: str = "") -> dict:
    """One answer of the stylist's, written. `cand` is one of the project's
    style_candidates() (None, or what it wears now: keep it), or `icon` a
    lucide name for a project with nothing of its own. `plate` is "auto" (drop
    it), "none", "light" or "dark"; None leaves it, as a None `color` does.
    What it replaced is kept for undo_style(), per run. An answer that changes
    nothing writes nothing."""
    with _lock:
        d = _load()
        before = marks([rel]).get(rel)
        cur = project_config.mark(rel)
        if _mine(cur):                    # set by hand while the run looked: yours stands
            return {"rel": rel, "how": [], "before": before, "after": before}
        if icon:
            base = {"kind": "icon", "icon": icon}
        elif cand and cand.get("src") == "repo":
            base = {"kind": "logo", "repo": cand["path"]}
        elif cand and cand.get("src") == "frontend":
            got = logo(cand["logo"])
            if not got:
                raise ValueError("its frontend's logo is gone")
            base = {"kind": "logo", "logo": _put_logo(d, got[0], RAW_MAX)}
        elif before and before.get("auto"):
            base = {"kind": "logo", "repo": before["repo"]}
        elif cur:
            base = _sans(cur, "source", "pick", "styled", "rv", "weighed_rv")
        else:
            base = {"kind": "letters"}
        mark = _sans(base, "plate", "color", "styled", "source")
        if base.get("kind") == "logo" and plate in PLATES:
            mark["plate"] = plate
        elif base.get("kind") == "logo" and plate is None and base.get("plate"):
            mark["plate"] = base["plate"]
        if _hex(color) and not _near(color, base.get("color")):
            mark["color"] = color
        elif base.get("color"):
            mark["color"] = base["color"]         # a near miss of the colour it wears isn't a change
        mark["source"] = "style"
        mark["styled"] = (why or "")[:160]
        shown = {**_sans(mark, "source", "styled"),
                 **({"logo": _name(_root(rel), mark["repo"])} if mark.get("repo") else {})}
        how = _how(before, shown)
        if not how:
            return {"rel": rel, "how": [], "before": before, "after": before}
        st = d.get("style") if isinstance(d.get("style"), dict) else {}
        if st.get("run") != run:
            st = {"run": run, "undo": {}}     # a new run: the last one's list and Undo are over
        st["undo"].setdefault(rel, cur)
        d["style"] = st
        project_config.set_mark(rel, mark)
        _gc(d)
        _save(d)
        return {"rel": rel, "how": how, "before": before, "after": marks([rel]).get(rel)}


def save_style_run(run: dict) -> None:
    """A finished run, kept beside its Undo so both outlive a restart (logostyle.state)."""
    with _lock:
        d = _load()
        st = d.get("style") if isinstance(d.get("style"), dict) else {}
        d["style"] = {**st, "last": run}
        _save(d)


def style_last() -> "dict | None":
    last = (_load().get("style") or {}).get("last")
    return last if isinstance(last, dict) else None


def style_left(run: "str | None") -> set:
    """The projects run `run`'s Undo can still take back."""
    st = _load().get("style") or {}
    return set(st.get("undo") or {}) if run and st.get("run") == run else set()


def undo_style(rel: "str | None" = None) -> dict:
    """Undo the last run, or one project of it: what it replaced comes back,
    except where you changed the mark since (a change by hand drops "styled")."""
    with _lock:
        d = _load()
        snap = (d.get("style") or {}).get("undo") or {}
        undone = 0
        for r in ([rel] if rel else list(snap)):
            if r not in snap:
                continue
            if "styled" in (project_config.mark(r) or {}):
                project_config.set_mark(r, snap[r])
                undone += 1
            del snap[r]
        _gc(d)
        _save(d)
    return {"undone": undone}


# --- fetching a picture (PICK LOGOS' organization pictures) -----------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None                       # a 3xx becomes an HTTPError


_opener = urllib.request.build_opener(_NoRedirect)


def _download(url) -> "bytes | None":
    """A picture off its URL: over https only, never following a redirect (one
    could send the bridge anywhere), and only an image under the cap. Never
    raises: one owner's bad URL must not sink a PICK LOGOS pass."""
    try:
        if urllib.parse.urlparse(url).scheme != "https":
            return None
        req = urllib.request.Request(url, headers={"User-Agent": "mystical-bridge"})
        with _opener.open(req, timeout=15) as r:
            data = r.read(RAW_MAX + 1)
        return data if len(data) <= RAW_MAX and sniff(data) else None
    except Exception:  # noqa: BLE001 — urllib raises a zoo (InvalidURL, IncompleteRead, …)
        return None
