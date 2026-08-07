#!/usr/bin/env python3
"""Onboarding helpers for setup.sh — stdlib only."""
import json
import os
import sys
import time
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
    if len(argv) >= 3 and argv[1] == "set-avatar":
        try:
            return 0 if set_avatar(argv[2], *argv[3:4]) else 1
        except Exception:  # noqa: BLE001 — cosmetic, never blocks setup
            return 1
    print("usage: onboard.py capture-chat-id <token> | get-me <token> "
          "| set-env <path> <key> <value> | set-avatar <token> [jpg]",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
