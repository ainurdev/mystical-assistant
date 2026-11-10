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

Not here yet (later tickets): refusals and a deleted board (03), Stop from a row (05), /status and a board left behind (06), usage bars
(07), limit cards (08), work-run rows (09).
"""

import json
import os
import sys
import threading
import time

from bridge import config, experimental, notices, runner, store, telegram

LOOK_S = 5
REFRESH_S = 60
MAX_ROWS = 7
MAX_BUTTONS = 3
LAST = 2             # turns that ended, on the quiet board
TITLE_B = 24
STEP_B = 36
DATA_MAX = 1024
PAGE_V = 1
KEY = "tg_board"     # settings entry: {"board": record | None, "cards": {}}
PAGE = os.path.join(os.path.dirname(__file__), "widgets", "board.html")

_lock = threading.Lock()
_seen: "set[str]" = set()     # sessions running at the last look: a turn start is one not in here
_sent: dict = {}              # what the recorded board last got: data (minus "at"), at, caption, kb


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
    (unkeyed: `sid` is dropped before sending)."""
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


def data(found: list, now: float, need: list = (), ended: list = ()) -> dict:
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
    rows, seen = [], set()
    for n in need:
        sid = n["session"]
        if not sid or sid in seen or len(rows) == MAX_BUTTONS:
            continue
        seen.add(sid)
        label = f"◈ {'Answer' if n['kind'] in ANSWER else 'Open'} · {cut(n['t'], TITLE_B)}"
        rows += telegram.panel_kb(chat, session_id=sid, label=label)["inline_keyboard"]
    return {"inline_keyboard": rows + panel["inline_keyboard"]}


def look(now: "float | None" = None) -> None:
    """One look: send, pin or edit whatever changed. Never raises past a refusal
    (tg returns None for those); the watcher catches the rest."""
    if not on():
        return
    now = now or time.time()
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
        ended = last() if not found and not need else ()
        d, cap, kb = data(found, now, need, ended), caption(found, need), buttons(chat, need)
        body = {k: v for k, v in d.items() if k != "at"}
        if board is None:
            if started:
                _send(rec, chat, d, body, cap, kb, now)
            return
        if body != _sent.get("data") or (found and now - _sent.get("at", 0) >= REFRESH_S):
            if telegram.tg("editMessageWidgetData", chat_id=board["chat"], message_id=board["msg"],
                           chat_data=dump(d)):
                _sent.update(data=body, at=now)
        if (cap, kb) != (_sent.get("caption"), _sent.get("kb")):
            if telegram.tg("editMessageCaption", chat_id=board["chat"], message_id=board["msg"],
                           caption=cap, reply_markup=json.dumps(kb or {"inline_keyboard": []})):
                _sent.update(caption=cap, kb=kb)


def _send(rec: dict, chat: int, d: dict, body: dict, cap: str, kb: "dict | None", now: float) -> None:
    with open(PAGE, encoding="utf-8") as f:
        html = f.read()
    msg = telegram.tg("sendWidget", chat_id=chat, html=html, chat_data=dump(d), caption=cap,
                      allow_queries="true", disable_notification="true",
                      reply_markup=json.dumps(kb) if kb else None)
    if not isinstance(msg, dict) or not msg.get("message_id"):
        return                          # refused: the next turn start tries again
    rec["board"] = {"chat": chat, "msg": msg["message_id"], "at": int(now), "v": PAGE_V}
    _save(rec)
    _sent.clear()
    _sent.update(data=body, at=now, caption=cap, kb=kb)
    telegram.tg("pinChatMessage", chat_id=chat, message_id=msg["message_id"], disable_notification="true")


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
