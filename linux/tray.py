#!/usr/bin/python3
"""The Linux tray companion: Mystical.app's menu bar, on a Linux desktop.

A tray icon beside the installed dashboard window (bridge/startup.py opens that
one): how many sessions are waiting on you, start/stop/restart without a
terminal, and alerts while no dashboard window is open. Its Windows twin is
windows/tray.ps1; the design is docs/superpowers/specs/tray-companion-design.md.

Why it is shaped like this:
- **System python3 + the distro's GTK bindings** (PyGObject, AppIndicator,
  libnotify): nothing to build or pip-install. The bridge's stdlib-only rule is
  about the server; this is a desktop client, and PyGObject is a distro package
  — which is also why startup.py runs it on /usr/bin/python3, not on whatever
  interpreter the bridge uses.
- **It polls GET /local/running every 4 s**, the dashboard's own cadence, and
  alerts on the transitions the dashboard rings for (App.tsx), minus "started".
- **It stays quiet while `watched` is true**: a dashboard page with its own
  alerts on has polled within 90 s, and that page already alerted — with the
  user's sound, and skipping the session they're looking at.
- **No token in its arguments.** Opening a window reads start_url from
  /manifest.webmanifest, so a rotated DASH_TOKEN is picked up on the next open.
- **GTK is imported in bindings()**, so everything here imports on any machine;
  tests/test_tray.py runs the pure functions on a box without GTK.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON = os.path.join(REPO, "bridge", "dashboard", "web", "public", "icon-192.png")
POLL_S = 4
PACKAGES = ("Debian/Ubuntu: sudo apt install gir1.2-ayatanaappindicator3-0.1 "
            "gir1.2-notify-0.7 — Fedora: sudo dnf install "
            "libayatana-appindicator-gtk3 libnotify")
_IN_FLIGHT = ("working", "awaiting", "parked")
# Proxies are for the internet; a system http_proxy must never see localhost.
_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# --- what counts as news (pure; mirrors App.tsx's statusMap effect) -----------
def remember_titles(titles: dict, running: dict) -> dict:
    """Fold jobs[].title into `titles` (the field Running.swift reads). Kept
    across polls: a turn that ends on a question leaves `jobs`, but its title
    was there while it worked."""
    for job in running.get("jobs") or []:
        if job.get("session_id") and job.get("title"):
            titles[job["session_id"]] = job["title"]
    return titles


def alerts(prev: dict | None, cur: dict, titles: dict) -> list[dict]:
    """The alerts one poll brings: [{id, title, body}]. `prev` None is a
    baseline (the first poll, or the first after the bridge came back) —
    nothing that predates it is news."""
    if prev is None:
        return []
    out = []
    for sid, st in cur.items():
        was = (prev.get(sid) or {}).get("state")
        name = titles.get(sid) or st.get("label") or "session"
        if st.get("state") == "awaiting" and was != "awaiting":
            out.append({"id": sid, "title": f"⏸ {name}",
                        "body": st.get("label") or "waiting on you"})
        elif st.get("state") == "parked" and was != "parked":
            out.append({"id": sid, "title": f"⏳ {name}",
                        "body": st.get("label") or "parked"})
    for sid, st in prev.items():
        if (st.get("state") == "working"
                and (cur.get(sid) or {}).get("state") not in _IN_FLIGHT):
            # Not the label: a working session's label is its activity, and
            # "✓ running Bash" reads as if Bash were what finished.
            out.append({"id": sid, "title": f"✓ {titles.get(sid) or 'session'}",
                        "body": "finished"})
    return out


def waiting(status: dict, titles: dict) -> list[tuple[str, str]]:
    """(session id, title) for each session blocked on you, by title: the menu's rows."""
    rows = [(sid, titles.get(sid) or st.get("label") or "waiting on you")
            for sid, st in status.items() if st.get("state") == "awaiting"]
    return sorted(rows, key=lambda r: (r[1], r[0]))


def step(prev: dict | None, running: dict | None, titles: dict):
    """Fold one poll in: (alerts to show, the map the next poll diffs against,
    the waiting rows). `running` None = the bridge didn't answer, so the next
    answer is a fresh baseline. While `watched` the state still moves on —
    nothing replays once the dashboard window closes — but nothing alerts."""
    if running is None:
        return [], None, []
    status = running.get("status") or {}
    remember_titles(titles, running)
    news = [] if running.get("watched") else alerts(prev, status, titles)
    return news, status, waiting(status, titles)


def session_url(port: int, start_url: str | None, sid: str | None = None) -> str:
    """What a window opens: localhost (the installed app's origin, so it shares
    its storage), the manifest's query (the token, when DASH_TOKEN is set), then
    the session to open, skipping the intro a click doesn't want."""
    parts = [q for q in [(start_url or "").partition("?")[2]] if q]
    if sid:
        parts += [f"s={urllib.parse.quote(sid, safe='')}", "skipboot"]
    return f"http://localhost:{port}/" + ("?" + "&".join(parts) if parts else "")


# --- the edges: HTTP, the lock, the bindings ----------------------------------
def fetch(port: int, path: str) -> dict | None:
    """GET a JSON path off the dashboard, or None when it doesn't answer."""
    try:
        with _HTTP.open(f"http://localhost:{port}{path}", timeout=3) as r:
            return json.load(r)
    except (OSError, ValueError):
        return None


def single_instance():
    """The lock file, held for as long as this tray runs — or None when another
    tray holds it (the autostart entry and `mystical app` can both fire)."""
    run = os.environ.get("XDG_RUNTIME_DIR") or f"/tmp/mystical-{os.getuid()}"
    os.makedirs(run, exist_ok=True)
    f = open(os.path.join(run, "mystical-tray.lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def bindings():
    """(AppIndicator, GLib, Gtk, Notify), or ImportError/ValueError naming what
    is missing. Ayatana first (Debian, Ubuntu and Fedora ship it), the original
    AppIndicator3 where that's all there is."""
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Notify", "0.7")
    try:
        gi.require_version("AyatanaAppIndicator3", "0.1")
        from gi.repository import AyatanaAppIndicator3 as AppIndicator
    except (ValueError, ImportError):
        gi.require_version("AppIndicator3", "0.1")
        from gi.repository import AppIndicator3 as AppIndicator
    from gi.repository import GLib, Gtk, Notify
    return AppIndicator, GLib, Gtk, Notify


def missing() -> str | None:
    """None when the GTK bindings import; else the line saying what to install
    (shown by `mystical app` and `mystical doctor`, through --check)."""
    try:
        bindings()
    except (ImportError, ValueError) as e:
        return f"mystical tray: the GTK bindings are missing ({e}). {PACKAGES}"
    return None


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="tray.py", description="mystical//assistant tray icon")
    p.add_argument("--port", type=int, default=8790, help="the dashboard's port")
    p.add_argument("--browser", help="the Chromium-family browser windows open in")
    p.add_argument("--profile", help="its --profile-directory")
    p.add_argument("--check", action="store_true",
                   help="exit 0 if the GTK bindings import, else name the packages")
    return p
