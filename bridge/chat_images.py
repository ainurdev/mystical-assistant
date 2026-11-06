"""Images that live in the conversation: saved in the project and written into the text.

An attachment goes to UPLOAD_DIR/<turn id>/, is listed beside the prompt and is pruned
after a week, so an old chat loses its pictures. With this mode on (SYSTEM ▸ Send
images: In the chat; off by default) a pasted image is saved at once as
.mystical/images/2026-11-06_21-45-12.png and `![image](.mystical/images/…png)` goes in
the text at the caret. The composer draws it as the image, your message shows it where
you put it, and it stays as long as the project does. .mystical ignores itself, so it
never reaches git. Files that aren't images stay attachments.

The path in the text is relative to the project: the same text reads on any surface,
survives a checkout moving, and is short. An agent may be working elsewhere (a helper's
worktree has its own, empty .mystical), so note() names the absolute paths to it when the
turn starts, and that note isn't part of the transcript.

Always the main checkout, never a worktree: removing a worktree would take its images
along, and the chat that shows them outlives it.

The file route serves images and nothing else, inside BASE_PATH, or UPLOAD_DIR for the
pictures tools hand back. An SVG can carry script and is not served. Remote images are for
the client to decide: it draws one only where a person typed it, so an agent's answer can't
call a tracking pixel from your browser. Stdlib only.
"""

import base64
import binascii
import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time

from bridge import config

MODES = ("attachment", "inline")
SERVABLE = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp")
_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif",
        "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp"}
DIR = os.path.join(".mystical", "images")
# ![alt](path), with an optional "title". A path with spaces has to be in <...>.
EMBED = re.compile(r'!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)')
_CODE = re.compile(r"```.*?(?:```|$)|`[^`\n]*`", re.S)
_lock = threading.Lock()


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "chat_images.json")


def mode() -> str:
    try:
        with open(_path(), encoding="utf-8") as f:
            m = json.load(f).get("mode")
    except (OSError, ValueError, AttributeError):
        return "attachment"
    return m if m in MODES else "attachment"


def set_mode(value: str) -> str:
    if value not in MODES:
        raise ValueError("mode must be attachment or inline")
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"mode": value}, f)
    os.replace(tmp, _path())
    return value


def root_of(cwd: "str | None") -> "str | None":
    """The project's main checkout, for a folder or any worktree of it. A folder that
    isn't in a repo is its own root."""
    if not cwd or not os.path.isdir(cwd):
        return None
    try:
        p = subprocess.run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return os.path.realpath(cwd)
    if p.returncode != 0 or not p.stdout.strip():
        return os.path.realpath(cwd)
    return os.path.dirname(os.path.realpath(p.stdout.strip()))


def _images_dir(root: str) -> str:
    # devserver.mystical_dir makes .mystical and its self-ignoring .gitignore.
    from bridge import devserver
    devserver.mystical_dir(root)
    d = os.path.join(root, DIR)
    os.makedirs(d, exist_ok=True)
    return d


def _new_path(d: str, ext: str) -> str:
    """A timestamped name nothing holds yet: O_EXCL, so two at once can't collide."""
    stamp = time.strftime("%Y-%m-%d_%H-%M-%S")
    for n in range(1, 1000):
        name = f"{stamp}.{ext}" if n == 1 else f"{stamp}-{n}.{ext}"
        path = os.path.join(d, name)
        try:
            os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
            return path
        except FileExistsError:
            continue
    raise OSError("too many images in one second")


def save_data_url(data_url: str, root: str) -> str:
    """Save a pasted image. Returns its path relative to the project. ValueError with a
    sentence when it isn't an image or is too big."""
    if not isinstance(data_url, str) or "," not in data_url or not data_url.startswith("data:"):
        raise ValueError("That isn't an image.")
    header, _, b64 = data_url.partition(",")
    mime = header[5:].split(";")[0].lower()
    ext = _EXT.get(mime)
    if not ext:
        raise ValueError(f"{mime or 'That file'} can't go in the chat. It can still be attached.")
    try:
        raw = base64.b64decode(b64)
    except (binascii.Error, ValueError):
        raise ValueError("That image didn't arrive whole.") from None
    if len(raw) > config.UPLOAD_MAX_MB * 1024 * 1024:
        raise ValueError(f"That image is over {config.UPLOAD_MAX_MB} MB.")
    path = _new_path(_images_dir(root), ext)
    with open(path, "wb") as f:
        f.write(raw)
    return os.path.relpath(path, root)


def adopt_file(src: str, root: str) -> "str | None":
    """Move a file already on disk (a Telegram photo) in. None when it isn't an image."""
    ext = _EXT.get(mimetypes.guess_type(src)[0] or "")
    if not ext:
        return None
    path = _new_path(_images_dir(root), ext)
    shutil.move(src, path)
    return os.path.relpath(path, root)


def markdown(rel: str) -> str:
    return f"![image]({rel})"


def _clean(raw: str) -> str:
    raw = raw.strip()
    return raw[1:-1] if raw.startswith("<") and raw.endswith(">") else raw


def _within(path: str, base: str) -> bool:
    return path == base or path.startswith(base + os.sep)


def resolve(path: "str | None", root: "str | None") -> "str | None":
    """The real file for an address in a message, or None. Relative to the project;
    absolute only inside BASE_PATH or UPLOAD_DIR. Links are followed before the check,
    so one can't lead out."""
    path = _clean(path or "")
    if not path or "\0" in path or re.match(r"^[a-z][a-z0-9+.-]*:", path, re.I):
        return None
    if path.startswith("~"):
        return None
    if not os.path.isabs(path):
        if not root:
            return None
        path = os.path.join(root, path)
    real = os.path.realpath(path)
    allowed = [os.path.realpath(config.BASE_PATH), os.path.realpath(config.UPLOAD_DIR)]
    if root:
        allowed.append(os.path.realpath(root))
    if not any(_within(real, b) for b in allowed) or not os.path.isfile(real):
        return None
    return real if (mimetypes.guess_type(real)[0] or "") in SERVABLE else None


def embeds(text: "str | None") -> list:
    """The local addresses embedded in a message."""
    out = []
    # What's quoted as code isn't an image in the message.
    prose = _CODE.sub("", text or "")
    for m in EMBED.finditer(prose):
        raw = _clean(m.group(2))
        if not re.match(r"^https?:", raw, re.I):
            out.append(raw)
    return out


def note(prompt: "str | None", cwd: "str | None") -> str:
    """What the agent is told on top of the text: where those images really are."""
    addresses = embeds(prompt)
    if not addresses:
        return ""
    root = root_of(cwd)
    real = [p for p in (resolve(a, root) for a in addresses) if p]
    if not real:
        return ""
    return ("The user put image(s) in this message; open them before responding: "
            + ", ".join(real) + "\n\n")


def adopt_files(paths: list, prompt: str, cwd: "str | None") -> "tuple[list, str]":
    """In inline mode, images from a surface that hands over files (the bot) go in the
    text like pasted ones. Returns (what stays attached, the prompt)."""
    if mode() != "inline":
        return paths, prompt
    root = root_of(cwd)
    if not root:
        return paths, prompt
    keep, lines = [], []
    for p in paths or []:
        try:
            rel = adopt_file(p, root)
        except OSError:
            rel = None
        if rel:
            lines.append(markdown(rel))
        else:
            keep.append(p)
    return keep, "\n".join(lines + ([prompt] if prompt else []))


def upload(body: dict, root: "str | None") -> "tuple[dict, int]":
    """POST chat-images/upload."""
    if not root:
        return {"error": "This chat has no project folder to keep the image in."}, 400
    try:
        with _lock:
            rel = save_data_url(body.get("data"), root)
    except ValueError as e:
        return {"error": str(e)}, 400
    except OSError as e:
        return {"error": f"Couldn't save it: {e}"}, 500
    return {"path": rel, "markdown": markdown(rel)}, 200
