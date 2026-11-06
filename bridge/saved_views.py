"""Views you kept: a sheet, chart, board or diagram saved out of a chat, and sending one to Telegram.

A view on a turn scrolls away with its chat. Saved, it's a JSON file in the project's
.mystical/views/, which never reaches git and goes when the project goes, and the project's
Saved views page lists them. It's the event as it was drawn, so it stays what it said on the day:
a snapshot, with its date. The folder is plain files so that you, or an agent, can read one.

Sending covers Export on the phone (a Telegram webview drops downloads without a word) and Share
everywhere: the client makes the PNG or spreadsheet, as only it has the theme's fonts and colours.
It goes to you, the bot's owner, and nowhere else. Stdlib only.
"""

import base64
import binascii
import json
import os
import re
import tempfile
import time

from bridge import config, data_views, devserver, telegram

DIR = os.path.join(".mystical", "views")
MAX_SAVED = 300
MAX_SEND = 20 * 1024 * 1024


def _folder(root: str) -> str:
    devserver.mystical_dir(root)      # makes .mystical and its self-ignoring .gitignore
    d = os.path.join(root, DIR)
    os.makedirs(d, exist_ok=True)
    return d


def save(root: "str | None", view) -> "tuple[dict, int]":
    """POST chat/view-save"""
    if not root:
        return {"error": "This chat has no project folder to keep it in."}, 400
    if not isinstance(view, dict) or view.get("type") != "data" or view.get("view") not in data_views.VIEWS:
        return {"error": "That isn't a view."}, 400
    raw = json.dumps(view, ensure_ascii=False)
    if len(raw) > data_views.MAX_BYTES * 2:
        return {"error": "That view is too big to keep."}, 400
    d = _folder(root)
    if len(os.listdir(d)) >= MAX_SAVED:
        return {"error": f"This project already keeps {MAX_SAVED} views. Remove some first."}, 400
    slug = re.sub(r"[^a-z0-9]+", "-", str(view.get("title") or "view").lower()).strip("-")[:50] or "view"
    vid = f"{time.strftime('%Y-%m-%d_%H-%M-%S')}-{slug}"
    tmp = os.path.join(d, f".{vid}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(raw)
    os.replace(tmp, os.path.join(d, f"{vid}.json"))
    return {"ok": True, "id": vid}, 200


def listed(root: "str | None") -> "tuple[dict, int]":
    """GET saved-views: newest first. A file that isn't a view is left alone and left out."""
    views = []
    d = os.path.join(root, DIR) if root else ""
    try:
        names = sorted((n for n in os.listdir(d) if n.endswith(".json")), reverse=True) if d else []
    except OSError:
        names = []
    for name in names:
        try:
            with open(os.path.join(d, name), encoding="utf-8") as f:
                ev = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(ev, dict) and ev.get("view") in data_views.VIEWS:
            views.append({"id": name[:-5], "view": ev})
    return {"views": views}, 200


def delete(root: "str | None", vid) -> "tuple[dict, int]":
    """POST saved-views/delete"""
    if not root or not isinstance(vid, str) or not re.fullmatch(r"[\w.-]+", vid) or vid.startswith("."):
        return {"error": "No such view."}, 404
    try:
        os.remove(os.path.join(root, DIR, f"{vid}.json"))
    except OSError:
        return {"error": "No such view."}, 404
    return {"ok": True}, 200


def _owner(chat_id: int) -> int:
    """This chat when it's a private one, else the owner's: a group isn't where your finances go."""
    return chat_id if chat_id > 0 else config.DASH_CHAT_ID


def send(body: dict, chat_id: int) -> "tuple[dict, int]":
    """POST saved-views/send: {name, data (base64), caption}"""
    name = re.sub(r"[^\w. -]+", "-", str(body.get("name") or "view"))[:100] or "view"
    try:
        raw = base64.b64decode(str(body.get("data") or ""), validate=True)
    except (binascii.Error, ValueError):
        return {"error": "That file didn't arrive whole."}, 400
    if not raw or len(raw) > MAX_SEND:
        return {"error": "That file is empty or too big for Telegram."}, 400
    to = _owner(chat_id)
    if not to:
        return {"error": "There's no Telegram chat to send it to."}, 400
    with tempfile.NamedTemporaryFile(prefix="mystical-view-", delete=False) as f:
        f.write(raw)
        path = f.name
    try:
        ok = telegram.send_document(to, path, name, str(body.get("caption") or ""))
    finally:
        os.unlink(path)
    return ({"ok": True}, 200) if ok else ({"error": "Telegram didn't take it."}, 502)
