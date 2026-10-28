"""Workspaces: the left sidebar split into sets of projects, Zen-browser style.

A workspace is a name, an optional picture, and the projects assigned to it.
The sidebar shows one workspace at a time, across all four of its tabs: a
project assigned to one workspace lists nowhere else, and DEFAULT takes every
project nobody assigned. With no workspace added, nothing changes.

What's stored here is the *sets*, in workspaces.json beside the DB, so every
browser, the installed app and Mystical.app agree on what Personal holds. Which
workspace a window is *on* is that window's (lib/workspaces.ts): two windows
can look at two workspaces, the way two Zen windows can.

Only the dashboard's sidebar reads this. The Telegram bot, the Mini App and
the rest of the dashboard (⌘K, NEXT UP, the transcript) list every
project as before.

The unit assigned is the sidebar's group key — a project rel, or a group the
sidebar makes itself (Rivendell jobs, Shared) — so a group moves like any
project. Keys are kept as given: a project that's gone keeps its assignment,
harmlessly, and finds it again if it comes back.

Pictures sit in the same file as base64 keyed by their hash, like project logos
(bridge/projectmarks.py, which explains why one JSON file and not a folder:
MOVE carries bridge state as JSON files). The dashboard shrinks a picture to a
tile before upload; one over IMAGE_MAX is refused. A picture no workspace wears
is dropped on the next save.

DEFAULT is always first, can be renamed and given a picture, and can't be
deleted: it is where unassigned projects go, so there must be one. Deleting
another workspace sends its projects back to DEFAULT.
"""

import base64
import hashlib
import json
import os
import re
import threading

from bridge import config, projectmarks

_lock = threading.RLock()
_PATH = os.path.join(os.path.dirname(config.BRIDGE_DB), "workspaces.json")

DEFAULT = "default"
IMAGE_MAX = 512 * 1024
NAME_MAX = 40
_ID_RE = re.compile(r"^(default|w-[a-z0-9]{4,24})$")
_IMAGE_RE = re.compile(r"^[0-9a-f]{64}\.(png|jpg|webp|svg)$")
_KEY_MAX = 512


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


def _default() -> dict:
    return {"id": DEFAULT, "name": "Default", "image": None}


def _shown(d: dict) -> dict:
    """The listing: DEFAULT first whatever the file says, then the rest in order."""
    ws = [w for w in d.get("workspaces") or [] if isinstance(w, dict) and _ID_RE.match(str(w.get("id")))]
    first = next((w for w in ws if w["id"] == DEFAULT), _default())
    rest = [w for w in ws if w["id"] != DEFAULT]
    out = [{"id": w["id"], "name": str(w.get("name") or ""), "image": w.get("image") or None}
           for w in [first, *rest]]
    ids = {w["id"] for w in out}
    assign = {k: v for k, v in (d.get("assign") or {}).items()
              if isinstance(k, str) and v in ids and v != DEFAULT}
    return {"workspaces": out, "assign": assign}


def listing() -> dict:
    """{workspaces: [{id, name, image}], assign: {group key: workspace id}}."""
    with _lock:
        return _shown(_load())


def image(name: str) -> "tuple[bytes, str] | None":
    if not _IMAGE_RE.match(name or ""):
        return None
    with _lock:
        b64 = (_load().get("images") or {}).get(name)
    if not b64:
        return None
    return base64.b64decode(b64), projectmarks.CTYPES[name.rsplit(".", 1)[1]]


def _put_image(d: dict, b64: str) -> str:
    try:
        data = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError):
        raise ValueError("the picture isn't base64") from None
    if not data or len(data) > IMAGE_MAX:
        raise ValueError(f"a picture must be under {IMAGE_MAX // 1024} KB")
    ext = projectmarks.sniff(data)
    if ext is None:
        raise ValueError("a picture must be a PNG, JPEG, WEBP or SVG image")
    name = f"{hashlib.sha256(data).hexdigest()}.{ext}"
    d.setdefault("images", {})[name] = base64.b64encode(data).decode()
    return name


def save(workspaces, assign, images=None) -> dict:
    """Replace the whole set: the settings tab edits it as one form.

    `workspaces`: [{id, name, image}] in order. `image` is a stored picture's
    name to keep, or None to drop it. `images`: {workspace id: base64} for
    pictures picked in this edit, which win over `image`. `assign`: {group key:
    workspace id}; DEFAULT or an unknown id unassigns. Raises ValueError with a
    line worth showing."""
    if not isinstance(workspaces, list):
        raise ValueError("workspaces must be a list")
    if not isinstance(assign, dict):
        raise ValueError("assign must be an object")
    images = images if isinstance(images, dict) else {}
    with _lock:
        d = _load()
        stored = d.get("images") or {}
        out, seen = [], set()
        for w in workspaces:
            if not isinstance(w, dict):
                raise ValueError("a workspace must be an object")
            wid = str(w.get("id") or "")
            if not _ID_RE.match(wid):
                raise ValueError(f"bad workspace id {wid!r}")
            if wid in seen:
                raise ValueError(f"workspace {wid} twice")
            seen.add(wid)
            name = " ".join(str(w.get("name") or "").split())[:NAME_MAX]
            if not name:
                raise ValueError("every workspace needs a name")
            pic = w.get("image") or None
            if pic is not None and not (isinstance(pic, str) and pic in stored):
                raise ValueError("that picture isn't stored")
            if images.get(wid):
                pic = _put_image(d, str(images[wid]))
            out.append({"id": wid, "name": name, "image": pic})
        if DEFAULT not in seen:
            out.insert(0, _default())
        ids = {w["id"] for w in out}
        kept = {}
        for k, v in assign.items():
            if not isinstance(k, str) or not k or len(k) > _KEY_MAX:
                raise ValueError("a project key must be a short string")
            if v in ids and v != DEFAULT:
                kept[k] = v
        d["workspaces"], d["assign"] = out, kept
        worn = {w["image"] for w in out if w["image"]}
        d["images"] = {n: b for n, b in (d.get("images") or {}).items() if n in worn}
        _save(d)
        return _shown(d)
