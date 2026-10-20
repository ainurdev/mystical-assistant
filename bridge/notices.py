"""The notification feed: what happened while you weren't looking.

Every place the bridge pings Telegram also writes one row here (`emit`), and
every surface reads the same rows: the dashboard's bell, its toasts and the OS
banners it raises, the Mac app's menu bar. Before this, Telegram heard ~30
kinds of event and the dashboard 5, each window diffed its own 4 s poll to
guess the rest, and the guess died with the tab — a session that finished with
no dashboard open was never news, and a failed turn banners as "✓ finished"
(docs/superpowers/specs/notifications.md).

Why the bridge keeps it, not the page: the events happen here — a Rivendell job
arrives on a socket, a PR check fails in a poll, a limit parks a turn — whether
or not a dashboard is open, and Telegram has to obey the same per-event choices
the dashboard shows. One table, kept a week; a client groups rows by subject.

NEEDS YOU is not stored. It is live state — a card waiting in a session, an
offered Rivendell job still held, a session whose newest word is "log in" — so
`needs()` reads it fresh off the status map and the queue each time. Answering
anywhere (the card, a Mac banner, Telegram, the PLUGINS queue) changes that
state, so nothing has to remember to resolve a row.

Not built: per-project mutes, snoozing a row, and pushing rows to clients (the
dashboard already polls every 4 s). Best-effort throughout: a feed write or a
routing read never raises into a run, a worker or a request.
"""

import json
import re
import sys
import time
from datetime import datetime

from bridge import config, store

KEEP_S = 7 * 86400
LIMIT = 200
# Mystical's own changelog (bridge/whatsnew.py): read by the right rail's changelog,
# not the bell, and kept past the week — a few rows a day, so never pruned.
# shortcut: unbounded, fine at a few rows a day; prune by count if it ever reaches thousands
CHANGELOG = ("updated", "note")
_KEY = "notify_prefs"

# kind -> (group, tier, source). The group is the row on Settings ▸ NOTIFY.
CATALOG = {
    "approve": ("ask", "needs", "session"),
    "question": ("ask", "needs", "session"),
    "login": ("account", "needs", "session"),
    "limit_choice": ("account", "needs", "session"),
    "rv_offer": ("rv_offer", "needs", "rivendell"),
    "done": ("done", "news", "session"),
    "failed": ("failed", "news", "session"),
    "parked": ("parked", "news", "session"),
    "resumed": ("resumed", "fyi", "session"),
    "retrying": ("resumed", "fyi", "session"),
    "waiting": ("resumed", "fyi", "session"),
    "started": ("started", "fyi", "session"),
    "rv_started": ("started", "fyi", "rivendell"),
    "rv_ended": ("started", "fyi", "rivendell"),    # a teammate's device run ending (device_side)
    "rv_held": ("rv_held", "fyi", "rivendell"),
    "rv_dismissed": ("rv_held", "fyi", "rivendell"),
    "rv_done": ("rv_done", "news", "rivendell"),
    "rv_brief": ("rv_brief", "news", "rivendell"),
    "rv_failed": ("rv_failed", "news", "rivendell"),
    "rv_refused": ("rv_failed", "news", "rivendell"),
    "rv_link": ("rv_link", "news", "rivendell"),
    "rv_link_back": ("resumed", "fyi", "rivendell"),
    "team_in": ("team", "news", "team"),     # a teammate sent you a session, a picture or a file (team.py)
    "pr_failing": ("pr", "news", "pr"),
    "pr_changes": ("pr", "news", "pr"),
    "move_done": ("bridge", "news", "bridge"),
    "move_failed": ("bridge", "news", "bridge"),
    "weekly": ("weekly", "fyi", "bridge"),
    "updated": ("updates", "news", "bridge"),
    "note": ("updates", "news", "bridge"),
}

# The one place the copy lives: the dashboard and the Mac app render `verb`.
VERBS = {
    "approve": "APPROVE", "question": "QUESTION", "login": "SIGN IN",
    "limit_choice": "LIMIT", "rv_offer": "OFFERED", "done": "DONE", "failed": "FAILED",
    "parked": "PARKED", "resumed": "RESUMED", "retrying": "RETRYING", "waiting": "WAITING",
    "started": "STARTED", "rv_started": "STARTED", "rv_ended": "ENDED",
    "rv_held": "HELD", "rv_dismissed": "DISMISSED", "rv_done": "DONE", "rv_failed": "FAILED",
    "rv_refused": "REFUSED", "rv_link": "LINK DOWN", "rv_link_back": "LINK BACK",
    "rv_brief": "BRIEF READY", "team_in": "SENT YOU",
    "pr_failing": "CHECKS FAILING", "pr_changes": "CHANGES ASKED", "move_done": "MOVED",
    "move_failed": "MOVE FAILED", "weekly": "WEEKLY REPORT",
    "updated": "UPDATED", "note": "NOTE",
}
_RV_DONE = {"review": "REVIEWED", "impl": "IMPLEMENTED"}

# group -> what interrupts you. The spec's defaults: today's behaviour, except
# that "started elsewhere" stops popping up and Telegram waits until you're away,
# and what the bridge got past by itself (a resume, an API retry, a link back,
# your own Wait) only lands in the bell: the run's DONE or FAILED is the news. A
# meeting's brief that is ready is the exception to waiting: it is wanted before
# its meeting, so Telegram gets it whether or not you are at a dashboard.
DEFAULTS = {
    "ask": {"pop": True, "sound": "ping", "tg": "away"},
    "rv_offer": {"pop": True, "sound": "ping", "tg": "away"},
    "account": {"pop": True, "sound": "knock", "tg": "always"},
    "done": {"pop": True, "sound": "chime", "tg": "away"},
    "failed": {"pop": True, "sound": "knock", "tg": "away"},
    "parked": {"pop": True, "sound": "none", "tg": "away"},
    "resumed": {"pop": False, "sound": "none", "tg": "off"},
    "started": {"pop": False, "sound": "none", "tg": "off"},
    "rv_held": {"pop": False, "sound": "none", "tg": "away"},
    "rv_done": {"pop": True, "sound": "chime", "tg": "away"},
    "rv_brief": {"pop": True, "sound": "chime", "tg": "always"},
    "rv_failed": {"pop": True, "sound": "knock", "tg": "away"},
    "rv_link": {"pop": True, "sound": "none", "tg": "always"},
    "team": {"pop": True, "sound": "blip", "tg": "away"},
    "pr": {"pop": True, "sound": "blip", "tg": "away"},
    "bridge": {"pop": True, "sound": "none", "tg": "off"},
    "weekly": {"pop": False, "sound": "none", "tg": "always"},
    "updates": {"pop": True, "sound": "none", "tg": "off"},
}
SOUNDS = ("blip", "chime", "ping", "knock", "none")
ROUTES = ("off", "away", "always")
_QUIET = {"on": False, "from": "22:00", "to": "09:00", "needs": True}
_AWAY_MIN = 5
_HHMM = re.compile(r"([01]\d|2[0-3]):[0-5]\d")

# The newest click or keypress any dashboard page reported (/local/running?seen=).
_last_seen = float("-inf")


def verb(kind: str, meta: "dict | None" = None) -> str:
    if kind == "rv_done":
        return _RV_DONE.get((meta or {}).get("job_kind"), "DONE")
    return VERBS.get(kind, kind.upper())


def emit(kind: str, subject: str, *, title: str = "", body: str = "",
         meta: "dict | None" = None) -> "int | None":
    """Record one event. A session's title is read when the feed is, not here:
    it is often still being named when its first turn ends."""
    if kind not in CATALOG or not subject:
        return None
    try:
        store.prune_notices(time.time() - KEEP_S, keep=CHANGELOG)
        return store.add_notice(kind, str(subject), str(title or "")[:200],
                                str(body or "")[:600], dict(meta or {}))
    except Exception as e:  # noqa: BLE001 — the event happened either way
        print(f"[notices] {kind} not recorded: {e}", file=sys.stderr)
        return None


def _row(r: dict, sessions: dict) -> dict:
    group, tier, source = CATALOG.get(r["kind"], ("bridge", "fyi", "bridge"))
    meta, title = dict(r["meta"]), r["title"]
    if not title:
        sid = r["subject"]
        if sid not in sessions:
            sessions[sid] = store.get_session(sid)
        if (sess := sessions[sid]):
            title = sess.get("title") or "session"
            meta.setdefault("project", sess.get("project"))
            meta.setdefault("session_id", sid)
    return {"id": r["id"], "at": r["at"], "kind": r["kind"], "verb": verb(r["kind"], meta),
            "group": group, "tier": tier, "source": source, "subject": r["subject"],
            "title": title, "body": r["body"], "meta": meta, "read": r["read_at"] is not None}


def feed() -> list:
    """The newest LIMIT rows of the last week, newest first."""
    sessions: dict = {}
    return [_row(r, sessions) for r in store.list_notices(time.time() - KEEP_S, LIMIT)]


def changelog() -> list:
    """The newest 50 updates and notes, however old: the feed's week and its 200
    rows (a busy day fills them) would lose this morning's update by tonight."""
    return [_row(r, {}) for r in store.list_notices(0, 50, CHANGELOG)]


def mark_read(ids: "list | None") -> int:
    if ids is not None:
        ids = [i for i in ids if isinstance(i, int) and not isinstance(i, bool)]
    return store.mark_notices_read(ids)


# --- prefs ----------------------------------------------------------------------

def _merge(base: dict, patch: dict) -> dict:
    """`patch` over `base`, keeping only known groups and allowed values, so a
    stale client or a hand-edited row can't put a value the routing can't read."""
    out = {"events": {g: dict(v) for g, v in base["events"].items()},
           "quiet": dict(base["quiet"]), "away_min": base["away_min"]}
    ev = patch.get("events")
    for g, v in (ev.items() if isinstance(ev, dict) else ()):
        if g in out["events"] and isinstance(v, dict):
            cur = out["events"][g]
            if isinstance(v.get("pop"), bool):
                cur["pop"] = v["pop"]
            if v.get("sound") in SOUNDS:
                cur["sound"] = v["sound"]
            if v.get("tg") in ROUTES:
                cur["tg"] = v["tg"]
    q = patch.get("quiet")
    if isinstance(q, dict):
        for k in ("on", "needs"):
            if isinstance(q.get(k), bool):
                out["quiet"][k] = q[k]
        for k in ("from", "to"):
            if isinstance(q.get(k), str) and _HHMM.fullmatch(q[k]):
                out["quiet"][k] = q[k]
    a = patch.get("away_min")
    if isinstance(a, int) and not isinstance(a, bool) and 1 <= a <= 120:
        out["away_min"] = a
    return out


def _defaults() -> dict:
    return {"events": {g: dict(v) for g, v in DEFAULTS.items()}, "quiet": dict(_QUIET),
            "away_min": _AWAY_MIN}


def prefs() -> dict:
    try:
        raw = json.loads(store.get_setting(_KEY) or "{}")
    except (ValueError, TypeError):
        raw = {}
    return _merge(_defaults(), raw if isinstance(raw, dict) else {})


def set_prefs(patch: dict) -> dict:
    p = _merge(prefs(), patch if isinstance(patch, dict) else {})
    store.set_setting(_KEY, json.dumps(p))
    return p


# --- routing ----------------------------------------------------------------------

def seen(ts: float) -> None:
    """A dashboard page's last click or keypress. Only ever moves forward, and a
    clock far in the future is ignored rather than pinning "here" forever."""
    global _last_seen
    if ts <= time.time() + 60:
        _last_seen = max(_last_seen, ts)


def away(now: "float | None" = None, p: "dict | None" = None) -> bool:
    return (now or time.time()) - _last_seen > (p or prefs())["away_min"] * 60


def quiet(now: "datetime | None" = None, p: "dict | None" = None) -> bool:
    q = (p or prefs())["quiet"]
    if not q["on"]:
        return False
    t, a, b = (now or datetime.now()).strftime("%H:%M"), q["from"], q["to"]
    return a <= t < b if a <= b else (t >= a or t < b)


def telegram_ok(kind: str, now: "float | None" = None) -> bool:
    """Whether this event goes to Telegram: its group's route, quiet hours (which
    a NEEDS YOU may pass), and NOTIFY_ENABLE over all of it. A prefs read that
    fails pings anyway — that was the behaviour before there were prefs."""
    if not config.NOTIFY_ENABLE or kind not in CATALOG:
        return False
    group, tier, _ = CATALOG[kind]
    try:
        p = prefs()
        route = p["events"][group]["tg"]
        if route == "off":
            return False
        if quiet(None, p) and not (tier == "needs" and p["quiet"]["needs"]):
            return False
        return route == "always" or away(now, p)
    except Exception as e:  # noqa: BLE001
        print(f"[notices] routing read failed, pinging: {e}", file=sys.stderr)
        return True


def echo(kind: str, subject: str, within: float = 60) -> bool:
    """A FAILED or PARKED right behind a sign-in or limit ask for the same session
    is that ask's own news: a dead login ends its turn, a limit card parks it. The
    bell keeps the row, but the ask already knocked once."""
    if kind not in ("failed", "parked"):
        return False
    try:
        rows = store.list_notices(time.time() - within, LIMIT)
    except Exception:  # noqa: BLE001
        return False
    return any(r["subject"] == subject and r["kind"] in ("login", "limit_choice") for r in rows)


# --- NEEDS YOU --------------------------------------------------------------------

_STATUS_KIND = {"permission": "approve", "question": "question"}


def _need(kind: str, subject: str, session_id: "str | None", title: str, body: str,
          at: "float | None", meta: dict) -> dict:
    return {"subject": subject, "kind": kind, "verb": verb(kind, meta), "title": title,
            "body": body, "at": at, "session_id": session_id, "meta": meta}


def needs(status: dict) -> list:
    """Everything waiting on you right now, newest first: sessions blocked on a
    card or a question (the status map), teammates' Rivendell jobs still held for
    a tap, and sessions whose newest notice asks you to sign in or pick a limit
    route. The feed only lends the detail — the card's command, the question."""
    try:
        rows = store.list_notices(time.time() - KEEP_S, LIMIT)
    except Exception:  # noqa: BLE001
        rows = []
    newest, of_kind = {}, {}
    for r in rows:
        of_kind.setdefault((r["subject"], r["kind"]), r)
        # A dead login also ends its turn ("failed") and a limit card parks it;
        # neither answers the ask, so neither can stand in for the newest word.
        if r["kind"] not in ("failed", "parked"):
            newest.setdefault(r["subject"], r)
    out = []
    for sid, st in (status or {}).items():
        if st.get("state") != "awaiting":
            continue
        kind = _STATUS_KIND.get(st.get("kind"), "question")
        r = of_kind.get((sid, kind))
        sess = store.get_session(sid) or {}
        out.append(_need(kind, sid, sid, sess.get("title") or "",
                         (r or {}).get("body") or st.get("label") or "",
                         (r or {}).get("at"), {"project": sess.get("project"), **((r or {}).get("meta") or {})}))
    # Both answer themselves off live state too: a sign-in clears every session
    # its dead login stopped (runner._auth_dead is per slot), and a limit card
    # is only a question while its session is still parked.
    from bridge import runner                     # local import: runner imports this
    dead = set(runner._auth_dead)
    for sid, r in newest.items():
        if (status or {}).get(sid, {}).get("state") in ("awaiting", "working"):
            continue                              # running again: it was answered
        if r["kind"] == "login" and r["meta"].get("slot") not in dead:
            continue
        if r["kind"] == "limit_choice" and (status or {}).get(sid, {}).get("state") != "parked":
            continue
        if r["kind"] not in ("login", "limit_choice"):
            continue
        sess = store.get_session(sid) or {}
        out.append(_need(r["kind"], sid, sid, sess.get("title") or r["title"],
                         r["body"], r["at"], {"project": sess.get("project"), **r["meta"]}))
    try:
        from bridge import rivendell, rivendell_instances   # local import: rivendell is heavy
        held = rivendell.queue()
        what = rivendell.Worker._KIND_LABEL
        names = {i["id"]: i.get("name") or i["id"] for i in rivendell_instances.instances()} if held else {}
    except Exception:  # noqa: BLE001 — no Rivendell, or a worker mid-restart
        held, what, names = {}, {}, {}
    for wid, items in held.items():
        for it in items:
            if not it.get("offered"):
                continue
            out.append(_need(
                "rv_offer", f"rv:{wid}:{it['request_id']}", None,
                it.get("label") or it.get("slug") or "Rivendell job",
                f"A teammate's {what.get(it['kind'], it['kind'])} job. If you accept, it runs "
                "on this machine with your accounts.",
                it.get("created_at"),
                {"instance_id": wid, "instance": names.get(wid, wid), "key": it["key"],
                 "link": it.get("link"), "job_kind": it["kind"]}))
    out.sort(key=lambda n: -(n["at"] or 0))
    return out
