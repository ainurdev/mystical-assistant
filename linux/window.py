#!/usr/bin/python3
"""Mystical's window on a Linux desktop: the dashboard in a WebKitGTK view.

Mystical.app's and Mystical.exe's twin for Linux (macos/, windows/app/). It
replaced the Chrome --app window / installed PWA as what `mystical app` puts in
the app launcher, for one reason: a Chrome window opens every link in Chrome.
Here a link that leaves the dashboard goes to the desktop's own opener
(Gio.AppInfo.launch_default_for_uri, KDE's and GNOME's alike), so it lands in
the browser you chose. The PWA still works for whoever installs it.

Why it is shaped like this:
- **System python3 + the distro's GTK 3 and WebKitGTK 4.1** (PyGObject), the
  same footing as linux/tray.py: nothing to build or pip-install. A WebKit view
  is one web engine, not a second browser (Electron's cost), and still the real
  thing: notifications, storage, clipboard, file picker, downloads.
- **No title bar.** The window keeps GTK's client-side frame (shadow, resize
  edges) with an empty title bar, and the page is the bar: the user agent says
  MysticalLinux/, lib/mac.ts's isLinuxApp() sees it, and the HUD's caps drag
  the window and draw min/max/close (lib/wco.ts, index.css's data-wco). They
  talk back over one script message handler, `mysticalLinux`. --decorated
  keeps the desktop's own title bar instead.
- **Links** follow the Mac app's URLPolicy (macos/.../URLPolicy.swift) where
  WebKitGTK lets them: the dashboard's own origin stays in the view, and any
  new window (target=_blank, window.open) goes to the desktop's opener. WebKitGTK
  doesn't say which frame a navigation is in, so the Mac's "an iframe loads
  where it is" becomes: a load nobody clicked (the preview pane's iframe, a
  redirect) stays, a click into a loopback dev server stays (links inside the
  preview pane), and a click anywhere else goes out. A link clicked in the
  dashboard itself never reaches that guess: LINKS, a script in the top frame
  only, hands it over by message before the view navigates. decide() is pure
  and tested (tests/test_linux_window.py).
- **The token** comes from /manifest.webmanifest's start_url each time the
  page loads, like the tray's Open dashboard, so a rotated DASH_TOKEN is never
  stale in a launcher. While the bridge doesn't answer, a placeholder says so
  and the window polls every 2 s.
- **One window.** A Gtk.Application: launching it again (the launcher, the
  tray, `--session <id>`) brings the running one forward instead.
- **A log** at ~/.cache/mystical/window.log when it isn't run from a terminal
  (a launcher has nowhere to show stderr): what the page handed over as
  notifications, focus changes, loads, links sent out, the page's console and
  WebKit's own warnings. Started over past LOG_MAX. Notifications that never
  showed are answered there: either the page never sent one, or it did.
- **Its own storage** under ~/.local/share/mystical/webkit: localStorage and
  cookies are this window's, apart from any browser's. What has to agree
  across them (the workspaces, the last one picked) is the bridge's already.

GTK is imported in main(), so the pure helpers import on a box without it.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_ID = "cloud.ainurhq.mystical"
ICON = os.path.join(REPO, "bridge", "dashboard", "web", "public", "icon-512.png")
UA_TAG = "MysticalLinux/1"
HANDLER = "mysticalLinux"
POLL_S = 2
STATE = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "mystical", "window.json")
DATA = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "mystical", "webkit")
CACHE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "mystical", "webkit")
PACKAGES = ("Debian/Ubuntu: sudo apt install gir1.2-webkit2-4.1 python3-gi — Fedora: sudo dnf install "
            "webkit2gtk4.1 python3-gobject — Arch: sudo pacman -S webkit2gtk-4.1 python-gobject")
LOG = os.path.join(CACHE.rsplit(os.sep, 1)[0], "window.log")
LOG_MAX = 512 * 1024
_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_LOCAL = {"127.0.0.1", "localhost", "::1", "[::1]"}


# --- the log ----------------------------------------------------------------------
def log(msg: str) -> None:
    import time
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", file=sys.stderr, flush=True)


def bare(url: str) -> str:
    """A URL without its query: the dashboard's carries the token."""
    return (url or "").split("?", 1)[0]


def to_log_file() -> None:
    """stdout and stderr, fd-level so WebKit's and GLib's own lines land too,
    into LOG — started over once it has grown past LOG_MAX."""
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    try:
        if os.path.getsize(LOG) > LOG_MAX:
            os.remove(LOG)
    except OSError:
        pass
    fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    os.close(fd)
    sys.stdout = os.fdopen(1, "w", buffering=1)
    sys.stderr = os.fdopen(2, "w", buffering=1)


# --- pure: where a navigation goes, what to load --------------------------------
def same_origin(url: str, port: int) -> bool:
    """The dashboard under any of its loopback names; the port has to match."""
    u = urllib.parse.urlsplit(url)
    return u.scheme == "http" and (u.hostname or "") in _LOCAL and u.port == port


def decide(url: str, port: int, new_window: bool, gesture: bool = True) -> str:
    """"view" (load here), "browser" (the desktop's opener) or "ignore". The
    Mac's URLPolicy.decide, with `gesture` (a click led to it) standing in for
    the frame WebKitGTK doesn't report (module docstring)."""
    u = urllib.parse.urlsplit(url or "")
    scheme = u.scheme.lower()
    if not url:
        return "ignore"
    if scheme in ("about", "blob", "data", "javascript"):
        return "ignore" if new_window else "view"
    outside = "browser" if scheme in ("http", "https", "mailto") else "ignore"
    if new_window:
        return outside
    if same_origin(url, port) or not gesture:
        return "view"
    if scheme == "http" and (u.hostname or "") in _LOCAL:
        return "view"
    return outside


# The top frame's own links, handed to the window before the view navigates:
# a link the page already handled (defaultPrevented) is left alone, and only
# what leaves the dashboard's origin is taken.
LINKS = """(() => {
  const out = (e) => {
    if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
    const a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    let u;
    try { u = new URL(a.href, location.href); } catch (_) { return; }
    if (u.origin === location.origin || !/^(https?|mailto):$/.test(u.protocol)) return;
    e.preventDefault();
    window.webkit.messageHandlers.%s.postMessage({ op: "open", url: u.href });
  };
  document.addEventListener("click", out);
  document.addEventListener("auxclick", out);
})();""" % HANDLER


def page_url(port: int, start_url: str | None, session: str | None = None) -> str:
    """The dashboard with the manifest's query (the token), and a session to open."""
    parts = [q for q in [(start_url or "").partition("?")[2]] if q]
    if session:
        parts += [f"s={urllib.parse.quote(session, safe='')}", "skipboot"]
    return f"http://localhost:{port}/" + ("?" + "&".join(parts) if parts else "")


def manifest(port: int) -> dict | None:
    try:
        with _HTTP.open(f"http://127.0.0.1:{port}/manifest.webmanifest", timeout=3) as r:
            d = json.load(r)
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def placeholder(port: int, up_after: bool) -> str:
    """The page shown while the bridge doesn't answer, in the HUD's ground."""
    say = "Waiting for the bridge…" if up_after else "The bridge isn't running."
    return f"""<!doctype html><meta charset=utf-8><title>mystical//assistant</title>
<style>html,body{{height:100%;margin:0;background:#060a0a;color:#7fd8c8;
font:13px/1.6 'JetBrains Mono',ui-monospace,monospace;display:grid;place-items:center}}
p{{margin:0;text-align:center;letter-spacing:.08em}}small{{color:#3f6b64}}</style>
<p>{say}<br><small>localhost:{port} · retrying every {POLL_S}s · mystical start</small></p>"""


def load_state() -> dict:
    try:
        with open(STATE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(d: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f)
    os.replace(tmp, STATE)


def missing() -> str | None:
    """Why the window can't run here, or None."""
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import Gtk, WebKit2  # noqa: F401
    except (ImportError, ValueError) as e:
        return f"mystical window: GTK 3 / WebKitGTK 4.1 bindings are missing ({e}). {PACKAGES}"
    return None


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="window.py", description="mystical//assistant window")
    p.add_argument("--port", type=int, default=int(os.environ.get("DASH_PORT") or 8790))
    p.add_argument("--session", help="open this session (a running window switches to it)")
    p.add_argument("--decorated", action="store_true", help="keep the desktop's title bar")
    p.add_argument("--check", action="store_true", help="exit 0 if the bindings import, else name the packages")
    return p


# --- the window -----------------------------------------------------------------
def run(argv) -> int:
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2

    class Window:
        def __init__(self, app: Gtk.Application, a: argparse.Namespace):
            self.a, self.port = a, a.port
            self.state = load_state()
            self.showing = False          # the dashboard (not the placeholder) is loaded
            self.poll = 0
            self.session = a.session

            os.makedirs(DATA, exist_ok=True)
            os.makedirs(CACHE, exist_ok=True)
            data = WebKit2.WebsiteDataManager(base_data_directory=DATA, base_cache_directory=CACHE)
            ctx = WebKit2.WebContext.new_with_website_data_manager(data)
            # Notifications: the dashboard is the only page this window is for.
            ctx.initialize_notification_permissions([WebKit2.SecurityOrigin.new_for_uri(f"http://localhost:{self.port}")], [])
            ucm = WebKit2.UserContentManager()
            ucm.register_script_message_handler(HANDLER)
            ucm.connect(f"script-message-received::{HANDLER}", self.on_message)
            ucm.add_script(WebKit2.UserScript.new(
                LINKS, WebKit2.UserContentInjectedFrames.TOP_FRAME,
                WebKit2.UserScriptInjectionTime.START, None, None))
            self.web = WebKit2.WebView(web_context=ctx, user_content_manager=ucm)
            s = self.web.get_settings()
            s.set_user_agent(f"{s.get_user_agent()} {UA_TAG}")
            s.set_enable_developer_extras(True)
            s.set_javascript_can_access_clipboard(True)
            s.set_enable_back_forward_navigation_gestures(False)
            # The page's console into the log: a script error explains a silence.
            s.set_enable_write_console_messages_to_stdout(True)
            ground = Gdk.RGBA()
            ground.parse("#060a0a")
            self.web.set_background_color(ground)
            self.web.set_zoom_level(float(self.state.get("zoom") or 1.0))

            self.web.connect("decide-policy", self.on_policy)
            self.web.connect("create", self.on_create)
            self.web.connect("permission-request", self.on_permission)
            self.web.connect("show-notification", self.on_notification)
            self.web.connect("load-failed", self.on_load_failed)
            self.web.connect("load-changed", self.on_load_changed)
            ctx.connect("download-started", self.on_download)

            self.win = Gtk.ApplicationWindow(application=app, title="mystical//assistant")
            # The size it had, else 1440×900, never past 90% of the screen's work area.
            w, h = int(self.state.get("w") or 1440), int(self.state.get("h") or 900)
            disp = Gdk.Display.get_default()
            mon = disp.get_primary_monitor() or disp.get_monitor(0) if disp else None
            if mon:
                area = mon.get_workarea()
                w, h = min(w, int(area.width * 0.9)), min(h, int(area.height * 0.9))
            self.win.set_default_size(w, h)
            if self.state.get("max"):
                self.win.maximize()
            if os.path.isfile(ICON):
                self.win.set_icon_from_file(ICON)
            if not a.decorated:
                # An empty title bar: GTK keeps its client-side frame (shadow,
                # resize edges) and the page draws the bar (module docstring).
                # The theme gives a title bar a minimum height and a ground; an
                # empty one has to be told it has neither.
                bar = Gtk.Box(name="mystical-bar")
                bar.set_size_request(-1, 0)
                css = Gtk.CssProvider()
                css.load_from_data(b"#mystical-bar { min-height: 0; padding: 0; margin: 0; border: 0;"
                                   b" background: none; box-shadow: none; }")
                Gtk.StyleContext.add_provider_for_screen(
                    Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
                self.win.set_titlebar(bar)
            self.win.add(self.web)
            self.win.connect("configure-event", self.on_configure)
            self.win.connect("window-state-event", self.on_window_state)
            self.win.connect("key-press-event", self.on_key)
            self.win.connect("focus-in-event", lambda *_: self.win.set_urgency_hint(False))
            # The page only notifies while the window isn't focused (Notifications.tsx).
            self.win.connect("notify::is-active", lambda w, _p: log(f"window {'active' if w.is_active() else 'inactive'}"))
            log(f"start: pid {os.getpid()}, port {self.port}, WebKitGTK "
                f"{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}")
            self.win.show_all()
            if manifest(self.port) is None:
                log("bridge not answering at launch: starting the unit")
                # Launched with the bridge down: start it (a no-op without the
                # unit); the placeholder polls until it answers.
                subprocess.Popen(["systemctl", "--user", "start", "mystical-assistant.service"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.load()

        # loading -----------------------------------------------------------
        def load(self, session: str | None = None):
            m = manifest(self.port)
            if m is None:
                self.cover(up_after=True)
                return
            self.showing = True
            self.web.load_uri(page_url(self.port, m.get("start_url"), session or self.session))
            self.session = None

        def cover(self, up_after: bool):
            if self.showing or not self.poll:
                log("bridge not answering: placeholder up, polling")
            self.showing = False
            self.web.load_alternate_html(placeholder(self.port, up_after), "about:mystical", None)
            if not self.poll:
                self.poll = GLib.timeout_add_seconds(POLL_S, self.retry)

        def retry(self):
            if manifest(self.port) is None:
                return True
            self.poll = 0
            self.load()
            return False

        def on_load_failed(self, _web, _event, uri, err):
            # A navigation the policy sent to the browser is "cancelled": the page is fine.
            if err.matches(WebKit2.PolicyError.quark(), WebKit2.PolicyError.FRAME_LOAD_INTERRUPTED_BY_POLICY_CHANGE) \
                    or err.matches(WebKit2.NetworkError.quark(), WebKit2.NetworkError.CANCELLED):
                return False
            if same_origin(uri, self.port):
                log(f"load failed: {bare(uri)}: {err.message}")
                self.cover(up_after=True)
                return True
            return False

        def on_load_changed(self, web, event):
            if event == WebKit2.LoadEvent.COMMITTED:
                self.win.set_title(web.get_title() or "mystical//assistant")
                log(f"loaded {bare(web.get_uri())}")

        def open_session(self, sid: str):
            """A running window switches in place (App.tsx __mysticalOpenSession); else a deep link."""
            self.present()
            if not self.showing:
                self.load(sid)
                return
            js = f"window.__mysticalOpenSession?.({json.dumps(sid)}) === true"

            def done(web, res):
                try:
                    ok = web.evaluate_javascript_finish(res).to_boolean()
                except GLib.Error:
                    ok = False
                if not ok:
                    self.load(sid)
            self.web.evaluate_javascript(js, -1, None, None, None, done)

        def present(self):
            self.win.present_with_time(Gtk.get_current_event_time() or GLib.get_monotonic_time() // 1000)

        # where things go ----------------------------------------------------
        def to_browser(self, uri: str):
            log(f"link out: {bare(uri)}")
            try:
                Gio.AppInfo.launch_default_for_uri(uri, None)
            except GLib.Error as e:
                print(f"mystical window: couldn't open {uri}: {e.message}", file=sys.stderr)

        def on_policy(self, _web, decision, kind):
            if kind == WebKit2.PolicyDecisionType.RESPONSE:
                # What the view can't show (an attachment, a zip) is a download.
                if not decision.is_mime_type_supported():
                    decision.download()
                    return True
                return False
            action = decision.get_navigation_action()
            uri = action.get_request().get_uri()
            where = decide(uri, self.port, kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION,
                           action.is_user_gesture() and not action.is_redirect())
            if where == "view":
                return False
            decision.ignore()
            if where == "browser":
                self.to_browser(uri)
            return True

        def on_create(self, _web, action):
            # window.open with no policy answer yet: never a second view.
            uri = action.get_request().get_uri()
            if decide(uri, self.port, True) == "browser":
                self.to_browser(uri)
            return None

        def on_permission(self, _web, req):
            log(f"permission request: {type(req).__name__}")
            if isinstance(req, WebKit2.NotificationPermissionRequest):
                req.allow()
            else:
                req.deny()
            return True

        def on_notification(self, _web, note):
            """WebKit shows the page's Notification on the desktop's service
            itself, and a click on it runs the page's onclick (App.tsx opens
            the session); this only brings the window forward for that click,
            and flags it while it's behind. Checked against a stand-in service
            on a private bus: Notify arrives, ActionInvoked reaches onclick."""
            log(f"notification: {note.get_title()!r} (window {'active' if self.win.is_active() else 'inactive'})")
            note.connect("clicked", lambda *_: (log(f"notification clicked: {note.get_title()!r}"), self.present()))
            if not self.win.is_active():
                self.win.set_urgency_hint(True)
            return False

        def on_download(self, _ctx, download):
            def dest(dl, name):
                folder = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or os.path.expanduser("~/Downloads")
                os.makedirs(folder, exist_ok=True)
                base, ext = os.path.splitext(os.path.basename(name) or "download")
                path, n = os.path.join(folder, base + ext), 1
                while os.path.exists(path):
                    path, n = os.path.join(folder, f"{base} ({n}){ext}"), n + 1
                dl.set_destination(GLib.filename_to_uri(path, None))
                return True
            download.connect("decide-destination", dest)
            download.connect("finished", lambda dl: self.notify_download(dl))

        def notify_download(self, dl):
            path = GLib.filename_from_uri(dl.get_destination())[0] if dl.get_destination() else ""
            n = Gio.Notification.new("Downloaded")
            n.set_body(os.path.basename(path))
            self.win.get_application().send_notification(None, n)

        # the page as title bar -----------------------------------------------
        def on_message(self, _ucm, value):
            # WebKit2 4.1 hands a JavascriptResult wrapping the JSC value.
            js = value.get_js_value() if hasattr(value, "get_js_value") else value
            try:
                msg = json.loads(js.to_json(0))
            except (ValueError, AttributeError, TypeError) as e:
                print(f"mystical window: unreadable page message ({e})", file=sys.stderr)
                return
            op = msg.get("op") if isinstance(msg, dict) else None
            gw = self.win.get_window()
            if op == "open" and decide(str(msg.get("url") or ""), self.port, True) == "browser":
                self.to_browser(msg["url"])
            elif op == "drag" and gw:
                seat = Gdk.Display.get_default().get_default_seat()
                _, x, y = seat.get_pointer().get_position()
                gw.begin_move_drag(1, x, y, Gtk.get_current_event_time())
            elif op == "minimize":
                self.win.iconify()
            elif op == "maximize":
                self.win.unmaximize() if self.win.is_maximized() else self.win.maximize()
            elif op == "close":
                self.win.close()

        # keys and geometry ---------------------------------------------------
        def on_key(self, _w, ev):
            ctrl = ev.state & Gdk.ModifierType.CONTROL_MASK
            shift = ev.state & Gdk.ModifierType.SHIFT_MASK
            k = Gdk.keyval_name(ev.keyval) or ""
            if k == "F5" or (ctrl and k.lower() == "r"):
                self.load() if not self.showing else self.web.reload()
            elif k == "F11":
                self.win.unfullscreen() if self.state.get("full") else self.win.fullscreen()
            elif ctrl and shift and k.lower() == "i":
                self.web.get_inspector().show()
            elif ctrl and k in ("plus", "equal", "KP_Add"):
                self.zoom(self.web.get_zoom_level() + 0.1)
            elif ctrl and k in ("minus", "KP_Subtract"):
                self.zoom(self.web.get_zoom_level() - 0.1)
            elif ctrl and k in ("0", "KP_0"):
                self.zoom(1.0)
            elif ctrl and k.lower() == "q":
                self.win.close()
            else:
                return False
            return True

        def zoom(self, z: float):
            z = round(min(3.0, max(0.5, z)), 2)
            self.web.set_zoom_level(z)
            self.state["zoom"] = z
            save_state(self.state)

        def on_configure(self, win, _ev):
            if not self.state.get("max") and not self.state.get("full"):
                w, h = win.get_size()
                if (w, h) != (self.state.get("w"), self.state.get("h")):
                    self.state.update(w=w, h=h)
                    GLib.timeout_add(400, self.flush)
            return False

        def on_window_state(self, _win, ev):
            st = ev.new_window_state
            self.state["max"] = bool(st & Gdk.WindowState.MAXIMIZED)
            self.state["full"] = bool(st & Gdk.WindowState.FULLSCREEN)
            self.flush()
            return False

        def flush(self):
            save_state({k: v for k, v in self.state.items() if k != "full"})
            return False

    # The name notifications go out under, and the X11 class (Wayland's app_id
    # is the application id): what the desktop matches to the launcher entry.
    GLib.set_prgname(APP_ID)
    GLib.set_application_name("Mystical")
    Gdk.set_program_class(APP_ID)
    app = Gtk.Application(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
    box: dict = {}

    def on_command_line(app, cl):
        a = parser().parse_args(cl.get_arguments()[1:])
        w = box.get("w")
        if w is None:
            box["w"] = Window(app, a)
        elif a.session:
            w.open_session(a.session)
        else:
            w.present()
        return 0

    app.connect("command-line", on_command_line)
    return app.run([sys.argv[0], *argv])


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    a = parser().parse_args(argv)
    why = missing()
    if why:
        print(why, file=sys.stderr)
        return 1
    if a.check:
        return 0
    if not sys.stderr.isatty():
        to_log_file()
    return run(argv)


if __name__ == "__main__":
    sys.exit(main())
