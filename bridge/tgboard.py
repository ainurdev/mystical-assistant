"""The Live board: one pinned widget in the owner's Telegram chat that lists every
session with a turn running, and keeps itself current (Bot API 10.4 widgets).

Spec and tickets: .mystical/tickets/telegram-widgets/ in the main checkout; what the
owner's Telegram app does with a widget: docs/superpowers/specs/telegram-widgets-phone-check.md.

- On when a bot token is set, an owner's chat exists (config.DASH_CHAT_ID) and the
  Experimental switch is on. The switch is read on every look, so flipping it needs
  no restart. Off, a look makes no Telegram call at all.
- A watcher thread looks every LOOK_S. A look builds the picture (data, caption,
  buttons), compares each part with what was last sent and sends only what changed:
  at most one data edit, and the caption and buttons together in one edit.
- Elapsed times count up inside the card from each row's start, so a turn that is only
  getting older edits nothing. While anything runs the data goes again every REFRESH_S,
  so the card's "updated" line shows the bridge is still feeding it.
- A board is sent when a turn starts (a session that wasn't running at the last look;
  the first look after boot sees every running turn as starting) and none is recorded.
  It goes silently, with queries allowed, then is pinned; the "pinned a message" line
  Telegram adds for that pin is deleted when the poll loop sees it (pin_line).
- The record (chat, message id, when sent, page version) is one settings entry with a
  place for limit cards beside it, so a restart carries the same message on. What was
  last sent stays in memory: after a restart the first look sends it all again, which
  the buttons need anyway (the Mini App's address changes on every restart).
- Rows come from the status map the dashboard's bell reads (runner.running_snapshot),
  without the process scan: sessions the bridge runs, from any surface. Helpers have no
  rows; a session whose own turn is over while its helpers work is one "N helpers
  working" row. Newest first, at most MAX_ROWS, then "+N more".
- The data is one JSON object of at most DATA_MAX bytes with one-letter names (the
  shape is in the spec's "Built side by side" note, shared by every ticket). Titles and
  steps are cut on a character boundary; if it is still too big, rows are left out.
  Nothing secret goes in it: titles and step labels already reach this chat in pings.
- The page (bridge/widgets/board.html) is fixed once sent, so it draws everything from
  that data. PAGE_V is its version, in the record and in the data.

- A refused call is read from the description telegram.tg keeps (ticket 01 recorded the
  texts): "message is not modified" is success; "message (with widget) to edit not
  found" means the owner deleted it, so the record is cleared and no board is sent until
  the next turn starts (_seen already holds the running ones); "retry after N" stops
  every board call until N seconds have passed; anything else is simply tried again on
  a later look, since what was sent stays as it was.
- With Telegram notifications off as a whole (config.NOTIFY_ENABLE) no board is sent by
  a turn start, but one already recorded is kept current: it never rings. /status still brings one.
- /status (status) sends a fresh board, pins it and deletes the old one. Telegram won't
  delete a message over DELETE_S old, and may refuse anyway: then the old board is left
  behind, with one last data edit {"left": "moved"} and an unpin, and never touched
  again. Switching Experimental off leaves the board the same way with "off"; _off
  keeps a look with the switch off from reading anything after that.
- A recorded board of another PAGE_V is never fed: its page can't read this data. The
  next turn start replaces it as /status does; it gets no "left" edit, only the unpin.

Not here yet (later tickets): Needs-you rows and their
buttons (04), Stop from a row (05), usage bars (07), limit cards (08), work-run rows (09).
"""

import json
import os
import re
import sys
import threading
import time

from bridge import config, experimental, runner, store, telegram

LOOK_S = 5
REFRESH_S = 60
MAX_ROWS = 7
TITLE_B = 24
STEP_B = 36
DATA_MAX = 1024
PAGE_V = 1
KEY = "tg_board"     # settings entry: {"board": record | None, "cards": {}}
PAGE = os.path.join(os.path.dirname(__file__), "widgets", "board.html")

_lock = threading.Lock()
_seen: "set[str]" = set()     # sessions running at the last look: a turn start is one not in here
_sent: dict = {}              # what the recorded board last got: data (minus "at"), at, caption, kb
_wait = [0.0]                 # no board call before this time: Telegram's "retry after"
_off = [False]                # the switch was off at the last look, and any board was left: nothing to read
DELETE_S = 48 * 3600          # Telegram deletes only messages younger than this
# shortcut: refusals are matched on Telegram's English text (tg drops parameters.retry_after); if Telegram rewords them, read the structured fields in tg
GONE = ("message with widget to edit not found", "message to edit not found")


def on() -> bool:
    return bool(config.TOKEN and config.DASH_CHAT_ID and experimental.enabled())


def record() -> dict:
    try:
        rec = json.loads(store.get_setting(KEY) or "{}")
    except (ValueError, TypeError):
        rec = {}
    return {"board": None, "cards": {}, **(rec if isinstance(rec, dict) else {})}


def _save(rec: dict) -> None:
    store.set_setting(KEY, json.dumps(rec))


def cut(text: str, most: int) -> str:
    """At most `most` bytes of UTF-8, cut on a character boundary."""
    return (text or "").encode()[:most].decode(errors="ignore")


def tokens(n: "int | None") -> str:
    if not n:
        return ""
    return str(n) if n < 1000 else f"{n / 1000:.1f}k" if n < 1_000_000 else f"{n / 1_000_000:.1f}M"


def _title(sess: "dict | None", sid: str) -> str:
    return (sess or {}).get("title") or sid[:8]


def rows(chat: int) -> list:
    """Every session with a turn or a helper in flight, newest first, as board rows
    (unkeyed: `sid` is dropped before sending)."""
    snap = runner.running_snapshot(chat, scan=False)
    status = snap.get("status") or {}
    out, helpers = {}, {}
    for j in snap.get("jobs") or []:
        sid = j.get("session_id")
        if not sid:
            continue
        sess = store.get_session(sid)
        parent = (sess or {}).get("parent_session")
        if parent:                      # a helper: counted under its chat, never a row
            h = helpers.setdefault(parent, {"n": 0, "a": None})
            h["n"] += 1
            h["a"] = min(filter(None, (h["a"], j.get("started"))), default=None)
            continue
        job = runner._jobs.get(j.get("job_id"))
        out[sid] = {"sid": sid, "c": "r", "t": _title(sess, sid),
                    "s": (status.get(sid) or {}).get("label") or (j.get("activity") or {}).get("label") or "",
                    "a": j.get("started"), "n": tokens(((job and job.tokens) or {}).get("out"))}
    for sid, st in status.items():      # Claude's own agents, after the turn that started them ended
        if st.get("agents") and sid not in out:
            last = runner._latest_jobs().get(sid)
            h = helpers.setdefault(sid, {"n": 0, "a": last.started if last else None})
            h["n"] += st["agents"]
    for sid, h in helpers.items():
        if sid not in out:
            out[sid] = {"sid": sid, "c": "h", "t": _title(store.get_session(sid), sid),
                        "s": f"{h['n']} helper{'s' if h['n'] != 1 else ''} working", "a": h["a"]}
    return sorted(out.values(), key=lambda r: r["a"] or 0, reverse=True)


def data(found: list, now: float) -> dict:
    """The board's chat data, within DATA_MAX bytes."""
    shown = []
    for r in found[:MAX_ROWS]:
        row = {"k": r["sid"][:8], "c": r["c"], "t": cut(r["t"], TITLE_B), "s": cut(r["s"], STEP_B)}
        if r["a"]:                      # no start known (agents after a restart): no time, not `now`, which would edit every look
            row["a"] = int(r["a"])
        if r.get("n"):
            row["n"] = r["n"]
        shown.append(row)
    while True:
        d = {"v": PAGE_V, "at": int(now), "rows": shown}
        if len(found) > len(shown):
            d["more"] = len(found) - len(shown)
        if len(dump(d).encode()) <= DATA_MAX or not shown:
            return d
        shown = shown[:-1]              # running rows go first; all of them are running rows here


def dump(d: dict) -> str:
    return json.dumps(d, ensure_ascii=False, separators=(",", ":"))


def caption(found: list) -> str:
    return f"{len(found)} running" if found else "nothing running"


def buttons(chat: int) -> "dict | None":
    return telegram.panel_kb(chat, label="◈ Open panel")


def _picture(chat: int, found: list, now: float) -> tuple:
    d = data(found, now)
    return d, {k: v for k, v in d.items() if k != "at"}, caption(found), buttons(chat)


def look(now: "float | None" = None) -> None:
    """One look: send, pin or edit whatever changed. Never raises past a refusal
    (tg returns None for those); the watcher catches the rest."""
    now = now or time.time()
    if not on():
        if not _off[0]:                 # just switched off (or booted off): leave any board behind once
            with _lock:
                rec = record()
                if rec["board"] is not None:
                    _leave(rec["board"], "off", now)
                    rec["board"] = None
                    _save(rec)
                _sent.clear()
                _seen.clear()           # switched back on, running turns are starting again
                _off[0] = True
        return
    _off[0] = False
    if now < _wait[0]:
        return
    with _lock:
        chat = config.DASH_CHAT_ID
        found = rows(chat)
        running = {r["sid"] for r in found}
        started = running - _seen
        _seen.clear()
        _seen.update(running)
        rec = record()
        board = rec["board"]
        pic = _picture(chat, found, now)
        if board is not None and board.get("v") != PAGE_V:
            if started:                 # its page can't read this data: a new board replaces it
                _replace(rec, chat, *pic, now)
            return
        if board is not None:
            _edit(rec, board, *pic, bool(found), now)
        if rec["board"] is None and started and config.NOTIFY_ENABLE and now >= _wait[0]:
            _send(rec, chat, *pic, now)    # also when this look found the board gone


def status(chat: int, private: bool, now: "float | None" = None) -> bool:
    """/status: in the owner's chat with the board on, a fresh board at the bottom of
    the chat, the old one removed or left behind, then a look. False when the caller
    should answer with today's text (off, another chat, a group, a refused widget)."""
    if not (on() and private and chat == config.DASH_CHAT_ID):
        return False
    now = now or time.time()
    if now < _wait[0]:
        return False
    with _lock:
        ok = _replace(record(), chat, *_picture(chat, rows(chat), now), now)
    if ok:
        look(now)
    return ok


def _replace(rec: dict, chat: int, d: dict, body: dict, cap: str, kb: "dict | None", now: float) -> bool:
    """A new board sent and pinned, then the old one deleted, or left behind when
    Telegram won't delete it."""
    old = rec["board"]
    if not _send(rec, chat, d, body, cap, kb, now):
        return False
    if old and not (now - old["at"] < DELETE_S
                    and telegram.tg("deleteMessage", chat_id=old["chat"], message_id=old["msg"])):
        _leave(old, "moved", now)
    return True


def _leave(board: dict, why: str, now: float) -> None:
    """A board left behind: one last update saying why (only if its page reads this
    version's data), and unpinned. Never touched again."""
    if board.get("v") == PAGE_V:
        telegram.tg("editMessageWidgetData", chat_id=board["chat"], message_id=board["msg"],
                    chat_data=dump({"v": PAGE_V, "at": int(now), "left": why}))
    telegram.tg("unpinChatMessage", chat_id=board["chat"], message_id=board["msg"])


def _edit(rec: dict, board: dict, d: dict, body: dict, cap: str, kb: "dict | None",
          busy: bool, now: float) -> None:
    if body != _sent.get("data") or (busy and now - _sent.get("at", 0) >= REFRESH_S):
        ok = _answer(telegram.tg("editMessageWidgetData", chat_id=board["chat"],
                                 message_id=board["msg"], chat_data=dump(d)), rec, now)
        if ok is None:
            return
        if ok:
            _sent.update(data=body, at=now)
    if (cap, kb) != (_sent.get("caption"), _sent.get("kb")):
        ok = _answer(telegram.tg("editMessageCaption", chat_id=board["chat"], message_id=board["msg"],
                                 caption=cap, reply_markup=json.dumps(kb or {"inline_keyboard": []})),
                     rec, now)
        if ok:
            _sent.update(caption=cap, kb=kb)


def _answer(result, rec: dict, now: float) -> "bool | None":
    """An edit's outcome: True done, False try again later, None stop this look (the
    board is gone, or Telegram asked to wait)."""
    err = getattr(telegram._last, "error", "") if not result else ""
    if result or "message is not modified" in err:
        return True
    if any(g in err for g in GONE):
        rec["board"] = None
        _save(rec)
        _sent.clear()
        return None
    return None if _flood(err, now) else False


def _flood(err: str, now: float) -> bool:
    m = re.search(r"retry after (\d+)", err)
    if m:
        _wait[0] = now + int(m.group(1))
    return bool(m)


def _send(rec: dict, chat: int, d: dict, body: dict, cap: str, kb: "dict | None", now: float) -> bool:
    with open(PAGE, encoding="utf-8") as f:
        html = f.read()
    msg = telegram.tg("sendWidget", chat_id=chat, html=html, chat_data=dump(d), caption=cap,
                      allow_queries="true", disable_notification="true",
                      reply_markup=json.dumps(kb) if kb else None)
    if not isinstance(msg, dict) or not msg.get("message_id"):
        _flood(getattr(telegram._last, "error", ""), now)
        return False                    # refused: the next turn start tries again
    rec["board"] = {"chat": chat, "msg": msg["message_id"], "at": int(now), "v": PAGE_V}
    _save(rec)
    _sent.clear()
    _sent.update(data=body, at=now, caption=cap, kb=kb)
    telegram.tg("pinChatMessage", chat_id=chat, message_id=msg["message_id"], disable_notification="true")
    return True


def pin_line(msg: dict) -> bool:
    """The poll loop's hook: True for the "pinned a message" line Telegram added for the
    board's own pin, which is deleted (a refused delete leaves it, nothing else to do)."""
    pinned = msg.get("pinned_message")
    board = record()["board"] if pinned else None
    if not board or msg.get("chat", {}).get("id") != board["chat"] or pinned.get("message_id") != board["msg"]:
        return False
    telegram.tg("deleteMessage", chat_id=board["chat"], message_id=msg["message_id"])
    return True


def watch() -> None:
    """The watcher thread, started at boot. A failed look is only a missed look."""
    def loop():
        while True:
            try:
                look()
            except Exception as e:  # noqa: BLE001
                print(f"[tgboard] look failed: {e}", file=sys.stderr)
            time.sleep(LOOK_S)
    threading.Thread(target=loop, name="tg-board", daemon=True).start()
