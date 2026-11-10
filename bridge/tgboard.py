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
- A tap on a running row's ■, then Stop, reaches the bot as a widget_query "s:<row key>"
  (on_query, off the poll thread). The page keeps the open question (O) and the rows
  reading "Stopping…" (S, until that turn leaves the board or the answer isn't ok).
  It stops only for an allow-listed sender, in the
  owner's chat, on the recorded board, with a key the board last sent; the turn is
  stopped with the same Job.interrupt the panel's Stop calls. Each query gets exactly one
  answer: ok, gone (the turn already ended) or no. A widget query carries no signed init
  data, so trust is the bot's own update stream plus those checks, as for callbacks.
- A session managing a running work run (workrun's "_work" mark) shows it on its row, kind
  "w": the item in progress as its step, "p" = [done, total, more in progress], timed from
  the run's start. Its Stop is "w:<row key>" and does what /work stop does (workrun._stop).
  A paused run has no row; the manager's turn or its helpers are what make the row exist.

Not here yet (later tickets): refusals and a deleted board (03), Needs-you rows and their
buttons (04), /status and a board left behind (06), usage bars
(07), limit cards (08).
"""

import json
import os
import sys
import threading
import time

from bridge import config, experimental, runner, store, telegram, worklist, workrun

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
_sent: dict = {}              # what the recorded board last got: data (minus "at"), at, caption, kb, keys


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
    for r in out.values():
        _work_row(r)
    return sorted(out.values(), key=lambda r: r["a"] or 0, reverse=True)


def _managed_run(sid: str) -> "tuple":
    """(project, its work list, the run) for the running work run this session manages
    (workrun._mark_chat), or Nones."""
    mark = store.parse_json((store.get_session(sid) or {}).get("chat_config")).get("_work") or {}
    root = mark.get("root")
    data = worklist.load(root) if root else {"runs": []}
    run = next((r for r in data["runs"] if r.get("id") == mark.get("run")), None)
    return (root, data, run) if run and run.get("state") == "running" else (None, None, None)


def _work_row(r: dict) -> None:
    """A manager's row, while its run is running, becomes a work-run row: counts, an item in
    progress and the run's start (the page composes the words, so the title keeps its bytes)."""
    _, data, run = _managed_run(r["sid"])
    if not run:
        return
    items = [i for i in data["items"] if i["id"] in run.get("items", [])]
    doing = [i["title"] for i in items if i["state"] == "doing"]   # not review: that waits on the manager
    r.update(c="w", s=doing[0] if doing else "", a=run.get("started"), n="",   # no tokens on a work-run row
             p=[sum(i["state"] == "done" for i in items), len(items), max(len(doing) - 1, 0)])


def data(found: list, now: float) -> dict:
    """The board's chat data, within DATA_MAX bytes."""
    shown = []
    for r in found[:MAX_ROWS]:
        row = {"k": r["sid"][:8], "c": r["c"], "t": cut(r["t"], TITLE_B), "s": cut(r["s"], STEP_B)}
        if r["a"]:                      # no start known (agents after a restart): no time, not `now`, which would edit every look
            row["a"] = int(r["a"])
        if r.get("n"):
            row["n"] = r["n"]
        if r.get("p"):
            row["p"] = r["p"]
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


def look(now: "float | None" = None) -> None:
    """One look: send, pin or edit whatever changed. Never raises past a refusal
    (tg returns None for those); the watcher catches the rest."""
    if not on():
        return
    now = now or time.time()
    with _lock:
        chat = config.DASH_CHAT_ID
        found = rows(chat)
        running = {r["sid"] for r in found}
        started = running - _seen
        _seen.clear()
        _seen.update(running)
        rec = record()
        board = rec["board"]
        d, cap, kb = data(found, now), caption(found), buttons(chat)
        body = {k: v for k, v in d.items() if k != "at"}
        if board is None:
            if started:
                _send(rec, chat, found, d, body, cap, kb, now)
            return
        if body != _sent.get("data") or (found and now - _sent.get("at", 0) >= REFRESH_S):
            if telegram.tg("editMessageWidgetData", chat_id=board["chat"], message_id=board["msg"],
                           chat_data=dump(d)):
                _sent.update(data=body, at=now, keys=_keys(found, d))
        if (cap, kb) != (_sent.get("caption"), _sent.get("kb")):
            if telegram.tg("editMessageCaption", chat_id=board["chat"], message_id=board["msg"],
                           caption=cap, reply_markup=json.dumps(kb or {"inline_keyboard": []})):
                _sent.update(caption=cap, kb=kb)


def _send(rec: dict, chat: int, found: list, d: dict, body: dict, cap: str, kb: "dict | None", now: float) -> None:
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
    _sent.update(data=body, at=now, caption=cap, kb=kb, keys=_keys(found, d))
    telegram.tg("pinChatMessage", chat_id=chat, message_id=msg["message_id"], disable_notification="true")


def _keys(found: list, d: dict) -> dict:
    """The requests a Stop may send, as the board was last sent: s:<key> on running rows,
    w:<key> on work-run rows."""
    act = {r["k"]: {"r": "s", "w": "w"}.get(r["c"]) for r in d["rows"]}
    return {f"{act[r['sid'][:8]]}:{r['sid'][:8]}": r["sid"] for r in found if act.get(r["sid"][:8])}


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
    req = str(q.get("data") or "")
    sid = (_sent.get("keys") or {}).get(req)
    if not sid:
        return "no"
    if req.startswith("w:"):            # what /work stop does: the run pauses, its turns stop
        root, _, run = _managed_run(sid)
        if not run:
            return "gone"
        workrun._stop(root, run)
        return "ok"
    job = runner.live_job(sid)
    return "ok" if job and job.interrupt() else "gone"


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
