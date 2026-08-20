"""Weekly overview: which projects got worked on and what each one took.

Read-side only, like attribution: every number is already in sessions/turns by
the time anyone asks, so a report is two GROUP BYs, not a pipeline. Grouped per
project because that is the question a week answers — where did the time go —
with a per-day strip for rhythm and last week's totals for the delta.

Time and tokens, never dollars: 9f612a4 removed the dollar readouts because the
CLI prices subscription runs at API list rate, and a weekly invoice in made-up
dollars would be the most confidently wrong line in the product.

Delivered as a Monday-morning Telegram push plus on-demand reads (/report, the
dashboard's /local/report). The push must survive the machine being off at the
appointed hour — this bridge lives on a laptop under WSL — so due-ness is a pure
function of (now, last-sent marker) checked at boot, and one re-armed
threading.Timer covers the running case, the same posture as limits.py.
"""

import logging
import threading
import time
from datetime import datetime, time as dtime, timedelta

from bridge import store

log = logging.getLogger("bridge.report")

PUSH_HOUR = 9   # ponytail: Monday 09:00 local, fixed; a config knob when someone asks
_SENT_KEY = "weekly_report_sent"   # settings: week-start epoch of the last pushed week

_TOK_COLS = (("in", "tok_in"), ("out", "tok_out"),
             ("cache_w", "tok_cache_w"), ("cache_r", "tok_cache_r"))

_timer: "threading.Timer | None" = None


# --- window math --------------------------------------------------------------

def week_bounds(now: float, back: int = 0) -> tuple[float, float]:
    """[Monday 00:00, next Monday 00:00) local time, `back` weeks ago. Date
    arithmetic rather than hour arithmetic, so a DST edge can't shift a boundary."""
    d = datetime.fromtimestamp(now)
    monday = d.date() - timedelta(days=d.weekday(), weeks=back)
    return (datetime.combine(monday, dtime.min).timestamp(),
            datetime.combine(monday + timedelta(days=7), dtime.min).timestamp())


def _monday_fire(week_start: float) -> float:
    return datetime.combine(datetime.fromtimestamp(week_start).date(),
                            dtime(PUSH_HOUR)).timestamp()


def pending_week(now: float, last_sent: "float | None") -> "float | None":
    """Week-start of the completed week a push still owes, or None. Due from
    Monday PUSH_HOUR onward — and a boot on Wednesday after a dark Monday is
    still due, which is the whole reason this is time math and not a cron."""
    if now < _monday_fire(week_bounds(now)[0]):
        return None
    prev_since = week_bounds(now, back=1)[0]
    if last_sent is not None and last_sent >= prev_since:
        return None
    return prev_since


# --- aggregation --------------------------------------------------------------

def _totals(rows: list[dict]) -> dict:
    tokens = None
    if any(r[c] is not None for r in rows for _, c in _TOK_COLS):
        tokens = {k: sum(r[c] or 0 for r in rows) for k, c in _TOK_COLS}
    return {"sessions": sum(r["sessions"] for r in rows),
            "turns": sum(r["turns"] for r in rows),
            "elapsed": sum(r["elapsed"] for r in rows),
            "tokens": tokens}


def weekly(chat_id: int, now: "float | None" = None, back: int = 0) -> dict:
    """One chat's week, grouped by project, busiest first. `back=1` is the
    completed week (what the Monday push sends); default is the running one."""
    now = time.time() if now is None else now
    since, until = week_bounds(now, back)
    rows = store.week_by_project(chat_id, since, until)
    prev = _totals(store.week_by_project(chat_id, *week_bounds(now, back + 1)))
    return {
        "since": since,
        "until": until,
        "projects": [{
            "project": r["project"],
            "sessions": r["sessions"],
            "turns": r["turns"],
            "elapsed": r["elapsed"],
            "models": r["models"],
            "tokens": (None if all(r[c] is None for _, c in _TOK_COLS)
                       else sum(r[c] or 0 for _, c in _TOK_COLS)),
        } for r in rows],
        "totals": _totals(rows),
        "days": store.week_by_day(chat_id, since, until),
        "prev": {"turns": prev["turns"], "elapsed": prev["elapsed"],
                 "tokens": prev["tokens"] and sum(prev["tokens"].values())},
    }


# --- rendering (markdown) -----------------------------------------------------

def _dur(s: float) -> str:
    if s < 60:
        return f"{int(s)}s"
    if s < 5400:
        return f"{round(s / 60)}m"
    return f"{s / 3600:.1f}h"


def _kilo(n: float) -> str:
    for cut, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if n >= cut:
            return f"{n / cut:.1f}{suffix}"
    return f"{int(n)}"


def _pct(cur: float, prev: float) -> str:
    n = round(100 * (cur - prev) / prev)
    return f"+{n}%" if n >= 0 else f"−{abs(n)}%"


def _n(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def short_name(project: str) -> str:
    """Last two path segments — a bare basename like "app" says nothing when
    every repo has an app/ in it."""
    parts = [p for p in project.split("/") if p]
    return "/".join(parts[-2:]) if parts else project


def render(rep: dict) -> str:
    """The report as one markdown message. Markdown, not the HTML Telegram
    renders: everything routes through telegram.send, which runs _md_to_html
    and escapes < and > — pre-baked tags arrive as literal "<b>". Project
    basenames, not full paths — the phone column is narrow and the base dir is
    always the same."""
    a = datetime.fromtimestamp(rep["since"])
    b = datetime.fromtimestamp(rep["until"]) - timedelta(days=1)
    head = f"📊 **Week {a:%b %-d} – {b:%b %-d}**"
    t, prev = rep["totals"], rep["prev"]
    if not rep["projects"]:
        return head + "\nNothing ran this week."

    lines = [head,
             f"{_n(t['sessions'], 'session')} · {_n(t['turns'], 'turn')} · {_dur(t['elapsed'])}"]
    if prev["turns"]:
        lines[-1] += (f"   (vs last wk: {_pct(t['turns'], prev['turns'])} turns"
                      + (f" · {_pct(t['elapsed'], prev['elapsed'])} time"
                         if prev["elapsed"] else "") + ")")
    if t["tokens"]:
        tok = t["tokens"]
        lines.append(f"tokens: {_kilo(tok['in'])} in · {_kilo(tok['out'])} out · "
                     f"{_kilo(tok['cache_r'] + tok['cache_w'])} cache")
    lines.append("")
    for p in rep["projects"]:
        name = short_name(p["project"])
        bits = [_n(p["sessions"], "session"), _n(p["turns"], "turn"), _dur(p["elapsed"])]
        if p["tokens"] is not None:
            bits.append(f"{_kilo(p['tokens'])} tok")
        models = ", ".join(m.removeprefix("claude-") for m in p["models"])
        lines.append(f"**{name}** — {' · '.join(bits)}"
                     + (f"\n      {models}" if models else ""))
    if rep["days"]:
        busy = max(rep["days"], key=lambda d: d["elapsed"])
        day = datetime.strptime(busy["day"], "%Y-%m-%d")
        lines += ["", f"busiest day: {day:%a} ({_dur(busy['elapsed'])})"]
    return "\n".join(lines)


# --- the Monday push ----------------------------------------------------------

def _push_due() -> None:
    raw = store.get_setting(_SENT_KEY)
    due = pending_week(time.time(), float(raw) if raw else None)
    if due is None:
        return
    # Lazy imports: the report itself is pure DB; only the push needs a bot.
    from bridge import config
    from bridge.telegram import send
    for chat in config.ALLOWED_CHAT_IDS:
        send(chat, render(weekly(chat, back=1)))
    store.set_setting(_SENT_KEY, str(due))
    log.info("weekly report pushed for week starting %s", due)


def _tick() -> None:
    global _timer
    try:
        _push_due()
    except Exception:  # noqa: BLE001 — a readout must never take the bridge down
        log.warning("weekly report push failed", exc_info=True)
    now = time.time()
    nxt = _monday_fire(week_bounds(now)[0])
    if now >= nxt:  # this week's slot has passed (or just fired) — next Monday's
        nxt = _monday_fire(week_bounds(now)[1])
    _timer = threading.Timer(max(60.0, nxt - now), _tick)
    _timer.daemon = True
    _timer.start()


def boot() -> None:
    """Arm the push; sends immediately whatever a downtime skipped."""
    _tick()
