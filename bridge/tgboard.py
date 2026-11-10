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
  working" row. Each item of the bell's Needs-you list (notices.needs, fed the same
  status map) is a row too; a session held on an Ask shows once, as that row, and still
  counts as running. Running rows first, then Needs-you rows, each newest first; at most
  MAX_ROWS, then "+N more", running rows left out first. Quiet (nothing runs or waits),
  the data carries the feed's last LAST DONE or FAILED rows instead.
- Under the widget: a Mini App button per waiting session (at most MAX_BUTTONS), then
  "Open panel". They sit outside the page because the page can only open a fixed t.me
  address and the Mini App's moves on every restart.
- The data is one JSON object of at most DATA_MAX bytes with one-letter names (the
  shape is in the spec's "Built side by side" note, shared by every ticket). Titles and
  steps are cut on a character boundary; if it is still too big, rows are left out.
  Nothing secret goes in it: titles and step labels already reach this chat in pings.
- The page (bridge/widgets/board.html) is fixed once sent, so it draws everything from
  that data. PAGE_V is its version, in the record and in the data.
- A tap on a running row's ■, then Stop, reaches the bot as a widget_query "s:<row key>"
  (on_query, off the poll thread). The page keeps the open question (O) and the rows
  reading "Stopping…" (S, until that turn leaves the board or the answer isn't ok).
  It stops only for an allow-listed sender, in the
  owner's chat, on the recorded board, with a key the board last sent; the turn is
  stopped with the same Job.interrupt the panel's Stop calls. Each query gets exactly one
  answer: ok, gone (the turn already ended) or no. A widget query carries no signed init
  data, so trust is the bot's own update stream plus those checks, as for callbacks.
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
- The footer (`u`) is the 5-hour and weekly windows of the login the newest running
  turn uses, or the default login when nothing runs: percent, reset (epoch, 0 when
  unknown) and severity (0 normal, 1 warning, 2 exceeded), null for a window the meter
  doesn't name or that has reset since the reading. It is read from the meter's cache only (usage.cached): a look every
  LOOK_S must never spawn claude, and a turn's own rate-limit events keep the cache live.
  No reading, no footer. The login is named (alias, else email) only when the registry
  holds a second login: list_accounts() would ask the Keychain on every look.

Limit cards (ticket 08). Both usage-limit notices (runner's park, ladder's choice) ask
limit_card first: with the board on, in the owner's chat, the notice is a widget
(bridge/widgets/limit.html) whose caption and buttons are the notice's own text and
buttons, ringing or silent as that text would; False sends today's text instead (the
switch off, any other chat, a refused widget). The countdown runs inside the card from
the park's resume time in its data. Each look derives the card's state from the
session (_card_state) and edits it only when that changes; once it reads "Resumed" or
"No longer parked" the record is dropped. A choice whose answer came from elsewhere
loses its Switch and Wait buttons on the next look; one answered on the card itself
already had them taken off by the handler (card_caption).

Not here yet (later tickets): work-run rows (09).
"""

import json
import os
import re
import sys
import threading
import time

from bridge import accounts, config, experimental, limits, notices, runner, store, telegram, usage

LOOK_S = 5
REFRESH_S = 60
MAX_ROWS = 7
MAX_BUTTONS = 3
LAST = 2             # turns that ended, on the quiet board
TITLE_B = 24
STEP_B = 36
LOGIN_B = 32
SEV = {"warning": 1, "exceeded": 2}
DATA_MAX = 1024
PAGE_V = 1
KEY = "tg_board"     # settings entry: {"board": record | None, "cards": {}}
PAGE = os.path.join(os.path.dirname(__file__), "widgets", "board.html")
CARD_PAGE = os.path.join(os.path.dirname(__file__), "widgets", "limit.html")
CARD_V = 1
# The caption a choice gets once its buttons go, per state: the handler's own Wait line, and the two ends.
CARD_LINE = {"w": "⏳ Waiting for the usage limit to reset.", "r": "🔄 Resumed.", "g": "No longer parked."}

_lock = threading.Lock()
_seen: "set[str]" = set()     # sessions running at the last look: a turn start is one not in here
_sent: dict = {}              # what the recorded board last got: data (minus "at"), at, caption, kb, keys
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


def rows(chat: int, snap: "dict | None" = None) -> list:
    """Every session with a turn or a helper in flight, newest first, as board rows
    (unkeyed: `sid` and `slot`, the turn's login, are dropped before sending). `snap`: the look's status snapshot,
    shared with the Needs-you rows so both read the same moment."""
    snap = snap or runner.running_snapshot(chat, scan=False)
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
        out[sid] = {"sid": sid, "c": "r", "t": _title(sess, sid), "slot": job and job.account_slot,
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


# Needs-you kinds as the row's verb ("asks: which layout?"); the rest read as the bell's verb.
VERB = {"question": "asks", "approve": "approve", "login": "sign in", "limit_choice": "limit",
        "goal_blocked": "goal", "credits": "credits", "rv_offer": "offered"}
ANSWER = ("question", "approve")       # answered in the panel: "◈ Answer", anything else "◈ Open"


def needing(status: dict) -> list:
    """The bell's Needs-you list (newest first) as board rows."""
    return [{"sid": n["session_id"] or n["subject"], "c": "n", "t": n["title"] or "Mystical",
             "s": n["body"] or "", "a": n["at"], "v": VERB.get(n["kind"], n["verb"].lower()),
             "kind": n["kind"], "session": n["session_id"]} for n in notices.needs(status)]


def last() -> list:
    """The last LAST turns that ended (DONE or FAILED rows of the feed), for the quiet board."""
    out = []
    for r in store.list_notices(time.time() - notices.KEEP_S, LAST, ("done", "failed")):
        n, ok = notices._row(r, {}), r["kind"] == "done"
        e = n["meta"].get("elapsed")
        how = (f"done · {max(1, round(e / 60))} min" if e else "done") if ok else \
            "failed" + (f" · {n['body']}" if n["body"] else "")
        out.append({"t": cut(n["title"] or "session", TITLE_B), "s": cut(how, STEP_B), "a": int(n["at"]),
                    **({"ok": 1} if ok else {})})
    return out


def _login(slot: "int | None") -> "str | None":
    """The login's name, or None while the bridge has only the one."""
    with accounts._lock:
        reg = {int(k): e for k, e in accounts._load().items()
               if str(k).isdigit() and int(k) != accounts.DEFAULT_SLOT}
    if not reg:
        return None
    if not slot or int(slot) == accounts.DEFAULT_SLOT:
        return accounts._email_at(accounts.IDENTITY) or "default login"
    e = reg.get(int(slot)) or {}       # the profile's own email outranks the registry's, as in list_accounts()
    return e.get("alias") or accounts._email_at(os.path.join(accounts.profile_dir(int(slot)), ".claude.json")) \
        or e.get("email") or f"login {slot}"


def footer(found: list) -> "dict | None":
    """The usage footer for the newest running turn's login, or None with no reading."""
    slot = next((r.get("slot") for r in found if r["c"] == "r"), None)
    m, now = usage.cached(accounts.credentials_path(slot)), time.time()
    w = []
    for b in (m.get("five_hour"), m.get("seven_day")) if m.get("available") else (None, None):
        reset = int(usage.resets_epoch((b or {}).get("resets_at")) or 0)
        # a window that has reset since this reading (a turn's last word can be hours old) is no reading
        fresh = isinstance(b, dict) and b.get("percent") is not None and not 0 < reset <= now
        w.append([b["percent"], reset, SEV.get(b.get("severity"), 0)] if fresh else None)
    if w == [None, None]:
        return None
    name = _login(slot)
    return {"l": cut(name, LOGIN_B), "w": w} if name else {"w": w}


def data(found: list, now: float, u: "dict | None" = None, need: list = (), ended: list = ()) -> dict:
    """The board's chat data, within DATA_MAX bytes. Running rows (minus a session held
    on a Needs-you item, which shows once, as that row) come first, then Needs-you rows;
    past MAX_ROWS or DATA_MAX running rows are left out before any Needs-you row."""
    held = {n["sid"] for n in need}
    run = [r for r in found if r["sid"] not in held]
    total = len(run) + len(need)
    need = list(need)[:MAX_ROWS]
    run = run[:MAX_ROWS - len(need)]
    while True:
        shown = []
        for r in run + need:
            row = {"k": r["sid"][:8], "c": r["c"], "t": cut(r["t"], TITLE_B), "s": cut(r["s"], STEP_B)}
            if r["a"]:                  # no start known (agents after a restart): no time, not `now`, which would edit every look
                row["a"] = int(r["a"])
            if r.get("n"):
                row["n"] = r["n"]
            if r.get("v"):
                row["v"] = r["v"]
            shown.append(row)
        d = {"v": PAGE_V, "at": int(now), "rows": shown}
        if total > len(shown):
            d["more"] = total - len(shown)
        if ended and not total:
            d["last"] = list(ended)
        if u:
            d["u"] = u
        if len(dump(d).encode()) <= DATA_MAX or not shown:
            return d
        if run:
            run = run[:-1]
        else:
            need = need[:-1]


def dump(d: dict) -> str:
    return json.dumps(d, ensure_ascii=False, separators=(",", ":"))


def caption(found: list, need: list = ()) -> str:
    return (f"{len(found)} running" if found else "nothing running") + (f" · {len(need)} needs you" if need else "")


def buttons(chat: int, need: list = ()) -> "dict | None":
    """One Mini App button per waiting session (newest first, at most MAX_BUTTONS), then
    the panel. Built from the Mini App's current address on every look; none without one."""
    panel = telegram.panel_kb(chat, label="◈ Open panel")
    if not panel:
        return None
    keys, seen = [], set()
    for n in need:
        sid = n["session"]
        if not sid or sid in seen or len(keys) == MAX_BUTTONS:
            continue
        seen.add(sid)
        label = f"◈ {'Answer' if n['kind'] in ANSWER else 'Open'} · {cut(n['t'], TITLE_B)}"
        keys += telegram.panel_kb(chat, session_id=sid, label=label)["inline_keyboard"]
    return {"inline_keyboard": keys + panel["inline_keyboard"]}


def _picture(chat: int, found: list, need: list, now: float) -> tuple:
    ended = last() if not found and not need else ()
    d = data(found, now, footer(found), need, ended)
    return d, {k: v for k, v in d.items() if k != "at"}, caption(found, need), buttons(chat, need)


def look(now: "float | None" = None) -> None:
    """One look: send, pin or edit whatever changed. Never raises past a refusal
    (tg returns None for those); the watcher catches the rest."""
    now = now or time.time()
    if now < _wait[0]:                  # also holds back leaving a board on switch-off: it gets one try
        return
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
    with _lock:
        chat = config.DASH_CHAT_ID
        snap = runner.running_snapshot(chat, scan=False)
        found = rows(chat, snap)
        need = needing(snap.get("status") or {})
        running = {r["sid"] for r in found}
        started = running - _seen
        _seen.clear()
        _seen.update(running)
        rec = record()
        board = rec["board"]
        pic = _picture(chat, found, need, now)
        if board is not None and board.get("v") != PAGE_V:
            if started:                 # its page can't read this data: a new board replaces it
                _replace(rec, chat, found, *pic, now)
        elif board is not None:
            _edit(rec, board, found, *pic, now)
        if rec["board"] is None and started and config.NOTIFY_ENABLE and now >= _wait[0]:
            _send(rec, chat, found, *pic, now)    # also when this look found the board gone
        if rec["cards"] and now >= _wait[0]:
            _cards(rec, {r["sid"] for r in found if r["c"] == "r"}, now)


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
        if not on():                    # the watcher may have left the board behind meanwhile
            return False
        snap = runner.running_snapshot(chat, scan=False)
        found = rows(chat, snap)
        ok = _replace(record(), chat, found, *_picture(chat, found, needing(snap.get("status") or {}), now), now)
    if ok:
        look(now)
    return ok


def _replace(rec: dict, chat: int, found: list, d: dict, body: dict, cap: str, kb: "dict | None",
             now: float) -> bool:
    """A new board sent and pinned, then the old one deleted, or left behind when
    Telegram won't delete it."""
    old = rec["board"]
    if not _send(rec, chat, found, d, body, cap, kb, now):
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


def _edit(rec: dict, board: dict, found: list, d: dict, body: dict, cap: str,
          kb: "dict | None", now: float) -> None:
    if body != _sent.get("data") or (found and now - _sent.get("at", 0) >= REFRESH_S):
        ok = _answer(telegram.tg("editMessageWidgetData", chat_id=board["chat"],
                                 message_id=board["msg"], chat_data=dump(d)), rec, now)
        if ok is None:
            return
        if ok:
            _sent.update(data=body, at=now, keys=_keys(found, d))
    if (cap, kb) != (_sent.get("caption"), _sent.get("kb")):
        ok = _answer(telegram.tg("editMessageCaption", chat_id=board["chat"], message_id=board["msg"],
                                 caption=cap, reply_markup=json.dumps(kb or {"inline_keyboard": []})),
                     rec, now)
        if ok:
            _sent.update(caption=cap, kb=kb)


def _answer(result, rec: dict, now: float) -> "bool | None":
    """An edit's outcome: True done, False try again later, None stop this look (the
    board is gone, or Telegram asked to wait)."""
    out = _outcome(result, now)
    if out == "gone":
        rec["board"] = None
        _save(rec)
        _sent.clear()
        return None
    return out


def _outcome(result, now: float) -> "bool | str | None":
    """True done, "gone" deleted, None Telegram asked to wait, False try again later."""
    err = getattr(telegram._last, "error", "") if not result else ""
    if result or "message is not modified" in err:
        return True
    if any(g in err for g in GONE):
        return "gone"
    return None if _flood(err, now) else False


def _flood(err: str, now: float) -> bool:
    m = re.search(r"retry after (\d+)", err)
    if m:
        _wait[0] = now + int(m.group(1))
    return bool(m)


def _send(rec: dict, chat: int, found: list, d: dict, body: dict, cap: str, kb: "dict | None", now: float) -> bool:
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
    _sent.update(data=body, at=now, caption=cap, kb=kb, keys=_keys(found, d))
    telegram.tg("pinChatMessage", chat_id=chat, message_id=msg["message_id"], disable_notification="true")
    return True


def _keys(found: list, d: dict) -> dict:
    """The row keys a Stop may name, as the board was last sent them: running rows only."""
    shown = {r["k"] for r in d["rows"] if r["c"] == "r"}
    return {r["sid"][:8]: r["sid"] for r in found if r["sid"][:8] in shown}


def on_query(q: dict) -> None:
    """The poll loop's hook for a widget_query: handled off the poll thread."""
    threading.Thread(target=query, args=(q,), name="tg-board-tap", daemon=True).start()


def query(q: dict) -> None:
    """One request from the board, answered exactly once; a Stop that lands is followed
    by a look at once, so the board catches up within a second or two."""
    answer = "no"
    try:
        answer = _stop(q)
    except Exception as e:  # noqa: BLE001
        print(f"[tgboard] query failed: {e}", file=sys.stderr)
    telegram.tg("answerWidgetQuery", widget_query_id=q.get("id"), data=answer)
    if answer == "ok":
        look()


def _stop(q: dict) -> str:
    sender = (q.get("from") or {}).get("id")
    if sender not in config.ALLOWED_CHAT_IDS:
        return "no"
    board = record()["board"]
    chat = (q.get("chat") or {}).get("id")
    if not board or chat != config.DASH_CHAT_ID or chat != board["chat"] or q.get("message_id") != board["msg"]:
        return "no"
    act, _, key = str(q.get("data") or "").partition(":")
    sid = (_sent.get("keys") or {}).get(key)
    if act != "s" or not sid:
        return "no"
    job = runner.live_job(sid)
    return "ok" if job and job.interrupt() else "gone"


def _card_state(sid: str, running: set, now: float, sent: float = 0) -> dict:
    """The card's part of its data, from the session's live state. A turn started
    since the card was sent and already over still counts as resumed."""
    p = limits.parked().get(sid)
    if sid not in running and p and p["kind"] == "limit":
        return {"s": "c" if p["offer"] else "w", "a": int(p["at"])}
    last = runner._latest_jobs().get(sid)
    if sid in running or (last and (last.started or 0) > sent):
        return {"s": "r", "e": int(now)}
    return {"s": "g", "e": int(now)}


def _card_data(sid: str, st: dict) -> str:
    return dump({"v": CARD_V, "t": cut(_title(store.get_session(sid), sid), TITLE_B), **st})


def limit_card(chat: int, sid: str, text: str, kb: "dict | None", *,
               silent: bool = False, thread: "int | None" = None) -> bool:
    """The one sender both usage-limit notices go through. True: the notice went as a
    limit card. False: the caller sends today's text, as it always did."""
    now = time.time()
    if not on() or chat != config.DASH_CHAT_ID or chat <= 0 or now < _wait[0]:
        return False                    # widgets go to private chats only
    st = _card_state(sid, set(), now)
    with open(CARD_PAGE, encoding="utf-8") as f:
        html = f.read()
    msg = telegram.tg("sendWidget", chat_id=chat, html=html, chat_data=_card_data(sid, st),
                      caption=telegram._md_to_html(text), parse_mode="HTML",
                      disable_notification="true" if silent else None, message_thread_id=thread,
                      reply_markup=json.dumps(kb) if kb else None)
    if not isinstance(msg, dict) or not msg.get("message_id"):
        _flood(getattr(telegram._last, "error", ""), now)
        return False
    with _lock:
        rec = record()
        # shortcut: a second park of the same session replaces the record, so an older card keeps its last state; drop it first if that shows up
        rec["cards"][sid] = {"chat": chat, "msg": msg["message_id"], "s": st["s"], "a": st.get("a"),
                             "k": st["s"] == "c", "at": int(now)}
        _save(rec)
    return True


def _cards(rec: dict, running: set, now: float) -> None:
    """Each card follows its session: one data edit when its state changes, and its
    Switch and Wait buttons off once the choice is over."""
    for sid, card in list(rec["cards"].items()):
        st = _card_state(sid, running, now, card.get("at", 0))
        if st["s"] == "g" and not card.get("g"):
            card["g"] = 1               # only on a second look: the first may fall between the park's end and its turn's start
            _save(rec)
            continue
        if st["s"] != "g":
            card.pop("g", None)
        if (st["s"], st.get("a")) == (card["s"], card.get("a")):
            continue
        out = _outcome(telegram.tg("editMessageWidgetData", chat_id=card["chat"], message_id=card["msg"],
                                   chat_data=_card_data(sid, st)), now)
        if out is None:
            break                       # Telegram asked to wait
        if out == "gone":
            del rec["cards"][sid]
        elif out:
            card.update(s=st["s"], a=st.get("a"))
            if card["k"] and st["s"] != "c" and _outcome(telegram.tg(
                    "editMessageCaption", chat_id=card["chat"], message_id=card["msg"],
                    caption=CARD_LINE[st["s"]], reply_markup=json.dumps({"inline_keyboard": []})), now) is True:
                card["k"] = False
            if st["s"] in ("r", "g"):
                del rec["cards"][sid]
        _save(rec)


def card_caption(chat: int, msg: int, line: str) -> None:
    """The Switch and Wait handler's line, on a card: written to its caption, and the
    choice marked answered so a look doesn't write over it."""
    if _outcome(telegram.tg("editMessageCaption", chat_id=chat, message_id=msg, caption=line,
                            reply_markup=json.dumps({"inline_keyboard": []})), time.time()) is not True:
        return                          # the buttons stay, so the next look still takes them off
    with _lock:
        rec = record()
        for card in rec["cards"].values():
            if (card["chat"], card["msg"]) == (chat, msg):
                card["k"] = False
        _save(rec)


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
