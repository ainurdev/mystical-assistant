"""Files an agent names in the chat: which ones are real, and opening them.

An agent writes `src/App.tsx:12`, `~/shots/after.png` or a bare `handler.ts`, in code spans and
in plain prose. The client finds what looks like a path and asks here (POST chat/file-refs) what
it means. Only a yes becomes a link, so a guess costs a wrong word nothing: `Node.js` and
`and/or` stay words because there's no such file, and that's why the client's scan can be loose.

A path is tried against the session's folder, then the project's main checkout, then, if it
isn't whole, against the project's file list by its tail. Two files with that tail come back
`ambiguous`, for the dashboard's existing picker. The same fence as chat_images: absolute paths
only inside BASE_PATH, UPLOAD_DIR or the project, with links followed first, so a message can't
reach ~/.ssh.

Opening is your press, on your desktop, with the OS's own command. That command runs programs
as readily as it shows documents, and the word you pressed was written by a model that may have
read a hostile page. So open_file refuses what would run: anything with the execute bit, and
the extensions a desktop treats as programs. Those still open in the editor.

The opener goes in a systemd scope of its own where there is one. Otherwise the app it starts
joins the bridge's cgroup and dies with the bridge's next restart (KillMode=mixed), taking your
unsaved work along. Stdlib only.
"""

import mimetypes
import os
import platform
import re
import shutil
import subprocess
import threading
import time

from bridge import chat_images, config

MAX_REFS = 200
_RUNS = {"app", "appimage", "bat", "bash", "cmd", "com", "command", "csh", "deb", "desktop", "dmg", "exe", "fish",
         "hta", "jar", "lnk", "msc", "msi", "pif", "pkg", "ps1", "reg", "rpm", "run", "scf", "scpt", "scr", "sh",
         "tool", "url", "vb", "vbe", "vbs", "workflow", "ws", "wsf", "wsh", "zsh"}
# Windows hands these to a script host or an interpreter instead of an editor.
_RUNS_ON_WINDOWS = {"js", "jse", "py", "pyw", "pl", "rb", "php"}
_LINE = re.compile(r":\d+(?::\d+)?$")
_tracked: dict = {}
_lock = threading.Lock()


def _tracked_files(root: str) -> list:
    """The project's files, tracked or not, without what's ignored. A few seconds old is fine."""
    with _lock:
        hit = _tracked.get(root)
        if hit and hit[0] > time.time():
            return hit[1]
    try:
        p = subprocess.run(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
                           capture_output=True, text=True, timeout=5)
        files = p.stdout.splitlines() if p.returncode == 0 else []
    except (OSError, subprocess.SubprocessError):
        files = []
    with _lock:
        _tracked[root] = (time.time() + 60, files)
    return files


def _within(real: str, bases: list) -> bool:
    return any(real == b or real.startswith(b.rstrip(os.sep) + os.sep) for b in bases)


def _kind(real: str) -> str:
    if os.path.isdir(real):
        return "dir"
    return "image" if (mimetypes.guess_type(real)[0] or "") in chat_images.SERVABLE else "file"


def resolve(address: str, cwd: "str | None") -> "dict | None":
    """{path, rel, kind, line} for an address in a message, or None when it isn't a file we can
    reach. kind is image, file, dir or ambiguous."""
    raw = str(address or "").strip()
    if not raw or "\0" in raw or len(raw) > 1000 or re.match(r"^[a-z][a-z0-9+.-]*://", raw, re.I):
        return None
    root = chat_images.root_of(cwd)
    line = _LINE.search(raw)
    path = raw[:line.start()] if line else raw
    found = {"line": int(line.group()[1:].split(":")[0])} if line else {}
    bases = [os.path.realpath(config.BASE_PATH), os.path.realpath(config.UPLOAD_DIR)]
    folders = [os.path.realpath(p) for p in (cwd, root) if p]
    bases += folders
    if path.startswith("~"):
        path = os.path.expanduser(path)
        if path.startswith("~"):
            return None
    tries = [path] if os.path.isabs(path) else [os.path.join(f, path) for f in folders]
    for t in tries:
        real = os.path.realpath(t)
        if os.path.exists(real) and _within(real, bases):
            return {**found, "path": real, "rel": os.path.relpath(real, root) if root else real, "kind": _kind(real)}
    if os.path.isabs(path) or not root:
        return None
    tail = "/" + path.lstrip("./")
    hits = [f for f in _tracked_files(root) if f.endswith(tail)]
    if len(hits) > 1:
        return {**found, "path": None, "rel": path, "kind": "ambiguous"}
    if hits:
        real = os.path.realpath(os.path.join(root, hits[0]))
        if os.path.exists(real) and _within(real, bases):
            return {**found, "path": real, "rel": hits[0], "kind": _kind(real)}
    return None


def refs(body: dict, s: dict) -> "tuple[dict, int]":
    """POST chat/file-refs: what each address means. Ones that mean nothing are left out."""
    addresses = body.get("addresses")
    if not isinstance(addresses, list):
        return {"error": "addresses must be a list"}, 400
    cwd = s.get("cwd")
    out = {}
    for a in addresses[:MAX_REFS]:
        got = resolve(a, cwd) if isinstance(a, str) else None
        if got:
            out[a] = got
    return {"refs": out}, 200


def _is_wsl() -> bool:
    return "microsoft" in platform.uname().release.lower()


def _would_run(real: str) -> bool:
    """Would the OS run this rather than show it? A folder only if it's an app bundle."""
    ext = os.path.splitext(real)[1].lstrip(".").lower()
    if ext in _RUNS or (_is_wsl() and ext in _RUNS_ON_WINDOWS):
        return True
    return os.path.isfile(real) and os.access(real, os.X_OK)


def _command(real: str) -> "list | None":
    if platform.system() == "Darwin":
        return ["open", real]
    if _is_wsl():
        if shutil.which("wslview"):
            return ["wslview", real]
        try:
            win = subprocess.run(["wslpath", "-w", real], capture_output=True, text=True, timeout=5).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
        return ["explorer.exe", win] if win else None
    return ["xdg-open", real] if shutil.which("xdg-open") else None


def _desktop_env() -> dict:
    """The bridge may have started before the desktop did, without its display in the environment."""
    env = dict(os.environ)
    if platform.system() != "Linux" or env.get("DISPLAY") or env.get("WAYLAND_DISPLAY"):
        return env
    try:
        out = subprocess.run(["systemctl", "--user", "show-environment"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return env
    for row in out.splitlines():
        k, _, v = row.partition("=")
        if k in ("DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"):
            env.setdefault(k, v)
    return env


def _scoped(cmd: list) -> list:
    if platform.system() == "Linux" and shutil.which("systemd-run"):
        return ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--", *cmd]
    return cmd


def _spawn(cmd: list) -> "str | None":
    """Start it, and wait briefly to hear if it failed. An opener that's still going is fine."""
    try:
        p = subprocess.Popen(_scoped(cmd), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, env=_desktop_env(), start_new_session=True)
    except OSError as e:
        return f"Couldn't start {cmd[0]}: {e}"
    try:
        code = p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return None
    # explorer.exe answers 1 when it worked.
    return f"{cmd[0]} couldn't open it (exit {code})." if code and cmd[0] != "explorer.exe" else None


def open_file(body: dict, s: dict) -> "tuple[dict, int]":
    """POST chat/open-file: open it with what this computer opens such files with."""
    got = resolve(str(body.get("address") or ""), s.get("cwd"))
    if not got or not got.get("path"):
        return {"error": "That file isn't there, or it could be more than one file."}, 404
    real = got["path"]
    if _would_run(real):
        return {"error": "That's a program, so opening it would run it. View it in the editor instead."}, 400
    cmd = _command(real)
    if not cmd:
        return {"error": "This computer has no command for opening files."}, 500
    err = _spawn(cmd)
    return ({"error": err}, 500) if err else ({"ok": True, "path": real}, 200)
