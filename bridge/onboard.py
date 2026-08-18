#!/usr/bin/env python3
"""Onboarding helpers for setup.sh — stdlib only."""
import json
import os
import sys
import termios
import time
import tty
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# site/public/mystical.svg rendered 512x512 (Telegram wants a square JPG and
# crops it to a circle; the orb fits inside with room to spare).
AVATAR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bot-avatar.jpg")


def poll_chat_id(token, *, get_updates, attempts=60, sleep=2, sleep_fn=time.sleep):
    """Poll Telegram getUpdates until a message arrives; return its chat id (int),
    or None if none arrives within `attempts` tries. `get_updates(token)` returns
    the parsed Telegram response dict (injectable for tests)."""
    for i in range(attempts):
        data = get_updates(token) or {}
        for upd in data.get("result", []):
            msg = upd.get("message") or upd.get("edited_message")
            if msg and isinstance(msg.get("chat"), dict) and "id" in msg["chat"]:
                return int(msg["chat"]["id"])
        if i < attempts - 1:
            sleep_fn(sleep)
    return None


def set_env(path, key, value):
    """Idempotently set key="value" in a .env file (update in place or append)."""
    lines = []
    if os.path.exists(path):
        with open(path) as f:
            lines = f.read().splitlines()
    out, found = [], False
    for ln in lines:
        if ln.startswith(f"{key}=") or ln.startswith(f"export {key}="):
            out.append(f'{key}="{value}"')
            found = True
        else:
            out.append(ln)
    if not found:
        out.append(f'{key}="{value}"')
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")


# --- directory picker --------------------------------------------------------
# setup.sh captures this command's stdout, so the whole UI is written to /dev/tty
# and only the chosen path goes to stdout. That split is the entire reason this
# is hand-rolled ANSI rather than curses, which draws on stdout.

def _dirs(path, cap=200):
    """Subdirectories of `path` as (name, label) pairs, sorted, hidden ones
    dropped. The label says whether the entry is a git repo or how many it
    contains — that count is what makes this a projects-folder picker rather
    than a file browser."""
    try:
        kids = sorted((e for e in os.scandir(path)
                       if e.is_dir(follow_symlinks=False) and not e.name.startswith(".")),
                      key=lambda e: e.name.lower())
    except OSError:
        return []
    out = []
    # ponytail: one level down and a flat cap. A projects root holds repos, not a
    # filesystem; deepening this would walk node_modules on every keypress.
    for e in kids[:cap]:
        if os.path.isdir(os.path.join(e.path, ".git")):
            out.append((e.name, "repo"))
            continue
        try:
            n = sum(1 for k in os.scandir(e.path)
                    if k.is_dir(follow_symlinks=False)
                    and os.path.isdir(os.path.join(k.path, ".git")))
        except OSError:
            n = 0
        out.append((e.name, f"{n} repo{'s' * (n > 1)}" if n else ""))
    return out


def _key(fh):
    """One keypress, with arrow escape sequences folded into single names."""
    c = fh.read(1)
    if c == b"\x1b":
        seq = fh.read(2)
        return {b"[A": "up", b"[B": "down", b"[C": "right", b"[D": "left"}.get(seq, "esc")
    return {b"\r": "enter", b"\n": "enter", b"k": "up", b"j": "down",
            b"l": "right", b"h": "left", b"q": "esc", b"\x03": "esc"}.get(c, "")


def pick_dir(start, rows=12):
    """Arrow-key directory browser. Returns the chosen path, or None if the user
    cancelled or there is no terminal to draw on."""
    try:
        fin = open("/dev/tty", "rb", buffering=0)
        fout = open("/dev/tty", "w")
    except OSError:
        return None
    cur = os.path.realpath(os.path.expanduser(start))
    sel, top, drawn = 0, 0, 0
    try:
        old = termios.tcgetattr(fin)
        tty.setraw(fin.fileno())
    except termios.error:
        fin.close(); fout.close()
        return None
    try:
        while True:
            kids = _dirs(cur)
            items = [(".", "use this folder")] + kids
            sel = max(0, min(sel, len(items) - 1))
            top = max(0, min(top, sel, max(0, len(items) - rows)))
            if sel >= top + rows:
                top = sel - rows + 1
            out = [f"\x1b[2K  \x1b[36m{cur}\x1b[0m\r\n"]
            for i, (name, label) in enumerate(items[top:top + rows], start=top):
                mark = "\x1b[36m>\x1b[0m" if i == sel else " "
                text = "use this folder" if i == 0 else name + "/"
                tail = f"  \x1b[2m{label}\x1b[0m" if (label and i) else ""
                body = f"\x1b[36m{text}\x1b[0m" if i == sel else text
                out.append(f"\x1b[2K {mark} {body}{tail}\r\n")
            more = len(items) - (top + rows)
            if more > 0:
                out.append(f"\x1b[2K    \x1b[2m+{more} more\x1b[0m\r\n")
            out.append("\x1b[2K  \x1b[2m↑↓ move · → open · ← up · ⏎ choose · q cancel\x1b[0m\r\n")
            if drawn:
                fout.write(f"\x1b[{drawn}A")
            fout.write("".join(out) + "\x1b[J")
            fout.flush()
            drawn = len(out)

            k = _key(fin)
            if k == "esc":
                return None
            if k == "up":
                sel -= 1
            elif k == "down":
                sel += 1
            elif k == "left":
                parent = os.path.dirname(cur)
                if parent and parent != cur:
                    cur, sel, top = parent, 0, 0
            elif k == "right" and sel:
                cur, sel, top = os.path.join(cur, items[sel][0]), 0, 0
            elif k == "enter":
                return cur if sel == 0 else os.path.join(cur, items[sel][0])
    finally:
        termios.tcsetattr(fin, termios.TCSADRAIN, old)
        fout.write("\x1b[J"); fout.flush()
        fin.close(); fout.close()


def _call(token, method, **params):
    data = urlencode(params).encode() if params else None   # None -> GET
    req = Request(f"https://api.telegram.org/bot{token}/{method}", data=data)
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def _get_updates(token):
    return _call(token, "getUpdates")


def avatar_upload(jpeg, boundary="mysticalbotpic"):
    """(content_type, body) for setMyProfilePhoto. Profile photos can't be sent
    as a URL or reused file_id, so it has to be a multipart upload — and stdlib
    has no multipart builder, hence the hand-rolled bytes."""
    b = boundary.encode()
    body = (b"--" + b + b'\r\nContent-Disposition: form-data; name="photo"\r\n\r\n'
            b'{"type":"static","photo":"attach://pic"}\r\n'
            b"--" + b + b'\r\nContent-Disposition: form-data; name="pic";'
            b' filename="pic.jpg"\r\nContent-Type: image/jpeg\r\n\r\n' + jpeg +
            b"\r\n--" + b + b"--\r\n")
    return f"multipart/form-data; boundary={boundary}", body


def set_avatar(token, path=AVATAR):
    """Give the bot our logo as its Telegram profile picture. True on success."""
    with open(path, "rb") as f:
        ctype, body = avatar_upload(f.read())
    req = Request(f"https://api.telegram.org/bot{token}/setMyProfilePhoto",
                  data=body, headers={"Content-Type": ctype})
    with urlopen(req, timeout=30) as r:
        return bool(json.loads(r.read()).get("ok"))


# What Telegram shows on the bot's empty-chat screen (<=512) and on its profile
# card (<=120). Only used to fill blanks — see ensure_profile.
DESCRIPTION = (
    "Claude Code, driven from your phone.\n\n"
    "Pick a repo on your machine, send a prompt, get the answer back here. "
    "I ping you the moment Claude needs a decision, and the Mini App panel "
    "carries the transcript, diffs, files, terminal and dev server.\n\n"
    "Sessions survive restarts and resume themselves after a usage limit.\n\n"
    "Runs on your own computer. Only the chats you allow can talk to me.")
SHORT_DESCRIPTION = (
    "Claude Code on your phone — run sessions in your own repos, "
    "answer its questions, ship from anywhere.")

_PROFILE_FIELDS = (("Description", "description", DESCRIPTION),
                   ("ShortDescription", "short_description", SHORT_DESCRIPTION))


def ensure_profile(token, log=print):
    """Fill in whatever the bot is still missing: picture, description, short
    description. Blanks only — anything you set yourself in @BotFather is left
    alone. Best-effort: a bot that can't reach Telegram here still boots."""
    filled = []
    try:
        bot_id = ((_call(token, "getMe").get("result") or {}).get("id"))
        photos = _call(token, "getUserProfilePhotos", user_id=bot_id, limit=1)
        if not (photos.get("result") or {}).get("total_count") and set_avatar(token):
            filled.append("photo")
        for method, key, text in _PROFILE_FIELDS:
            if (_call(token, f"getMy{method}").get("result") or {}).get(key):
                continue
            if _call(token, f"setMy{method}", **{key: text}).get("ok"):
                filled.append(key)
    except Exception as e:  # noqa: BLE001 — cosmetic, never blocks the bridge
        log(f"[profile] skipped: {e}")
    if filled:
        log(f"[profile] filled in the bot's {', '.join(filled)}")
    return filled


def main(argv):
    if len(argv) >= 3 and argv[1] == "capture-chat-id":
        cid = poll_chat_id(argv[2], get_updates=_get_updates)
        if cid is None:
            return 1
        print(cid)
        return 0
    if len(argv) >= 3 and argv[1] == "get-me":
        # Validates the token AND yields the @username, so setup can hand the user
        # a t.me link instead of "go find your bot".
        try:
            data = _call(argv[2], "getMe")
        except Exception:  # noqa: BLE001 — bad token, no network: same answer
            return 1
        if not data.get("ok"):
            return 1
        print(data["result"].get("username", ""))
        return 0
    if len(argv) >= 5 and argv[1] == "set-env":
        set_env(argv[2], argv[3], argv[4])
        return 0
    if len(argv) >= 2 and argv[1] == "pick-dir":
        chosen = pick_dir(argv[2] if len(argv) > 2 else "~")
        if not chosen:
            return 1
        print(chosen)
        return 0
    if len(argv) >= 3 and argv[1] == "set-avatar":
        try:
            return 0 if set_avatar(argv[2], *argv[3:4]) else 1
        except Exception:  # noqa: BLE001 — cosmetic, never blocks setup
            return 1
    print("usage: onboard.py capture-chat-id <token> | get-me <token> "
          "| set-env <path> <key> <value> | set-avatar <token> [jpg] "
          "| pick-dir [start]",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
