#!/usr/bin/env python3
"""Onboarding helpers for setup.sh — stdlib + `requests` (imported lazily so the
unit tests can inject a fake fetcher without the dependency)."""
import sys
import time


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
    import os
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


def _get_updates(token):
    import requests
    r = requests.get(f"https://api.telegram.org/bot{token}/getUpdates", timeout=30)
    return r.json()


def main(argv):
    if len(argv) >= 3 and argv[1] == "capture-chat-id":
        cid = poll_chat_id(argv[2], get_updates=_get_updates)
        if cid is None:
            return 1
        print(cid)
        return 0
    if len(argv) >= 5 and argv[1] == "set-env":
        set_env(argv[2], argv[3], argv[4])
        return 0
    print("usage: onboard.py capture-chat-id <token> | set-env <path> <key> <value>",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
