"""Telegram Bot API helpers (HTTP long-polling client)."""

import json
import sys
import time
from urllib.parse import urlencode

import requests

from bridge import config


def tg(method: str, **params):
    try:
        r = requests.post(f"{config.API}/{method}", data=params,
                          timeout=config.POLL_TIMEOUT + 15)
        data = r.json()
        if not data.get("ok"):
            print(f"[telegram] {method} error: {data}", file=sys.stderr)
            return None
        return data.get("result")
    except Exception as e:  # noqa: BLE001
        print(f"[telegram] {method} exception: {e}", file=sys.stderr)
        return None


def send(chat_id: int, text: str, reply_markup: dict | None = None):
    text = text or "(empty)"
    extra = {"reply_markup": json.dumps(reply_markup)} if reply_markup else {}
    for i in range(0, len(text), config.TG_MAX):
        tg("sendMessage", chat_id=chat_id, text=text[i:i + config.TG_MAX],
           disable_web_page_preview="true", **(extra if i == 0 else {}))


def edit(chat_id: int, message_id: int, text: str, reply_markup: dict | None = None):
    tg("editMessageText", chat_id=chat_id, message_id=message_id, text=text,
       reply_markup=json.dumps(reply_markup) if reply_markup else None,
       disable_web_page_preview="true")


def answer_cb(cb_id: str, text: str = ""):
    tg("answerCallbackQuery", callback_query_id=cb_id, text=text)


def typing(chat_id: int):
    tg("sendChatAction", chat_id=chat_id, action="typing")


def get_updates(offset: int):
    try:
        url = f"{config.API}/getUpdates?" + urlencode({
            "offset": offset, "timeout": config.POLL_TIMEOUT,
            "allowed_updates": '["message","callback_query"]',
        })
        r = requests.get(url, timeout=config.POLL_TIMEOUT + 15)
        data = r.json()
        return data.get("result", []) if data.get("ok") else []
    except requests.exceptions.ReadTimeout:
        return []
    except Exception as e:  # noqa: BLE001
        print(f"[telegram] getUpdates exception: {e}", file=sys.stderr)
        time.sleep(3)
        return []
