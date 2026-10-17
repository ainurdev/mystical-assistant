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
upload. A client's logo from Rivendell is kept as it is served, up to 4 MB
(RV_LOGO_MAX). A logo that no mark (and no UNDO) points at is dropped on the
next save.

Rivendell keeps a logo and a brand colour per client (Client.logoDocument,
Client.brandColor), and its projects hang off clients. So a local repo linked to
a client's project can wear that client's mark. A project can also carry a logo
of its own (Project.logoKey), which internal projects need because they have no
client: it wins over the client's (_lent), and the client's is the fallback for
one the bridge can't keep. GET /plugin/projects (with the
bridge token) lists each project, with the fullName of every repo linked to it
or mirroring one (rivendell.projects()). A local repo matches on any of its
remotes (github.remote_slugs), because a fork of a mirror tracks the upstream
under another name.

A repo no Rivendell project names has nothing to match: a copy under another
owner (ainurdev/elvou beside Elvou/elvou), or one newer than Rivendell's last
GitHub sync. The editor's LINK links it to a project in Rivendell itself, as
the project page does (link()), instead of keeping the link here: kept here it
would reach this bridge only, while Rivendell's reaches every bridge on it,
through the same offer.

import_all() takes every match except a mark you set yourself (no "source").
It keeps what it replaced for UNDO and turns following on. While following is
on, refresh() runs at boot and then every 6h, without a notice: it pulls changed
logos and colours and takes new matches.

What it doesn't do:
- Decode images. The stdlib can't render SVG, and a PNG or JPEG decoder isn't
  worth carrying here. Sampling colours and reading a logo's shape happen in the
  browser (lib/logoinfo.ts), which already has a canvas.
- Rename projects after Rivendell. Names stay yours.

Best effort throughout. A Rivendell that is down, refuses the token, or predates
/plugin/projects means no offer, never an error in the listing.
"""

import base64
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from bridge import config, project_config

_lock = threading.RLock()
_PATH = os.path.join(os.path.dirname(config.BRIDGE_DB), "project_marks.json")

LOGO_MAX = 512 * 1024
# ponytail: a client logo is kept as Rivendell serves it, because the bridge
# can't shrink an image (no decoder), so Elvou's 1024px PNG costs its 1.9 MB
# here. One over 4 MB stays colour-only. Shrink on import if bigger ones turn up.
RV_LOGO_MAX = 4 * 1024 * 1024
CTYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "svg": "image/svg+xml"}
_LOGO_RE = re.compile(r"^[0-9a-f]{64}\.(png|jpg|webp|svg)$")
_ICON_RE = re.compile(r"^[a-z0-9-]{1,48}$")
# A hex, or one of the theme's own inks (the editor's palette swatches).
_COLOR_RE = re.compile(r"^(#[0-9a-fA-F]{6}|var\(--[a-z0-9-]{1,24}\))$")
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
KINDS = ("letters", "icon", "logo")
PLATES = ("light", "dark")      # a background behind a logo; none is the default
REFRESH_S = 6 * 3600
_CACHE_S = 600          # how long one look at Rivendell answers for the dashboard


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
    """Drop logos nothing points at: no mark, and not the UNDO snapshot."""
    keep = {m.get("logo") for m in project_config.marks().values()}
    snap = (d.get("rivendell") or {}).get("undo") or {}
    keep |= {m.get("logo") for m in snap.values() if isinstance(m, dict)}
    d["logos"] = {k: v for k, v in (d.get("logos") or {}).items() if k in keep}


def logo(name: str) -> "tuple[bytes, str] | None":
    """A stored logo's bytes and content type, or None."""
    if not isinstance(name, str) or not _LOGO_RE.match(name):
        return None
    b64 = (_load().get("logos") or {}).get(name)
    if not b64:
        return None
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
        if m.get("logo") not in logos:
            raise ValueError("that logo isn't stored here")
        out["logo"] = m["logo"]
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
    """Your mark for a project: it never follows Rivendell again until you ask,
    unless all that changed is the background (plate) behind a followed logo.
    `logo_data` is a new logo's bytes, base64, stored with the mark in one go
    so a logo is never kept for an edit that was cancelled."""
    with _lock:
        d = _load()
        if logo_data:
            try:
                raw = base64.b64decode(logo_data, validate=True)
            except (ValueError, TypeError):
                raise ValueError("the logo isn't base64") from None
            mark = {**(mark or {}), "kind": "logo", "logo": _put_logo(d, raw)}
        out = clean(mark, d.get("logos") or {})
        cur = project_config.mark(rel)
        # A background alone is how a logo shows here, not a new mark: one that
        # follows Rivendell keeps following (IB Groups' black logo on LIGHT).
        if cur and cur.get("source") == "rivendell" and out and _sans(out, "plate") == _sans(cur, "plate", "source", "rv"):
            out = {**_sans(cur, "plate"), **({"plate": out["plate"]} if out.get("plate") else {})}
        # Back to plain letters from a mark is still your choice: kept as one,
        # or following Rivendell would dress the repo again on its next pass.
        if out is None and cur is not None:
            out = {"kind": "letters"}
        project_config.set_mark(rel, out)
        _gc(d)
        _save(d)
    return out


# --- Rivendell ---------------------------------------------------------------

_seen: dict = {"at": 0.0, "matches": {}, "errors": [], "listed": 0, "asked": False, "answered": False,
               "projects": [], "unlinked": []}


def _hex(v) -> "str | None":
    return v if isinstance(v, str) and _HEX_RE.match(v) else None


def _local_slugs() -> dict:
    """rel -> every remote's owner/repo (lowercased), for each listed repo."""
    from bridge import browser, github
    out = {}
    for rel in browser.list_projects():
        slugs = {s.lower() for s in github.remote_slugs(os.path.join(config.BASE_PATH, rel.lstrip("/")))}
        if slugs:
            out[rel] = slugs
    return out


def _lent(p: dict) -> list:
    """The (logo id, url) a project lends, best first: its own logo, then its
    client's. An older Rivendell sends no project logo; that is just the client's."""
    c = p.get("client") or {}
    return [(lid, url) for lid, url in ((p.get("logoId"), p.get("logoUrl")), (c.get("logoId"), c.get("logoUrl")))
            if lid and url]


def _own(p: dict) -> bool:
    """Whether a project lends a logo of its own, not its client's."""
    return bool(p.get("logoId") and p.get("logoUrl"))


def match(projects: list, local: dict) -> dict:
    """rel -> the Rivendell project that has a mark for that repo: a logo of its
    own, or its client's logo or colour. Pure. The first project to name a repo
    wins, and a repo found under several of its own remotes takes the
    alphabetically first."""
    by_slug: dict = {}
    for p in projects:
        c = p.get("client") or {}
        if not (_lent(p) or _hex(c.get("brandColor"))):
            continue
        for full in p.get("repositories") or []:
            if isinstance(full, str):
                by_slug.setdefault(full.lower(), p)
    out = {}
    for rel, slugs in local.items():
        hit = next((by_slug[s] for s in sorted(slugs) if s in by_slug), None)
        if hit is not None:
            out[rel] = hit
    return out


def _look(force: bool = False) -> dict:
    """What Rivendell says, matched against the repos here: cached for
    _CACHE_S, because the dashboard asks on every load."""
    from bridge import rivendell
    with _lock:
        if not force and time.time() - _seen["at"] < _CACHE_S:
            return _seen
    projects, errors = rivendell.projects()
    local = _local_slugs() if projects else {}
    # Every repo some project names, internal ones too: a repo outside them all is LINK's.
    named = {s.lower() for p in projects for s in p.get("repositories") or [] if isinstance(s, str)}
    with _lock:
        # asked: some Rivendell is connected at all. answered: one listed projects.
        _seen.update(at=time.time(), matches=match(projects, local), errors=errors,
                     listed=len(local), asked=bool(projects) or bool(errors),
                     answered=bool(projects), projects=projects,
                     unlinked=sorted(r for r, slugs in local.items() if not slugs & named))
        return _seen


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None                       # a 3xx becomes an HTTPError


_opener = urllib.request.build_opener(_NoRedirect)


def _download(url) -> "bytes | None":
    """A client logo off its signed URL. Over https, or plain http to a local
    Rivendell; never following a redirect (a signed object-store URL doesn't,
    and one could send the bridge anywhere); only an image, under the cap.
    Never raises: one client's bad URL must not sink an import or a refresh."""
    try:
        u = urllib.parse.urlparse(url)
        if u.scheme != "https" and not (u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")):
            return None
        req = urllib.request.Request(url, headers={"User-Agent": "mystical-bridge"})
        with _opener.open(req, timeout=15) as r:
            data = r.read(RV_LOGO_MAX + 1)
        return data if len(data) <= RV_LOGO_MAX and sniff(data) else None
    except Exception:  # noqa: BLE001 — urllib raises a zoo (InvalidURL, IncompleteRead, …)
        return None


def _known(marks: dict, logos: dict) -> dict:
    """client logoId -> the stored logo already wearing it: one client's eight
    repos share one download, and a refresh downloads only what changed."""
    return {(m.get("rv") or {}).get("logo_id"): m["logo"] for m in marks.values()
            if m.get("source") == "rivendell" and (m.get("rv") or {}).get("logo_id")
            and m.get("logo") in logos}


def _fetch_logos(matches: dict, known: dict) -> dict:
    """logo id -> bytes for every logo the store doesn't hold yet: per match, the
    best one it lends (_lent) that can be had, trying the next when a download
    fails. This is the network part of an import, done before the lock is taken."""
    out: dict = {}
    for p in matches.values():
        for lid, url in _lent(p):
            if lid in known or lid in out:
                break
            data = _download(url)
            if data is not None:
                out[lid] = data
                break
    return out


def _follow(rel: str, p: dict, d: dict, known: dict, fetched: dict) -> dict:
    """The mark a matched repo wears while it follows Rivendell. A logo that
    couldn't be fetched leaves logo_id unset, so the next refresh tries again."""
    c = p.get("client") or {}
    cur = project_config.mark(rel) or {}
    lid = name = None
    for cand, _url in _lent(p):              # the best logo the store holds or just fetched
        if known.get(cand) in (d.get("logos") or {}):
            lid, name = cand, known[cand]
        elif cand in fetched:
            lid, name = cand, _put_logo(d, fetched[cand], RV_LOGO_MAX)
            known[cand] = name
        if name:
            break
    own = bool(name) and lid == p.get("logoId")
    mark: dict = {"kind": "logo" if name else "letters", "source": "rivendell",
                  "rv": {"instance": p.get("instance_id"), "client": c.get("id"),
                         "name": p.get("name") if own else c.get("name"), "logo_id": lid}}
    if own:
        mark["rv"]["own"] = True
    if name:
        mark["logo"] = name
        if cur.get("plate"):             # a background you chose rides over every refresh
            mark["plate"] = cur["plate"]
    if _hex(c.get("brandColor")):
        mark["color"] = c["brandColor"]
    if mark != cur:
        project_config.set_mark(rel, mark)
    return mark


def _yours(m) -> bool:
    return isinstance(m, dict) and m.get("source") != "rivendell"


def import_all(only: "str | None" = None) -> dict:
    """Every match follows Rivendell from now on, except marks you set. With
    `only`, just that one project, even if you set its mark (the editor's
    FOLLOW RIVENDELL)."""
    seen = _look(force=True)
    matches = {r: p for r, p in seen["matches"].items() if only is None or r == only}
    marks = project_config.marks()
    known = _known(marks, _load().get("logos") or {})
    fetched = _fetch_logos(matches, known)
    with _lock:
        d = _load()
        rv = d.setdefault("rivendell", {})
        undo = {} if only is None else dict(rv.get("undo") or {})
        kept = []
        marks = project_config.marks()   # again: an edit may have landed during the downloads
        for rel, p in sorted(matches.items()):
            cur = marks.get(rel)
            if only is None and _yours(cur):
                kept.append(rel)
                continue
            undo.setdefault(rel, cur)
            _follow(rel, p, d, known, fetched)
        if only is None:
            rv.update(sync=True, dismissed=[])
        rv.update(undo=undo, synced_at=time.time())
        _gc(d)
        _save(d)
    return {"following": len(matches) - len(kept), "kept": kept,
            "clients": len({(p.get("client") or {}).get("id") for p in matches.values()})}


def refresh() -> dict:
    """While following: re-read Rivendell, re-dress every repo that follows it,
    and take new matches. A mark you set is never touched. Quiet by design:
    no notice for a refreshed logo."""
    with _lock:
        if not (_load().get("rivendell") or {}).get("sync"):
            return {"following": 0, "skipped": "off"}
    seen = _look(force=True)
    marks = project_config.marks()
    todo = {r: p for r, p in seen["matches"].items() if not _yours(marks.get(r))}
    known = _known(marks, _load().get("logos") or {})
    fetched = _fetch_logos(todo, known)
    with _lock:
        d = _load()
        rv = d.setdefault("rivendell", {})
        if not rv.get("sync"):           # switched off, or undone, while it downloaded
            return {"following": 0, "skipped": "off"}
        undo = rv.get("undo") if isinstance(rv.get("undo"), dict) else {}
        marks = project_config.marks()   # again: an edit may have landed during the downloads
        for rel, p in todo.items():
            if _yours(marks.get(rel)):
                continue
            undo.setdefault(rel, marks.get(rel))
            _follow(rel, p, d, known, fetched)
        rv.update(undo=undo, synced_at=time.time())
        _gc(d)
        _save(d)
    return {"following": len(todo)}


def link(rel: str, instance: str, project_id: str) -> dict:
    """LINK in the editor, for a repo no Rivendell project names: link it to one
    in Rivendell itself (rivendell.link_repo), so the link reaches every bridge
    on that Rivendell and their offer, then follow that client here at once.
    Only a project the last look listed: the id lands in a Rivendell path."""
    from bridge import rivendell
    if not any(p.get("id") == project_id and p.get("instance_id") == instance for p in _look()["projects"]):
        raise ValueError("that isn't one of Rivendell's projects")
    slugs = _local_slugs().get(rel)
    if not slugs:
        raise ValueError("this repo has no remote to link")
    linked = rivendell.link_repo(instance, project_id, slugs)
    return {**import_all(only=rel), "linked": linked}


def undo() -> dict:
    """Put back every mark the last import replaced, and stop following. Those
    repos count as seen, so the offer doesn't come straight back."""
    with _lock:
        d = _load()
        rv = d.setdefault("rivendell", {})
        snap = rv.get("undo")
        if not isinstance(snap, dict):
            return {"undone": 0}
        undone = 0
        for rel, m in snap.items():
            if _yours(project_config.mark(rel)):
                continue                  # you changed it since: yours stands
            project_config.set_mark(rel, m if isinstance(m, dict) else None)
            undone += 1
        rv.update(sync=False, undo=None, dismissed=sorted(snap))
        _gc(d)
        _save(d)
    return {"undone": undone}


def _offer_rels(seen: dict, marks: dict) -> list:
    """Matched repos still wearing plain letters: what IMPORT would change."""
    return sorted(r for r in seen["matches"] if r not in marks)


def dismiss() -> dict:
    """NOT NOW: these repos are seen; the offer waits for one it hasn't shown."""
    rels = _offer_rels(_look(), project_config.marks())
    with _lock:
        d = _load()
        rv = d.setdefault("rivendell", {})
        rv["dismissed"] = sorted(set(rv.get("dismissed") or []) | set(rels))
        _save(d)
    return {"dismissed": len(rels)}


def set_sync(on: bool) -> dict:
    """The Settings switch. Off freezes every mark as it is; on catches up now."""
    with _lock:
        d = _load()
        d.setdefault("rivendell", {})["sync"] = bool(on)
        _save(d)
    return refresh() if on else {"following": 0}


def state(force: bool = False) -> dict:
    """What the dashboard shows: the offer (only while not following, and only
    for a repo it hasn't shown), the follow switch, and per repo which client
    matched, for the editor's FOLLOW RIVENDELL."""
    seen = _look(force)
    marks = project_config.marks()
    rv = _load().get("rivendell") or {}
    sync = bool(rv.get("sync"))
    offer_rels = _offer_rels(seen, marks)
    unseen = set(offer_rels) - set(rv.get("dismissed") or [])
    clients: dict = {}
    for rel in offer_rels:
        p = seen["matches"][rel]
        c = p.get("client") or {}
        lent = _lent(p)
        own = _own(p)
        e = clients.setdefault(p.get("id") if own else c.get("id"),
                               {"name": (p.get("name") if own else c.get("name")) or "?", "repos": 0,
                                "logo": lent[0][1] if lent else None, "color": _hex(c.get("brandColor"))})
        e["repos"] += 1
    ranked = sorted(clients.values(), key=lambda e: (-e["repos"], e["name"].lower()))
    # What LINK offers: the projects whose client has a mark to lend.
    lenders = []
    for p in seen["projects"]:
        c = p.get("client") or {}
        if _lent(p) or _hex(c.get("brandColor")):
            lenders.append({"instance": p.get("instance_id"), "id": p.get("id"), "name": p.get("name") or "?",
                            "client": c.get("name"), "logo": bool(_lent(p)),
                            "color": _hex(c.get("brandColor"))})
    return {
        "available": seen["answered"],
        "asked": seen["asked"],
        "sync": sync,
        "synced_at": rv.get("synced_at") or None,
        "following": sum(1 for m in marks.values() if m.get("source") == "rivendell"),
        "unmatched": max(0, seen["listed"] - len(seen["matches"])),
        "offer": ({"count": len(offer_rels), "clients": [e["name"] for e in ranked],
                   "logos": [{"url": e["logo"], "color": e["color"]} for e in ranked][:6]}
                  if offer_rels and unseen and not sync else None),
        "can_undo": isinstance(rv.get("undo"), dict) and bool(rv.get("undo")),
        # client: who lends the mark, as the editor names it (the project, for its own logo).
        "matches": {r: {"client": p.get("name") if _own(p)
                                  else (p.get("client") or {}).get("name"),
                        "logo": bool(_lent(p)),
                        "color": _hex((p.get("client") or {}).get("brandColor")),
                        "own": _own(p)}
                    for r, p in seen["matches"].items()},
        "projects": sorted(lenders, key=lambda e: ((e["client"] or e["name"]).lower(), e["name"].lower())),
        "unlinked": seen["unlinked"],
        "errors": seen["errors"],
    }


_timer: "threading.Timer | None" = None


def _tick() -> None:
    global _timer
    try:
        refresh()
    except Exception as e:  # noqa: BLE001 — a background follow must never crash the bridge
        print(f"projectmarks: refresh failed: {e}")
    _timer = threading.Timer(REFRESH_S, _tick)
    _timer.daemon = True
    _timer.start()


def boot() -> None:
    """Follow Rivendell in the background: once the workers have had time to
    dial (90s), then every 6h. A no-op while following is off."""
    global _timer
    _timer = threading.Timer(90, _tick)
    _timer.daemon = True
    _timer.start()
