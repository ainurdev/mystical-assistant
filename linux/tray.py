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
import subprocess
import sys
import threading
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
        # Native (VS Code, terminal) sessions read `working` only within 3 s of a
        # transcript write, so their every long tool call would look done.
        if (st.get("state") == "working" and st.get("source") != "native"
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
    """GET a JSON path off the dashboard, or None when it doesn't answer. On
    127.0.0.1, the address the bridge binds: `localhost` can try ::1 first.
    Windows still open on localhost (session_url), the installed app's origin."""
    try:
        with _HTTP.open(f"http://127.0.0.1:{port}{path}", timeout=3) as r:
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


def open_url(url: str, browser: str | None, profile: str | None) -> None:
    """In the installed window's browser and profile, as an app window; the
    desktop's default browser when there's no Chromium-family one."""
    argv = ([browser, *([f"--profile-directory={profile}"] if profile else []),
             f"--app={url}"] if browser else ["xdg-open", url])
    subprocess.Popen(argv, start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run_mystical(cmd: str) -> tuple[int, str]:
    """bin/mystical start|stop|restart through a login+interactive shell — the
    PATH your terminal has (nvm's npm, for a stale bundle), not the desktop
    session's. (exit code, the output's last lines)."""
    p = subprocess.run(["bash", "-lic", f"'{REPO}/bin/mystical' {cmd}"],
                       stdin=subprocess.DEVNULL, capture_output=True, text=True)
    return p.returncode, "\n".join((p.stdout + p.stderr).strip().splitlines()[-12:])


class Tray:
    """The icon, its menu and its alerts. Every GTK call happens on the main
    loop's thread; HTTP and bridge commands run on worker threads and hand
    their results back through GLib.idle_add."""

    def __init__(self, a, AppIndicator, GLib, Gtk, Notify):
        self.a, self.GLib, self.Gtk, self.Notify = a, GLib, Gtk, Notify
        self.prev, self.titles, self.rows = None, {}, []
        self.up, self.busy, self.shown = False, None, None
        self.notes = {}                   # session id -> its one Notify.Notification
        self.icon = ICON if os.path.isfile(ICON) else "dialog-information"
        Notify.init("mystical")
        self.ind = AppIndicator.Indicator.new(
            "mystical-tray", self.icon, AppIndicator.IndicatorCategory.APPLICATION_STATUS)
        self.ind.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.ind.set_title("mystical")
        self.render()
        self.poll()
        GLib.timeout_add_seconds(POLL_S, self.poll)

    def poll(self):
        def work():
            running = fetch(self.a.port, "/local/running")
            self.GLib.idle_add(self.landed, running)
        threading.Thread(target=work, daemon=True).start()
        return True                       # keep the 4 s timer

    def landed(self, running):
        news, self.prev, self.rows = step(self.prev, running, self.titles)
        self.up = running is not None
        for n in news:
            self.notify(n)
        self.render()
        return False                      # idle_add: once

    def notify(self, n):
        # One per session, updated in place: a chatty session replaces its own
        # alert instead of stacking a column of them.
        note = self.notes.get(n["id"])
        if note is None:
            note = self.Notify.Notification.new(n["title"], n["body"], self.icon)
            note.add_action("default", "Open", lambda _n, _a, sid: self.open(sid), n["id"])
            self.notes[n["id"]] = note
        else:
            note.update(n["title"], n["body"], self.icon)
        try:
            note.show()
        except self.GLib.Error:
            pass                          # no notification daemon: the menu still says it

    def render(self):
        n = len(self.rows)
        head = self.busy or ("● running" if self.up else "○ stopped")
        if n:
            head += f" · {n} waiting on you"
        if (head, tuple(self.rows)) == self.shown:
            return                        # re-sending an open menu over D-Bus makes it flicker
        self.shown = (head, tuple(self.rows))
        self.ind.set_label(str(n) if n else "", "99")
        Gtk, menu = self.Gtk, self.Gtk.Menu()

        def item(label, on=None, enabled=True):
            it = Gtk.MenuItem(label=label)
            if on:
                it.connect("activate", lambda _w: on())
            it.set_sensitive(bool(on) and enabled)
            menu.append(it)
            return it

        item(head)
        for sid, title in self.rows:
            item(f"    {title}", lambda sid=sid: self.open(sid))
        menu.append(Gtk.SeparatorMenuItem())
        opener = item("Open dashboard", lambda: self.open(None))
        idle = self.busy is None
        item("Start bridge", lambda: self.bridge("start"), idle and not self.up)
        item("Stop bridge", lambda: self.bridge("stop"), idle and self.up)
        item("Restart bridge", lambda: self.bridge("restart"), idle and self.up)
        menu.append(Gtk.SeparatorMenuItem())
        item("Quit tray", Gtk.main_quit)
        menu.show_all()
        self.ind.set_menu(menu)
        # AppIndicator gives a left click to the menu; a middle click opens the
        # dashboard. Only after set_menu: the target must be a child of its menu.
        self.ind.set_secondary_activate_target(opener)

    def open(self, sid):
        def work():
            manifest = fetch(self.a.port, "/manifest.webmanifest") or {}
            open_url(session_url(self.a.port, manifest.get("start_url"), sid),
                     self.a.browser, self.a.profile)
        threading.Thread(target=work, daemon=True).start()

    def bridge(self, cmd):
        self.busy = {"start": "… starting", "stop": "… stopping",
                     "restart": "… restarting"}[cmd]
        self.render()

        def work():
            rc, tail = run_mystical(cmd)
            self.GLib.idle_add(self.ran, cmd, rc, tail)
        threading.Thread(target=work, daemon=True).start()

    def ran(self, cmd, rc, tail):
        self.busy = None
        self.render()
        if rc:
            d = self.Gtk.MessageDialog(message_type=self.Gtk.MessageType.ERROR,
                                       buttons=self.Gtk.ButtonsType.CLOSE,
                                       text=f"mystical {cmd} failed (exit {rc})")
            d.format_secondary_text(tail)
            d.run()
            d.destroy()
        return False


def main(argv=None) -> int:
    a = parser().parse_args(argv)
    why = missing()
    if why:
        print(why, file=sys.stderr)
        return 1
    if a.check:
        return 0
    lock = single_instance()
    if lock is None:
        return 0                          # another tray runs already; one is plenty
    AppIndicator, GLib, Gtk, Notify = bindings()
    # The 4 s timer holds the Tray through its bound poll, so it needs no name.
    Tray(a, AppIndicator, GLib, Gtk, Notify)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
