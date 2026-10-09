"""Files sent to the bot: saved where the Mini App's attachments go, then handed
to Claude the same way.

The bot read only `text`, so a document or a photo got "Send a text prompt" and
was gone for good: Telegram never delivers an update twice, and a bot can't read
chat history. Now the file is downloaded into the upload dir, and the run moves
it into UPLOAD_DIR/<turn id>/ (runner.adopt_uploads), the folder the Mini App's
_save_images writes. So the turn's attachment chip and the dashboard's
/local/attachment serve it unchanged, and runner._with_images points the model
at it.

A caption is the prompt, and the run starts at once. A file with no caption is
held for the chat's next message instead of starting a run of its own: Telegram
sends a photo and the words typed after it as two updates, and a run started on
the first would answer the second with "still working".

Size is decided before downloading, from the size the update carries. Telegram
serves a bot 20 MB at most (getFile), and UPLOAD_MAX_MB, the Mini App's per-file
cap, applies here too. Both refusals say what to do instead.

ponytail: held files live in memory, so a restart forgets which chat they were
waiting for. The files stay in the upload dir and age out with the rest
(runner._prune_uploads). An album sends each photo as its own update, with the
caption on one of them; the run starts with what has arrived by then, and any
later photo waits for the next message.
"""

import os
import re
import threading
import time
from urllib.request import Request, urlopen

from bridge import config
from bridge.telegram import tg

BOT_MAX = 20 * 1024 * 1024        # what getFile serves a bot on the public Bot API
HOLD_SECS = 30 * 60               # a held file older than this is forgotten
_KINDS = ("document", "video", "audio", "voice", "video_note", "animation")
_EXT = {"video/mp4": ".mp4", "video/quicktime": ".mov", "audio/mpeg": ".mp3",
        "audio/ogg": ".ogg", "audio/mp4": ".m4a", "image/jpeg": ".jpg", "image/png": ".png",
        "image/gif": ".gif"}

_held: "dict[int, list[tuple[float, str]]]" = {}
_lock = threading.Lock()


def incoming(msg: dict) -> "dict | None":
    """The file a message carries, as {file_id, name, size}, or None."""
    mid = msg.get("message_id") or int(time.time())
    photos = msg.get("photo")
    if isinstance(photos, list) and photos:
        # Telegram sends one photo at several sizes; keep the largest.
        best = max(photos, key=lambda p: (p.get("file_size") or 0,
                                          (p.get("width") or 0) * (p.get("height") or 0)))
        if best.get("file_id"):
            return {"file_id": best["file_id"], "name": f"photo-{mid}.jpg",
                    "size": best.get("file_size") or 0}
    for kind in _KINDS:
        f = msg.get(kind)
        if isinstance(f, dict) and f.get("file_id"):
            name = f.get("file_name") or f"{kind}-{mid}{_EXT.get(f.get('mime_type') or '', '')}"
            return {"file_id": f["file_id"], "name": name, "size": f.get("file_size") or 0}
    return None


def _cap() -> int:
    return min(BOT_MAX, config.UPLOAD_MAX_MB * 1024 * 1024)


def too_big(info: dict) -> "str | None":
    """Why this file can't come in, as a line for the chat, or None."""
    size = info.get("size") or 0
    if size <= _cap():
        return None
    mb = size / 1024 / 1024
    if size > BOT_MAX:
        return (f"📎 {info['name']} is {mb:.0f} MB. Telegram lets a bot download 20 MB at "
                "most, so it can't reach this machine this way. Put it on the machine "
                "another way (the Telegram app there, AirDrop, a cloud drive) and send me "
                "its path.")
    return (f"📎 {info['name']} is {mb:.0f} MB, over the {config.UPLOAD_MAX_MB} MB attachment "
            "limit (dashboard ▸ SYSTEM ▸ UPLOADS ▸ MAX SIZE).")


def _safe(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(name or "")).strip("._")[:80]
    return base or "file"


def save(info: dict) -> str:
    """Download the file into a folder of its own under UPLOAD_DIR. Raises
    ValueError carrying a line for the chat when it can't."""
    why = too_big(info)
    if why:
        raise ValueError(why)
    meta = tg("getFile", file_id=info["file_id"]) or {}
    remote = meta.get("file_path")
    if not remote:
        raise ValueError(f"📎 Telegram wouldn't hand over {info['name']}. Try sending it again.")
    d = os.path.join(config.UPLOAD_DIR, f"tg-{int(time.time() * 1000)}")
    os.makedirs(d, exist_ok=True)
    dest = os.path.join(d, _safe(info["name"]))
    url = config.API.replace("/bot", "/file/bot", 1) + "/" + remote
    got = 0
    try:
        with urlopen(Request(url), timeout=120) as r, open(dest, "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                got += len(chunk)
                if got > _cap():                 # the update undersold its size
                    raise ValueError(too_big(dict(info, size=got)) or "📎 Too big.")
                f.write(chunk)
    except ValueError:
        _discard(dest)
        raise
    except OSError as e:
        _discard(dest)
        raise ValueError(f"📎 Couldn't download {info['name']}: {e}") from None
    return dest


def _discard(path: str) -> None:
    try:
        os.remove(path)
        os.rmdir(os.path.dirname(path))
    except OSError:
        pass


def hold(chat_id: int, path: str) -> int:
    """Keep a caption-less file for the chat's next message. Returns how many
    are waiting now, capped at UPLOAD_MAX_COUNT (the oldest goes first)."""
    now = time.time()
    with _lock:
        waiting = [(t, p) for t, p in _held.get(chat_id, []) if now - t < HOLD_SECS]
        waiting.append((now, path))
        _held[chat_id] = waiting[-config.UPLOAD_MAX_COUNT:]
        return len(_held[chat_id])


def take(chat_id: int) -> "list[str]":
    """The files waiting for this chat's next message, now handed over."""
    now = time.time()
    with _lock:
        waiting = _held.pop(chat_id, [])
    return [p for t, p in waiting if now - t < HOLD_SECS and os.path.isfile(p)]
