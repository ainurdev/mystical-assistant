"""Telegram Bot API helpers (HTTP long-polling client).

Beyond plain messages: rich messages (Telegram renders the model's Markdown
itself), drafts (a live preview while a turn runs, with Telegram's own Stop
button), reactions (a receipt on the user's own message), silent sends, the
topics of a private chat with threads, and the bot's command menu. Every one
of them is best effort: tg() returns None on any refusal and the caller falls
back to what worked before."""

import html as _html
import json
import re
import sys
import threading
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


_last = threading.local()     # the last refusal's description, per thread (send's topic fallback)
# Topics Telegram says are gone (deleted or closed): bridge/tgtopics.py makes the session a new one.
gone_threads: "set[tuple[int, int]]" = set()
_THREAD_GONE = re.compile(r"thread not found|TOPIC_(DELETED|CLOSED)", re.I)


def tg(method: str, **params):
    # A Telegram-free install still runs everything else, and every caller here
    # (runner, limits, devserver, ladder) sends unconditionally — so the no-op
    # belongs in the one place they all route through.
    if not config.TOKEN:
        return None
    _last.error = ""
    try:
        data = _api(f"{config.API}/{method}", params,
                    timeout=config.POLL_TIMEOUT + 15)
        if not data.get("ok"):
            _last.error = str(data.get("description") or "")
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
# A date entity (limits.when_tg): shown in the reader's own clock. Kept whole
# through the markdown pass; a plain-text fallback shows only its text.
_TG_TIME = re.compile(r'<tg-time unix="\d+" format="w?t">([^<>\n]{1,32})</tg-time>')


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
    md = _TG_TIME.sub(lambda m: hold(m[0]), md)
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


# A code block longer than this folds in a rich message: a log or a diff is
# there to be opened, not scrolled past.
FOLD_LINES = 15
_FENCED = re.compile(r"^```(\w*)\n(.*?)\n```[ \t]*$", re.S | re.M)


def _fold_code(md: str) -> str:
    """Long fenced blocks wrapped in <details>, which a rich message shows shut
    with its summary; Telegram parses the Markdown inside it."""
    def fold(m: "re.Match") -> str:
        n = m[2].count("\n") + 1
        if n <= FOLD_LINES:
            return m[0]
        return f"<details><summary>{m[1] or 'output'}, {n} lines</summary>\n\n{m[0]}\n\n</details>"
    return _FENCED.sub(fold, md)


def _plain(html_text: str) -> str:
    """Telegram HTML as the text it shows: what a refused message falls back to."""
    return _html.unescape(re.sub(r"<[^>]+>", "", html_text))


def send(chat_id: int, text: str, reply_markup: dict | None = None, markdown: bool = True,
         *, silent: bool = False, thread: "int | None" = None, rich: bool = False,
         html: bool = False):
    sent = _send(chat_id, text, reply_markup, markdown, silent=silent, thread=thread, rich=rich, html=html)
    if not sent and thread and _THREAD_GONE.search(getattr(_last, "error", "")):
        gone_threads.add((chat_id, thread))   # its topic is gone: the main chat instead
        sent = _send(chat_id, text, reply_markup, markdown, silent=silent, rich=rich, html=html)
    return sent


def _send(chat_id: int, text: str, reply_markup: dict | None = None, markdown: bool = True,
          *, silent: bool = False, thread: "int | None" = None, rich: bool = False,
          html: bool = False):
    """Send `text` (split on lines past TG_MAX), buttons on the last chunk.
    Returns the last message Telegram accepted — the one carrying the buttons,
    which a later reply or edit refers to — or None. markdown=False sends text
    from outside as typed (only escaped), so none of it becomes a link.

    rich=True (a model's answer) sends it as one rich message when TG_RICH is on
    and it fits; one Telegram refuses goes the HTML way. html=True sends text
    that is already Telegram HTML, its outside words escaped by the caller (a
    date entity, a folded quote), in one message, as plain text if refused.
    silent: no sound or vibration. thread: the topic, in a private chat with
    threads (bridge/tgtopics.py)."""
    text = text or "(empty)"
    base = {**({"disable_notification": "true"} if silent else {}),
            **({"message_thread_id": thread} if thread else {})}
    extra = {"reply_markup": json.dumps(reply_markup)} if reply_markup else {}
    if rich and config.TG_RICH and len(text) <= config.TG_RICH_MAX:
        sent = tg("sendRichMessage", chat_id=chat_id,
                  rich_message=json.dumps({"markdown": _fold_code(text)}), **base, **extra)
        if sent:
            return sent
    if html:
        one = dict(chat_id=chat_id, disable_web_page_preview="true", **base, **extra)
        return (tg("sendMessage", text=text, parse_mode="HTML", **one)
                or tg("sendMessage", text=_plain(text)[:config.TG_MAX], **one))
    # Margin under TG_MAX: escaping and tags only ever grow the text.
    chunks = _chunks(text, config.TG_MAX - 512) or [text]
    sent = None
    for i, raw in enumerate(chunks):
        html_text = _md_to_html(raw) if markdown else _esc(raw)
        params = dict(chat_id=chat_id, disable_web_page_preview="true", **base,
                      # Buttons ride the LAST chunk: that's where reading ends.
                      **(extra if i == len(chunks) - 1 else {}))
        # Whatever outgrew the hard limit, or that Telegram rejects as malformed
        # HTML, goes as the plain markdown it sent before parse_mode existed:
        # unformatted is a worse message, dropped is a lost one.
        sent = ((len(html_text) <= config.TG_MAX
                 and tg("sendMessage", text=html_text, parse_mode="HTML", **params))
                or tg("sendMessage", text=_TG_TIME.sub(r"\1", raw)[:config.TG_MAX], **params))
    return sent


def edit(chat_id: int, message_id: int, text: str, reply_markup: dict | None = None,
         *, html: bool = False):
    """Rewrite a message the bot sent. html=True: `text` is Telegram HTML (its
    outside words escaped by the caller); otherwise it shows as typed."""
    tg("editMessageText", chat_id=chat_id, message_id=message_id, text=text,
       parse_mode="HTML" if html else None,
       reply_markup=json.dumps(reply_markup) if reply_markup else None,
       disable_web_page_preview="true")


def edit_markup(chat_id: int, message_id: int, reply_markup: "dict | None"):
    """Change only a message's buttons (none: take them all away)."""
    tg("editMessageReplyMarkup", chat_id=chat_id, message_id=message_id,
       reply_markup=json.dumps(reply_markup or {"inline_keyboard": []}))


def draft(chat_id: int, draft_id: int, text: str, *, thread: "int | None" = None) -> bool:
    """A live preview of the message a turn is writing (sendMessageDraft, all
    bots since Bot API 9.5; rich since 10.1), with Telegram's own Stop button
    (10.3), which comes back as a stopped_message_generation update. Telegram
    keeps it 30 seconds unless it is sent again, and drops it when the bot sends
    a message. "" shows Telegram's "Thinking…". False when refused."""
    base = dict(chat_id=chat_id, draft_id=draft_id, can_stop="true",
                **({"message_thread_id": thread} if thread and (chat_id, thread) not in gone_threads else {}))
    if text and config.TG_RICH and tg("sendRichMessageDraft",
                                      rich_message=json.dumps({"markdown": text[:config.TG_RICH_MAX]}),
                                      **base):
        return True
    return bool(tg("sendMessageDraft", text=text[:config.TG_MAX], **base))


def react(chat_id: int, message_id: int, emoji: "str | None") -> bool:
    """One reaction on a message, or none (None): a receipt on the user's own
    message instead of a message of its own. Only Telegram's reaction emoji take."""
    return bool(tg("setMessageReaction", chat_id=chat_id, message_id=message_id,
                   reaction=json.dumps([{"type": "emoji", "emoji": emoji}] if emoji else [])))


def set_commands(commands: "list[tuple[str, str]]") -> bool:
    """The menu "/" opens in every private chat with the bot."""
    return bool(tg("setMyCommands",
                   commands=json.dumps([{"command": c, "description": d} for c, d in commands]),
                   scope=json.dumps({"type": "all_private_chats"})))


def create_topic(chat_id: int, name: str, color: "int | None" = None) -> "int | None":
    """A topic of a private chat with threads (Bot API 9.4): its thread id."""
    got = tg("createForumTopic", chat_id=chat_id, name=(name or "Session")[:128], icon_color=color)
    return got.get("message_thread_id") if isinstance(got, dict) else None


def rename_topic(chat_id: int, thread: int, name: str) -> None:
    tg("editForumTopic", chat_id=chat_id, message_thread_id=thread, name=(name or "Session")[:128])


def answer_cb(cb_id: str, text: str = ""):
    tg("answerCallbackQuery", callback_query_id=cb_id, text=text)


def typing(chat_id: int):
    tg("sendChatAction", chat_id=chat_id, action="typing")


def get_updates(offset: int):
    try:
        url = f"{config.API}/getUpdates?" + urlencode({
            "offset": offset, "timeout": config.POLL_TIMEOUT,
            "allowed_updates": '["message","callback_query","stopped_message_generation"]',
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
