"""Telegram Bot API helpers (HTTP long-polling client)."""

import json
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from bridge import config


def _api(url: str, params: dict | None = None, timeout: int = 30):
    """GET (params=None) or form-encoded POST; return the parsed JSON body.
    Telegram reports errors in the body, so 4xx bodies are parsed too."""
    body = None
    if params is not None:
        body = urlencode({k: v for k, v in params.items() if v is not None}).encode()
    try:
        with urlopen(Request(url, data=body), timeout=timeout) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return json.loads(e.read() or b"{}")


def tg(method: str, **params):
    try:
        data = _api(f"{config.API}/{method}", params,
                    timeout=config.POLL_TIMEOUT + 15)
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
        data = _api(url, timeout=config.POLL_TIMEOUT + 15)
        return data.get("result", []) if data.get("ok") else []
    except Exception as e:  # noqa: BLE001
        # A long-poll that idles out is normal; urllib raises it bare or wrapped.
        if isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError):
            return []
        print(f"[telegram] getUpdates exception: {e}", file=sys.stderr)
        time.sleep(3)
        return []
