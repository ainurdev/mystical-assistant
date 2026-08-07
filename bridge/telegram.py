"""Telegram Bot API helpers (HTTP long-polling client)."""

import json
import re
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from bridge import config, state


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


# --- markdown -> Telegram HTML ----------------------------------------------
# The model answers in markdown and Telegram renders none of it without a
# parse_mode, so bold, headings and code arrived as literal punctuation. HTML
# rather than MarkdownV2: MarkdownV2 needs ~15 characters escaped everywhere
# except inside code spans, and a single miss rejects the whole message — here a
# miss only costs the formatting (see send's fallback).

_FENCE = re.compile(r"```(\w*)\n?(.*?)```", re.S)
_INLINE_CODE = re.compile(r"`([^`\n]+)`")
_BOLD = re.compile(r"\*\*(\S(?:.*?\S)?)\*\*", re.S)
_LINK = re.compile(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)")
_HEADING = re.compile(r"^#{1,6}\s+(.+)$", re.M)
_BULLET = re.compile(r"^(\s*)[-*]\s+", re.M)
_HELD = re.compile("\x00(\\d+)\x00")


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _md_to_html(md: str) -> str:
    """Markdown to the small HTML subset Telegram accepts.

    Code spans are lifted out first so their contents are never read as markup.
    `_underscore_` italics are deliberately unsupported: in this chat an
    underscore is a snake_case identifier far more often than emphasis."""
    held: list[str] = []

    def hold(html: str) -> str:
        held.append(html)
        return f"\x00{len(held) - 1}\x00"

    def fence(m: "re.Match") -> str:
        lang = f' class="language-{m[1]}"' if m[1] else ""
        return hold(f"<pre><code{lang}>{_esc(m[2].strip(chr(10)))}</code></pre>")

    md = _FENCE.sub(fence, md)
    md = _INLINE_CODE.sub(lambda m: hold(f"<code>{_esc(m[1])}</code>"), md)
    out = _esc(md)
    out = _HEADING.sub(r"<b>\1</b>", out)
    out = _BOLD.sub(r"<b>\1</b>", out)
    out = _LINK.sub(r'<a href="\2">\1</a>', out)
    out = _BULLET.sub(r"\1• ", out)
    return _HELD.sub(lambda m: held[int(m[1])], out)


def _chunks(text: str, limit: int) -> list[str]:
    """Split on line boundaries rather than mid-word, closing and reopening a
    code fence a split would otherwise have cut in half."""
    out: list[str] = []
    cur: list[str] = []
    fence: str | None = None
    size = 0
    for line in text.split("\n"):
        parts = ([line] if len(line) <= limit else
                 [line[i:i + limit] for i in range(0, len(line), limit)])
        for part in parts:
            if cur and size + len(part) + 1 > limit:
                out.append("\n".join(cur + (["```"] if fence is not None else [])))
                cur = [f"```{fence}"] if fence is not None else []
                size = sum(len(c) + 1 for c in cur)
            cur.append(part)
            size += len(part) + 1
        if line.lstrip().startswith("```"):
            fence = None if fence is not None else line.lstrip()[3:].strip()
    if cur:
        out.append("\n".join(cur))
    return [c for c in out if c.strip()]


def panel_kb(chat_id: int, session_id: str | None = None,
             project: str | None = None, label: str = "🛠 Open Panel"):
    """Keyboard that opens the Mini App — right at `session_id` when given.

    A button beats pasting the tunnel URL into the text: the URL is ephemeral,
    unreadable on a lock screen, and lands you on whatever session the panel
    happened to be showing. Returns None when there's nothing to open, or in a
    group — Telegram only accepts web_app buttons in private chats, and a
    rejected markup would drop the whole message, notification and all."""
    if not state.miniapp_url or chat_id <= 0:
        return None
    q = urlencode([(k, v) for k, v in (("s", session_id), ("p", project)) if v])
    return {"inline_keyboard": [[
        {"text": label, "web_app": {"url": state.miniapp_url + (f"?{q}" if q else "")}}]]}


def send(chat_id: int, text: str, reply_markup: dict | None = None):
    text = text or "(empty)"
    extra = {"reply_markup": json.dumps(reply_markup)} if reply_markup else {}
    # Margin under TG_MAX: escaping and tags only ever grow the text.
    chunks = _chunks(text, config.TG_MAX - 512) or [text]
    for i, raw in enumerate(chunks):
        html = _md_to_html(raw)
        params = dict(chat_id=chat_id, disable_web_page_preview="true",
                      # Buttons ride the LAST chunk: that's where reading ends.
                      **(extra if i == len(chunks) - 1 else {}))
        # Whatever outgrew the hard limit, or that Telegram rejects as malformed
        # HTML, goes as the plain markdown it sent before parse_mode existed:
        # unformatted is a worse message, dropped is a lost one.
        if len(html) > config.TG_MAX or not tg("sendMessage", text=html,
                                               parse_mode="HTML", **params):
            tg("sendMessage", text=raw[:config.TG_MAX], **params)


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
