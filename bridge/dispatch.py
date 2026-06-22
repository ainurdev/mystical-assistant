"""Telegram message and callback dispatch (slash commands + plain-text prompts)."""

import json
import os
import sys
import threading

from bridge import config, state, store
from bridge.browser import browser_view, list_dirs, open_browser, rel, within_base
from bridge.devserver import handle_logs, handle_server, server_status
from bridge.runner import handle_task
from bridge.telegram import answer_cb, edit, send, tg
from bridge.tunnel import handle_preview, tunnel_state

HELP = (
    "Claude Code remote bridge.\n\n"
    f"Base path: {config.BASE_PATH}\n\n"
    "Pick a project, then send prompts to work on it.\n\n"
    "/projects — browse and select a project\n"
    "/project — show the active project\n"
    "/app — open the Mini App control panel\n"
    "/new — fresh Claude session for the active project\n"
    "/server [cmd] — start the dev server · /server stop\n"
    "/logs [n] — recent server output\n"
    f"/preview [port] — public link (default {config.PREVIEW_PORT}) · /preview stop\n"
    "/status — everything at a glance\n"
    "/help — this message")


def _open_app(chat_id: int):
    if not config.MINIAPP_ENABLE:
        send(chat_id, "Mini App is disabled (set MINIAPP_ENABLE=1 to enable).")
    elif state.miniapp_url:
        tg("sendMessage", chat_id=chat_id, text="🛠 Open the control panel:",
           reply_markup=json.dumps({"inline_keyboard": [[
               {"text": "🛠 Open Panel", "web_app": {"url": state.miniapp_url}}]]}))
    else:
        send(chat_id, "Mini App URL not ready yet — try again in a moment.")


def on_message(msg: dict):
    chat_id = msg["chat"]["id"]
    text = (msg.get("text") or "").strip()

    if not config.ALLOWED_CHAT_IDS:
        print(f"[discovery] chat_id={chat_id} "
              f"({msg['chat'].get('username', '?')}) — add to ALLOWED_CHAT_IDS.")
        send(chat_id, f"Discovery mode. Your chat_id is {chat_id}. "
                      "Add it to ALLOWED_CHAT_IDS and restart.")
        return
    if chat_id not in config.ALLOWED_CHAT_IDS:
        print(f"[blocked] unauthorized chat_id={chat_id}", file=sys.stderr)
        return
    if not text:
        send(chat_id, "Send a text prompt, or /help.")
        return

    cmd0 = text.split()[0]
    if text in ("/start", "/help"):
        send(chat_id, HELP)
        return
    if cmd0 == "/projects":
        open_browser(chat_id)
        return
    if cmd0 == "/project":
        send(chat_id, f"Active project: {rel(state.project_dir(chat_id))}"
                      + ("" if chat_id in state.active else "  (default — none selected)"))
        return
    if cmd0 == "/app":
        _open_app(chat_id)
        return
    if text == "/new":
        store.create_session(chat_id, state.project_key(chat_id))
        send(chat_id, "🆕 Fresh Claude session.")
        return
    if cmd0 == "/server":
        threading.Thread(target=handle_server,
                         args=(chat_id, text[len("/server"):].strip()),
                         daemon=True).start()
        return
    if cmd0 == "/logs":
        handle_logs(chat_id, text[len("/logs"):].strip())
        return
    if cmd0 == "/preview":
        threading.Thread(target=handle_preview,
                         args=(chat_id, text[len("/preview"):].strip()),
                         daemon=True).start()
        return
    if text == "/status":
        st = f"busy with chat {state.busy_chat}" if state.busy_chat else "idle"
        ts = tunnel_state()
        tunnel = f"{ts['url']} (port {ts['port']})" if ts["url"] else "none"
        s = store.latest_session(chat_id, state.project_key(chat_id))
        sid = (s["title"] or s["id"][:8]) if s else "none yet"
        app = state.miniapp_url or "off"
        send(chat_id, f"Project: {rel(state.project_dir(chat_id))}\nClaude: {st}\n"
                      f"Server: {server_status()}\nPreview: {tunnel}\n"
                      f"Mini App: {app}\nSession: {sid}")
        return

    # Plain text -> prompt to Claude in the active project.
    if not state.busy.acquire(blocking=False):
        send(chat_id, "⏳ Still working on a previous task — please wait.")
        return
    state.busy_chat = chat_id
    threading.Thread(target=handle_task, args=(chat_id, text), daemon=True).start()


def handle_callback(cb: dict):
    chat_id = cb["message"]["chat"]["id"]
    msg_id = cb["message"]["message_id"]
    data = cb.get("data", "")

    if config.ALLOWED_CHAT_IDS and chat_id not in config.ALLOWED_CHAT_IDS:
        answer_cb(cb["id"])
        return

    cur = state.browse.get(chat_id, config.BASE_PATH)

    if data.startswith("nav:"):
        idx = int(data.split(":", 1)[1])
        dirs = list_dirs(cur)
        if 0 <= idx < len(dirs):
            target = os.path.join(cur, dirs[idx])
            if within_base(target):
                state.browse[chat_id] = target
        answer_cb(cb["id"])
        text, kb = browser_view(chat_id)
        edit(chat_id, msg_id, text, kb)

    elif data == "up":
        parent = os.path.dirname(cur)
        state.browse[chat_id] = parent if within_base(parent) else config.BASE_PATH
        answer_cb(cb["id"])
        text, kb = browser_view(chat_id)
        edit(chat_id, msg_id, text, kb)

    elif data == "use":
        state.active[chat_id] = cur   # per-project sessions resolve on first message
        answer_cb(cb["id"], "Selected ✅")
        edit(chat_id, msg_id, f"✅ Active project: {rel(cur)}")
        send(chat_id,
             "Now you can:\n"
             "• send a prompt to work on it\n"
             "• /app to open the control panel\n"
             f"• /server to start it (default: {config.START_CMD})\n"
             "• /preview to open it in your browser")
    else:
        answer_cb(cb["id"])
