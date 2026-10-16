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
folder would need its own export and import path. Logos are small: at most
512 KB each, and the dashboard shrinks large rasters to 256px before upload. A
logo that no mark (and no UNDO) points at is dropped on the next save.

Rivendell keeps a logo and a brand colour per client (Client.logoDocument,
Client.brandColor), and its projects hang off clients. So a local repo linked to
a client's project can wear that client's mark. GET /plugin/projects (with the
bridge token) lists each project, with the fullName of every repo linked to it
or mirroring one (rivendell.projects()). A local repo matches on any of its
remotes (github.remote_slugs), because a fork of a mirror tracks the upstream
under another name.

import_all() takes every match except a mark you set yourself (no "source").
It keeps what it replaced for UNDO and turns following on. While following is
on, refresh() runs at boot and then every 6h, without a notice: it pulls changed
logos and colours and takes new matches.

What it doesn't do:
- Decode images. The stdlib can't render SVG, and a PNG or JPEG decoder isn't
  worth carrying here. Choosing a plate and sampling colours happen in the
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
CTYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "svg": "image/svg+xml"}
_LOGO_RE = re.compile(r"^[0-9a-f]{64}\.(png|jpg|webp|svg)$")
_ICON_RE = re.compile(r"^[a-z0-9-]{1,48}$")
# A hex, or one of the theme's own inks (the editor's palette swatches).
_COLOR_RE = re.compile(r"^(#[0-9a-fA-F]{6}|var\(--[a-z0-9-]{1,24}\))$")
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
KINDS = ("letters", "icon", "logo")
PLATES = ("auto", "light", "dark")
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


def _put_logo(d: dict, data: bytes) -> str:
    if not data or len(data) > LOGO_MAX:
        raise ValueError(f"a logo must be under {LOGO_MAX // 1024} KB")
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
        plate = m.get("plate") or "auto"
        if plate not in PLATES:
            raise ValueError("a plate is auto, light or dark")
        if plate != "auto":
            out["plate"] = plate
    if out == {"kind": "letters"}:
        return None
    return out


def set_mark(rel: str, mark, logo_data: "str | None" = None) -> "dict | None":
    """Your mark for a project: it never follows Rivendell again until you ask.
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
        project_config.set_mark(rel, out)
        _gc(d)
        _save(d)
    return out


# --- Rivendell ---------------------------------------------------------------

_seen: dict = {"at": 0.0, "matches": {}, "errors": [], "listed": 0, "asked": False, "answered": False}


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


def match(projects: list, local: dict) -> dict:
    """rel -> the Rivendell project whose client has a mark for that repo. Pure.
    The first project to name a repo wins, and a repo found under several of its
    own remotes takes the alphabetically first."""
    by_slug: dict = {}
    for p in projects:
        c = p.get("client") or {}
        if not (c.get("logoUrl") or _hex(c.get("brandColor"))):
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
    with _lock:
        # asked: some Rivendell is connected at all. answered: one listed projects.
        _seen.update(at=time.time(), matches=match(projects, local), errors=errors,
                     listed=len(local), asked=bool(projects) or bool(errors),
                     answered=bool(projects))
        return _seen


def _download(url) -> "bytes | None":
    """A client logo off its signed URL. Over https, or plain http to a local
    Rivendell; only an image, and only under the cap."""
    u = urllib.parse.urlparse(url if isinstance(url, str) else "")
    if u.scheme != "https" and not (u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")):
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mystical-bridge"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read(LOGO_MAX + 1)
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return data if len(data) <= LOGO_MAX and sniff(data) else None


def _known(marks: dict, logos: dict) -> dict:
    """client logoId -> the stored logo already wearing it: one client's eight
    repos share one download, and a refresh downloads only what changed."""
    return {(m.get("rv") or {}).get("logo_id"): m["logo"] for m in marks.values()
            if m.get("source") == "rivendell" and (m.get("rv") or {}).get("logo_id")
            and m.get("logo") in logos}


def _fetch_logos(matches: dict, known: dict) -> dict:
    """client logoId -> bytes for every logo the store doesn't hold yet. This is
    the network part of an import, done before the lock is taken."""
    out: dict = {}
    for p in matches.values():
        c = p.get("client") or {}
        lid = c.get("logoId")
        if lid and lid not in known and lid not in out and c.get("logoUrl"):
            data = _download(c["logoUrl"])
            if data is not None:
                out[lid] = data
    return out


def _follow(rel: str, p: dict, d: dict, known: dict, fetched: dict) -> dict:
    """The mark a matched repo wears while it follows Rivendell. A logo that
    couldn't be fetched leaves logo_id unset, so the next refresh tries again."""
    c = p.get("client") or {}
    cur = project_config.mark(rel) or {}
    lid = c.get("logoId")
    name = None
    if lid and known.get(lid) in (d.get("logos") or {}):
        name = known[lid]
    elif lid and lid in fetched:
        name = known[lid] = _put_logo(d, fetched[lid])
    mark: dict = {"kind": "logo" if name else "letters", "source": "rivendell",
                  "rv": {"instance": p.get("instance_id"), "client": c.get("id"),
                         "name": c.get("name"), "logo_id": lid if name else None}}
    if name:
        mark["logo"] = name
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


def undo() -> dict:
    """Put back every mark the last import replaced, and stop following. Those
    repos count as seen, so the offer doesn't come straight back."""
    with _lock:
        d = _load()
        rv = d.setdefault("rivendell", {})
        snap = rv.get("undo")
        if not isinstance(snap, dict):
            return {"undone": 0}
        for rel, m in snap.items():
            project_config.set_mark(rel, m if isinstance(m, dict) else None)
        rv.update(sync=False, undo=None, dismissed=sorted(snap))
        _gc(d)
        _save(d)
    return {"undone": len(snap)}


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
        c = seen["matches"][rel].get("client") or {}
        e = clients.setdefault(c.get("id"), {"name": c.get("name") or "?", "repos": 0,
                                             "logo": c.get("logoUrl"), "color": _hex(c.get("brandColor"))})
        e["repos"] += 1
    ranked = sorted(clients.values(), key=lambda e: (-e["repos"], e["name"].lower()))
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
        "matches": {r: {"client": (p.get("client") or {}).get("name"),
                        "logo": bool((p.get("client") or {}).get("logoUrl")),
                        "color": _hex((p.get("client") or {}).get("brandColor"))}
                    for r, p in seen["matches"].items()},
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
