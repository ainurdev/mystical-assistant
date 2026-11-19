"""The Mystical browser's comment tray (bridge/browser_ext/content.js) in a real Chrome for Testing, headless:
tests/browser_tray.mjs drives it over CDP with real mouse and keys, against site_browser's loopback server on the
test DB. A page's own script is hostile, and a person can be quicker than a Send. Skipped without node or
Chrome for Testing (site_browser.chromium()); each test starts its own browser, a few seconds."""
import http.server
import json
import os
import shutil
import subprocess
import threading

import pytest

from bridge import config, queue_manager, site_browser as sb, store

store.init()
NODE = shutil.which("node")
DRIVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "browser_tray.mjs")
pytestmark = pytest.mark.skipif(not NODE or not sb.chromium(), reason="needs node and Chrome for Testing")
STYLE = "body{margin:0;font:14px system-ui}#b,#p,#t{position:absolute;left:40px;top:120px;width:200px;height:40px}"
PAGES = {    # path: (title, body)
    "/btn": ("Buy · Lumen", '<button id="b" onclick="window.hits=(window.hits||0)+1">Buy now</button>'),
    "/other": ("Other · Lumen", '<p id="p">Some words here</p>'),
    "/evil": ("A page · Lumen", '<p id="t">Nothing to see</p>'),
}


@pytest.fixture
def drive(tmp_path, monkeypatch):
    """drive(scenario) -> (what the driver saw, the prompts that reached the bridge's queue)."""
    release, prompts = threading.Event(), []

    def enqueue(sid, **kw):     # a Send waits for the driver's GET /release, so another tab can pin meanwhile
        release.wait(30)
        prompts.append(kw["prompt"])
        return "item"

    sb.stop_serving()
    monkeypatch.setattr(sb, "home", lambda: str(tmp_path / "browser"))
    monkeypatch.setattr(sb, "_launch", lambda args: None)
    monkeypatch.setattr(sb, "_no_screen", lambda: None)
    monkeypatch.setattr(queue_manager, "enqueue", enqueue)

    class Site(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/release":
                release.set()
            title, body = PAGES.get(self.path, ("", ""))
            raw = (f'<!doctype html><html><head><meta charset="utf-8"><title>{title}</title><style>{STYLE}</style>'
                   f"</head><body>{body}</body></html>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *a):
            pass

    site = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=site.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{site.server_address[1]}"
    s = store.create_session(config.DASH_CHAT_ID, "/lumen-web", cwd=os.path.join(config.BASE_PATH, "lumen-web"))
    sb.open_site(s["id"], base + "/btn")

    def run(scenario):
        r = subprocess.run([NODE, DRIVER, scenario, base, sb._ext(), sb.chromium()],
                           capture_output=True, text=True, timeout=90)
        seen = {}
        for line in r.stdout.splitlines():
            if line.startswith("{"):
                d = json.loads(line)
                seen[d.pop("check")] = d
        if "no-chrome" in seen:     # a Chromium that can't start here (missing libraries): not this code's fault
            pytest.skip(f"Chrome for Testing didn't start: {seen['no-chrome']['error']}")
        assert r.returncode == 0 and scenario in seen, (r.stdout + r.stderr)[-3000:]
        return seen[scenario], prompts

    yield run
    release.set()
    site.shutdown()
    sb.stop_serving()
    sb._pins.clear()


def test_a_pick_never_presses_what_it_picks_and_the_box_keeps_every_key(drive):
    seen, _ = drive("pick")
    assert seen == {"pressed by the pick": 0, "pressed by Point again": 0, "pinned": "fix the cramped menu"}


def test_the_pages_own_script_cant_see_into_the_tray_or_pick_with_made_up_events(drive):
    seen, prompts = drive("page")
    assert seen == {"root open to the page": False, "picking": False, "comment box": False}
    assert prompts == []


def test_a_comment_pinned_while_a_send_is_in_flight_stays_for_the_next_send(drive):
    seen, prompts = drive("send")
    assert seen == {"kept": True}
    assert len(prompts) == 2, prompts
    assert "make it bigger" in prompts[0] and "typed during the send" not in prompts[0]
    assert "typed during the send" in prompts[1] and "make it bigger" not in prompts[1]
