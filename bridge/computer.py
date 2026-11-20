"""Computer use: a chat sees and drives this Mac's desktop, approved per app.

Why our own: Claude Code wires its computer-use server only into interactive
sessions, refuses the name `computer-use` in --mcp-config, and its standalone
server answers "not wired to a session". Every Mystical turn is `claude -p`. And
even if it were wired, a bridge child has no Screen Recording or Accessibility:
macOS grants those per app, and the child belongs to the bridge's launchd job.
Mystical.app can hold both, so the app does the seeing and the clicking.

Three parts, and all authority lives in this one:
  - bridge/computer_mcp.py, the session's stdio MCP server, knows nothing. Each
    call goes to POST /local/computer/call with the dashboard token and the
    claude session id the bridge handed it.
  - this module, in the bridge process, owns the grant (which apps a chat may
    drive), the one desktop lock, the Allow card and the queue of orders.
  - Mystical.app pulls orders over POST /local/computer/app with the same token
    (macos/Sources/Mystical/ComputerUse.swift). It opens no listener, so only
    the bridge can give it input orders. Screenshots on the old distributed
    notification (Capture.swift) are a different, read-only path.

The ask is once per app per chat (Claude's own request_access shape), and goes
through the gateway's card (gateway._card), not Claude's permission prompt, so
Bypass mode can't skip it. A FULL app may be seen, clicked and typed into. A LOOK
app (terminals, editors, settings, Mystical itself) is only seen: typing there
runs code, or approves this very chat's cards.

Stop is total: from the chat's STOP, Esc on the Mac or the menu bar. It drops the
grant, frees the lock and interrupts the turn. The lock also goes when the
holder's turn ends, so a dead turn can never keep the desktop.

Not built: switch_display (the main display only), an "Allow Mail" button on the
not-granted error (Claude asks again with request_access), and per-action asks
(decided against on 2026-11-21: once per app).
"""

import queue
import sys
import threading
import time
import uuid

from bridge import store

SETTING = "computer_use:"           # + store session id -> "1" when switched on
APP_STALE = 30                      # s without a pull and the app counts as gone
PULL_WAIT = 20                      # s an app pull waits for an order
ORDER_TIMEOUT = 30                  # s for the app to do one order (plus any wait it asks for)

# Typing here runs code, or answers this chat's own cards: see only.
# shortcut: matched by name, so a renamed app or a variant ("Code - Insiders") gets FULL;
# match bundle ids once someone runs one.
LOOK_ONLY = {"terminal", "iterm", "iterm2", "ghostty", "warp", "alacritty", "kitty", "wezterm",
             "hyper", "visual studio code", "code", "cursor", "windsurf", "zed", "xcode",
             "script editor", "automator", "shortcuts", "system settings", "system preferences",
             "keychain access", "activity monitor", "mystical"}

# Quit, force-quit, log out, lock, switch app, hide: blocked unless the grant has system keys.
# Written in _chord's spelling; every alias the app accepts folds onto it.
SYSTEM_KEYS = {"cmd+q", "cmd+shift+q", "alt+cmd+esc", "cmd+ctrl+q", "cmd+tab", "cmd+shift+tab",
               "alt+cmd+shift+q", "cmd+h", "alt+cmd+h", "cmd+m"}
_ALIAS = {"command": "cmd", "meta": "cmd", "super": "cmd", "win": "cmd", "option": "alt", "opt": "alt",
          "control": "ctrl", "escape": "esc"}

INPUT = {"left_click", "double_click", "triple_click", "right_click", "middle_click", "type", "key",
         "scroll", "left_click_drag", "mouse_move", "hold_key", "left_mouse_down", "left_mouse_up",
         "open_application"}
SEE = {"screenshot", "zoom", "cursor_position"}
APP_ACTIONS = INPUT | SEE | {"read_clipboard", "write_clipboard"}

_lock = threading.Lock()
_grants: dict = {}                  # sid -> {"apps": [{"name", "tier"}], "clipboard_read", ...}
_holder: "dict | None" = None       # {"sid", "title", "since", "n"}
_orders: "queue.Queue[dict]" = queue.Queue()
_waiting: dict = {}                 # order id -> {"done": Event, "result": dict | None}
_app: dict = {"seen": 0.0, "perms": {}}


# ------- the per-chat switch ----------------------------------------------------

def available() -> bool:
    return sys.platform == "darwin"


def enabled(sid: "str | None") -> bool:
    return bool(sid) and available() and store.get_setting(SETTING + sid) == "1"


def set_enabled(sid: str, on: bool) -> None:
    store.set_setting(SETTING + sid, "1" if on else None)
    if not on:
        stop(sid, "switched off")


def app_online() -> bool:
    return time.time() - _app["seen"] < APP_STALE


def status(sid: str) -> dict:
    """What the Tools row reads (the DRIVING pill reads the turn's computer_state events)."""
    with _lock:
        h = dict(_holder) if _holder else None
        g = _grants.get(sid)
    return {"available": available(), "on": enabled(sid),
            "app": {"online": app_online(), **_app["perms"]},
            "driving": bool(h and h["sid"] == sid),
            "busy_with": h["title"] if h and h["sid"] != sid else None,
            "actions": h["n"] if h and h["sid"] == sid else 0,
            "apps": [a["name"] for a in (g or {}).get("apps", [])]}


# ------- the tool calls -------------------------------------------------------------

def _text(s: str, error: bool = False) -> dict:
    out = {"content": [{"type": "text", "text": s}]}
    if error:
        out["isError"] = True
    return out


def _chord(text: str) -> str:
    """A key chord in one spelling, parts sorted: "Command+Q" and "q+cmd" are one key."""
    parts = (p.strip().lower() for p in text.split("+") if p.strip())
    return "+".join(sorted(_ALIAS.get(p, p) for p in parts))


_SYSTEM = {_chord(k) for k in SYSTEM_KEYS}


def _secs(v, cap: float = 100.0) -> float:
    """A duration from the model, never an exception: junk is 0."""
    try:
        return max(0.0, min(float(v or 0), cap))
    except (TypeError, ValueError):
        return 0.0


def tier(name: str) -> str:
    n = name.strip().lower()
    return "look" if n in LOOK_ONLY or n.rsplit(".", 1)[-1] in LOOK_ONLY else "full"


def call(claude_sid: str, name: str, args: dict) -> dict:
    """One tool call from computer_mcp. The session is the one that spawned the
    server; nothing in `args` can point it at another chat."""
    from bridge import runner
    s = store.get_by_claude_session_id(claude_sid) if claude_sid else None
    if not s:
        return _text("This chat isn't known to Mystical.", error=True)
    sid = s["id"]
    if not enabled(sid):
        return _text("Computer use is switched off for this chat (Tools ▸ Computer use).", error=True)
    job = runner.live_job(sid)
    if name == "request_access":
        return _request_access(s, job, args)
    with _lock:
        g = _grants.get(sid)
    if name == "list_granted_applications":
        if not g:
            return _text("No apps granted yet. Call request_access first.")
        apps = ", ".join(f"{a['name']} ({'see, click, type' if a['tier'] == 'full' else 'see only'})"
                         for a in g["apps"])
        flags = [k for k in ("clipboard_read", "clipboard_write", "system_keys") if g.get(k)]
        return _text(f"Granted: {apps}. Flags: {', '.join(flags) or 'none'}. "
                     "Coordinates are pixels in the most recent screenshot.")
    if name == "wait":
        time.sleep(_secs(args.get("duration")))
        return _text("Waited.")
    if name not in APP_ACTIONS and name != "computer_batch":
        return _text(f"Unknown tool: {name}", error=True)
    if not g:
        return _text("No apps are granted to this chat. Call request_access with the apps you need.",
                     error=True)
    if job is None:
        return _text("No turn is running here.", error=True)
    if why := _refusal(g, name, args):
        return _text(why, error=True)
    if why := _take_lock(s, job):
        return _text(why, error=True)
    return _order(sid, name, args, g)


def _refusal(g: dict, name: str, args: dict) -> "str | None":
    """What the grant doesn't cover, said to Claude. The app checks the front app."""
    if name == "computer_batch":
        acts = args.get("actions")
        if not isinstance(acts, list) or not acts:
            return "actions must be a non-empty list."
        for a in acts:
            n = (a or {}).get("action") if isinstance(a, dict) else None
            if n not in APP_ACTIONS and n != "wait":
                return f"{n!r} can't go in a batch."
            if why := _refusal(g, n, a):
                return why
        return None
    if name == "read_clipboard" and not g.get("clipboard_read"):
        return "Reading the clipboard wasn't granted. Ask again with clipboardRead."
    if name == "write_clipboard" and not g.get("clipboard_write"):
        return "Writing the clipboard wasn't granted. Ask again with clipboardWrite."
    if name in ("key", "hold_key") and not g.get("system_keys"):
        if _chord(str(args.get("text") or "")) in _SYSTEM:
            return f"{args.get('text')} is a system key (quit, switch app, lock). Ask again with systemKeyCombos."
    if name == "open_application" and not _granted_app(g, str(args.get("app") or "")):
        return f"{args.get('app')} isn't one of this chat's apps. Ask for it with request_access first."
    return None


def _granted_app(g: dict, app: str) -> bool:
    a = app.strip().lower()
    return any(x["name"].lower() == a for x in g["apps"])


def _take_lock(s: dict, job) -> "str | None":
    global _holder
    from bridge import runner
    with _lock:
        h = _holder
        if h and h["sid"] != s["id"]:
            live = runner.live_job(h["sid"])
            if live is not None:
                return (f'The desktop is busy: the chat "{h["title"]}" is driving it. Tell the user; '
                        "they can stop that chat, then you can try again.")
        if h and h["sid"] == s["id"]:
            h["n"] += 1
            return None
        _holder = {"sid": s["id"], "title": s.get("title") or "a chat", "since": time.time(), "n": 1,
                   "job": job.id}
        apps = [a["name"] for a in _grants.get(s["id"], {}).get("apps", [])]
    job.add({"type": "computer_state", "state": "driving", "apps": apps})
    threading.Thread(target=_release_when_done, args=(s["id"], job), daemon=True).start()
    return None


def _release_when_done(sid: str, job) -> None:
    """The lock never outlives the turn that took it."""
    job.exited.wait()
    _release(sid, job.id)


def _release(sid: str, job_id: "str | None" = None) -> bool:
    global _holder
    with _lock:
        if not _holder or _holder["sid"] != sid or (job_id and _holder.get("job") != job_id):
            return False
        _holder = None
    _orders.put({"id": uuid.uuid4().hex, "action": "end"})
    return True


def _order(sid: str, name: str, args: dict, g: dict) -> dict:
    if not app_online():
        return _text("Mystical.app isn't running, or is too old for computer use. "
                     "Tell the user to open it (and rebuild it from its menu if it's old).", error=True)
    acts = args.get("actions") if name == "computer_batch" else None
    wait = sum(_secs((a or {}).get("duration")) for a in acts) if acts else _secs(args.get("duration"))
    oid = uuid.uuid4().hex
    done = threading.Event()
    with _lock:
        # Checked and queued under one lock: a Stop between taking the desktop and
        # this order must win, or the order would run after the app's "end".
        if not _holder or _holder["sid"] != sid:
            return _text("The user stopped computer use.", error=True)
        _waiting[oid] = {"done": done, "result": None, "sid": sid}
        _orders.put({"id": oid, "action": name, "args": args, "title": _holder["title"], "sid": sid,
                     "full": [a["name"] for a in g["apps"] if a["tier"] == "full"],
                     "see": [a["name"] for a in g["apps"]]})
    got = done.wait(ORDER_TIMEOUT + min(wait, 200))
    with _lock:
        row = _waiting.pop(oid, None)
    if got and row is None:
        return _text("The user stopped computer use.", error=True)
    if not got or not row or row["result"] is None:
        return _text("Mystical.app didn't answer in time. The action may or may not have happened: "
                     "take a screenshot before going on.", error=True)
    return _content(row["result"])


def _content(r: dict) -> dict:
    """The app's result as MCP content: text first, then any picture."""
    out = []
    if r.get("text"):
        out.append({"type": "text", "text": str(r["text"])})
    for img in r.get("images") or []:
        if isinstance(img, str) and img:
            out.append({"type": "image", "data": img, "mimeType": "image/jpeg"})
    if not out:
        out.append({"type": "text", "text": "Done." if r.get("ok") else "Failed."})
    res = {"content": out}
    if not r.get("ok"):
        res["isError"] = True
    return res


# ------- the Allow card ------------------------------------------------------------

ALLOW = "Allow apps"
DENY = "Deny"
EXTRAS = (("clipboardRead", "Read clipboard", "clipboard_read"),
          ("clipboardWrite", "Write clipboard", "clipboard_write"),
          ("systemKeyCombos", "System keys", "system_keys"))


def card_questions(apps: list, why: str, extras: list) -> list:
    """The card, as AskUserQuestion questions, so every surface can answer it:
    the dashboard draws the `computer` field as its own dock, Telegram and the
    Mini App draw plain options."""
    full = [a["name"] for a in apps if a["tier"] == "full"]
    look = [a["name"] for a in apps if a["tier"] == "look"]
    desc = "; ".join(p for p in (full and f"{', '.join(full)}: see, click, type",
                                 look and f"{', '.join(look)}: see only") if p)
    qs = [{"header": "Computer", "multiSelect": False,
           "question": "Let this chat control these apps on your Mac?" + (f"\n{why}" if why else ""),
           "options": [{"label": ALLOW, "description": desc + ". Until the chat ends or you stop it."},
                       {"label": DENY, "description": "It won't see or touch anything."}],
           "computer": {"apps": apps, "why": why}}]
    if extras:
        qs.append({"header": "Also", "multiSelect": True, "question": "Also allow:",
                   "options": [{"label": lab, "description": ""} for _k, lab, _f in EXTRAS if lab in extras]})
    return qs


def grant_from(apps: list, extras: list, answers: list) -> "dict | None":
    """The grant an answer gives, or None for a no. Unanswered is a no."""
    by = {a.get("header"): (a.get("labels") or []) for a in answers or [] if isinstance(a, dict)}
    if ALLOW not in by.get("Computer", []):
        return None
    ticked = set(by.get("Also", []))
    return {"apps": apps, **{f: (lab in ticked and lab in extras) for _k, lab, f in EXTRAS}}


def _request_access(s: dict, job, args: dict) -> dict:
    from bridge import gateway
    names = [str(a).strip() for a in (args.get("apps") or []) if str(a).strip()][:12]
    if not names:
        return _text("Name at least one app.", error=True)
    if job is None:
        return _text("No turn is running to ask from.", error=True)
    with _lock:
        had = _grants.get(s["id"]) or {"apps": []}
    have = {a["name"].lower() for a in had["apps"]}
    apps = had["apps"] + [{"name": n, "tier": tier(n)} for n in dict.fromkeys(names) if n.lower() not in have]
    extras = [lab for k, lab, f in EXTRAS if args.get(k) and not had.get(f)]
    if len(apps) == len(had["apps"]) and not extras:
        return _text("Those are already granted.")
    why = str(args.get("reason") or "").strip()[:300]

    def on_answer(answers: list) -> str:
        g = grant_from(apps, extras, answers)
        if g is None:
            return "The user denied access. Don't try to control the desktop; carry on another way or ask."
        with _lock:
            # Onto the grant as it is now: another card may have been answered meanwhile.
            now = _grants.get(s["id"]) or {"apps": []}
            names = {a["name"].lower() for a in g["apps"]}
            g["apps"] = g["apps"] + [a for a in now["apps"] if a["name"].lower() not in names]
            for _k, _lab, f in EXTRAS:
                g[f] = g[f] or bool(now.get(f))
            _grants[s["id"]] = g
        look = [a["name"] for a in apps if a["tier"] == "look"]
        return ("Granted: " + ", ".join(a["name"] for a in apps)
                + (f". See only (no clicks or typing): {', '.join(look)}" if look else "")
                + ". Take a screenshot first; coordinates are pixels in the most recent screenshot.")
    return gateway._card(job, s, card_questions(apps, why, extras), on_answer)


# ------- stopping ------------------------------------------------------------------

def stop(sid: str, by: str = "you") -> bool:
    """Drop the grant, free the lock, interrupt the turn. True if anything stopped."""
    from bridge import runner
    with _lock:
        had = _grants.pop(sid, None) is not None
        n = _holder["n"] if _holder and _holder["sid"] == sid else 0
        # Orders not yet done fail now; the app drops them (their id is gone from _waiting).
        for oid in [o for o, row in _waiting.items() if row.get("sid") == sid]:
            row = _waiting.pop(oid)
            row["result"] = {"ok": False, "text": "The user stopped computer use."}
            row["done"].set()
    freed = _release(sid)
    job = runner.live_job(sid)
    if job is not None and (had or freed):
        job.add({"type": "computer_state", "state": "stopped", "by": by, "actions": n})
        if freed:
            job.interrupt()
    return had or freed


def stop_driver(by: str) -> bool:
    """Esc or the menu bar on the Mac: whoever is driving."""
    with _lock:
        sid = _holder["sid"] if _holder else None
    return stop(sid, by) if sid else False


# ------- the app's line ------------------------------------------------------------

def app_exchange(body: dict) -> dict:
    """POST /local/computer/app: the app hands back results and its permissions,
    and gets the next orders (waiting up to PULL_WAIT for one)."""
    _app["seen"] = time.time()
    if isinstance(body.get("perms"), dict):
        _app["perms"] = {k: bool(v) if k != "signed" else str(v)[:80]
                         for k, v in body["perms"].items() if k in ("screen", "accessibility", "signed")}
    for r in body.get("results") or []:
        if not isinstance(r, dict):
            continue
        with _lock:
            row = _waiting.get(str(r.get("id") or ""))
        if row is not None:
            row["result"] = r
            row["done"].set()
    if body.get("stop"):
        # Its own quick request, never a pull: it must not wait, or take another pull's orders.
        stop_driver(str(body["stop"])[:20])
        return {"orders": [], "driving": False}
    out = []
    try:
        out.append(_orders.get(timeout=0 if body.get("results") else PULL_WAIT))
        while len(out) < 8:
            out.append(_orders.get_nowait())
    except queue.Empty:
        pass
    with _lock:
        driving = _holder is not None
    # Orders whose caller already gave up are dropped, never done late.
    return {"orders": [o for o in out if o["action"] == "end" or o["id"] in _waiting],
            "driving": driving}


def _reset_for_tests() -> None:
    global _holder, _orders
    with _lock:
        _grants.clear()
        _waiting.clear()
        _holder = None
        _orders = queue.Queue()
        _app.update(seen=0.0, perms={})

