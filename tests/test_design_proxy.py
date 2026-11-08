"""Showing a real page through the proxy: tools in, framing rules out, and only where it may go."""
import http.client
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from bridge import config, design_audit, design_board as db, design_proxy as dp, experimental, gateway_tools as gt, multi_api, store


class App(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen = []

    def log_message(self, *a):
        pass

    def _send(self, body, kind="text/html", extra=()):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        App.seen.append({"path": self.path, "host": self.headers.get("Host"), "cookie": self.headers.get("Cookie"), "encoding": self.headers.get("Accept-Encoding")})
        me = f"http://{self.headers.get('Host')}"
        if self.path == "/move":
            self.send_response(302)
            self.send_header("Location", f"{me}/there")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/data":
            self._send(b'{"ok": true}', "application/json")
        elif self.path == "/pic":
            self._send(bytes(range(256)), "image/png")
        else:
            self._send(f'<html><head><title>a</title></head><body><a href="{me}/x">x</a></body></html>'.encode(),
                       extra=[("Content-Security-Policy", "default-src 'none'"), ("X-Frame-Options", "DENY"), ("Set-Cookie", "s=1; Domain=x.io; Secure; SameSite=None; Path=/")])

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._send(body, "text/plain")


@pytest.fixture
def app():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), App)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    App.seen.clear()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def get(src, path="/", method="GET", body=None, headers=None, host=None):
    p = src.split("//")[1].split("/")[0].split(":")
    c = http.client.HTTPConnection(p[0], int(p[1]), timeout=5)
    c.request(method, path, body=body, headers={**({"Host": host} if host else {}), **(headers or {})})
    r = c.getresponse()
    data = r.read()
    c.close()
    return r, data


def test_html_gets_the_tools_and_loses_the_framing_rules(app):
    src = dp.open_proxy(app + "/", "/*TOOLS*/")
    r, data = get(src)
    text = data.decode()
    assert "/*TOOLS*/" in text and "__mysticalProxied" in text and text.index("TOOLS") < text.index("<title>")
    assert r.getheader("Content-Security-Policy") is None and r.getheader("X-Frame-Options") is None
    assert app not in text and src.rstrip("/") in text                     # its own links stay in the view
    assert r.getheader("Set-Cookie") == "s=1; Path=/"
    assert App.seen[-1]["host"] == app.split("//")[1] and App.seen[-1]["encoding"] == "identity"


def test_other_things_pass_through_unharmed(app):
    src = dp.open_proxy(app, "/*T*/")
    r, data = get(src, "/pic")
    assert data == bytes(range(256)) and r.getheader("Content-Type") == "image/png"
    _, data = get(src, "/data")
    assert json.loads(data) == {"ok": True}
    _, data = get(src, "/echo", "POST", body=b"hello")
    assert data == b"hello"


def test_a_redirect_stays_in_the_view(app):
    src = dp.open_proxy(app, "")
    r, _ = get(src, "/move")
    assert r.status == 302 and r.getheader("Location") == src.rstrip("/") + "/there"


def test_a_stranger_host_is_refused(app):
    src = dp.open_proxy(app, "")
    r, _ = get(src, "/", host="evil.example")
    assert r.status == 403 and not App.seen


def test_a_server_thats_down_says_so():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    src = dp.open_proxy(f"http://127.0.0.1:{port}", "")
    r, data = get(src)
    assert r.status == 502 and b"Nothing's answering" in data
    assert not dp.answering(f"http://127.0.0.1:{port}")


@pytest.mark.parametrize("typed,want", [("localhost:5173", "http://localhost:5173"), ("127.0.0.1:3000/x", "http://127.0.0.1:3000/x"), ("example.com", "https://example.com"), ("http://a.b/", "http://a.b/")])
def test_addresses_as_typed(typed, want):
    assert dp.normalize(typed) == want


@pytest.mark.parametrize("url", ["http://10.0.0.1/", "http://192.168.1.1/", "http://169.254.169.254/latest", "ftp://x.io/", "file:///etc/passwd", "http://no.such.host.invalid/"])
def test_only_this_machine_and_public_addresses(url):
    with pytest.raises(dp.Refused):
        dp.check(url)


def test_it_rechecks_where_a_name_points_each_time(app, monkeypatch):
    src = dp.open_proxy(app, "")
    monkeypatch.setattr(dp, "reachable", lambda host: False)
    assert get(src)[0].status == 403 and not App.seen


@pytest.fixture
def session(tmp_path, monkeypatch):
    root = tmp_path / "shop"
    root.mkdir()
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)
    store.init()
    return store.create_session(config.DASH_CHAT_ID, "/p", cwd=str(root))


class Job:
    id = "j"

    def __init__(self):
        self.events = []

    def add(self, e):
        self.events.append(e)


def test_an_agent_shows_a_running_app_and_hears_if_its_down(session, app):
    job = Job()
    res = gt.call(session, job, "show_design", {"title": "The app", "pages": [{"name": "App", "url": app}]})
    assert job.events[0]["board"] == "the-app" and "Nothing is answering" not in res["content"][0]["text"]
    res = gt.call(session, job, "show_design", {"title": "Down", "pages": [{"name": "App", "url": "http://127.0.0.1:9"}]})
    assert "Nothing is answering yet" in res["content"][0]["text"]
    assert gt.call(session, job, "show_design", {"title": "No", "pages": [{"name": "A", "url": "http://10.0.0.1"}]})["isError"]


def test_the_routes_open_an_address_and_the_board_knows_it(session, app, tmp_path):
    chat, body = config.DASH_CHAT_ID, {"session_id": session["id"]}
    out, code = multi_api.post("chat/design-url", {**body, "url": app}, chat)
    assert code == 200 and out["board"].startswith("live-")
    got = multi_api.post("chat/design", {**body, "board": out["board"], "page": out["page"]}, chat)[0]
    assert got["url"] == app and "html" not in got and got["pages"][0]["file"] == app
    live = multi_api.post("chat/design-live", {**body, "board": out["board"], "page": out["page"], "script": "/*T*/"}, chat)[0]
    assert b"/*T*/" in get(live["src"])[1]
    assert multi_api.post("chat/design-url", {**body, "url": "http://10.0.0.1"}, chat)[1] == 400
    experimental.set_enabled(False)
    assert multi_api.post("chat/design-live", {**body, "board": out["board"], "page": out["page"]}, chat)[1] == 409


def test_a_comment_keeps_its_screen(session, app):
    root = session["cwd"]
    db.put(root, root, {"title": "T", "pages": [{"name": "A", "url": app}]})
    rows = db.edit_comments(root, {"board": "t", "put": {"id": "c", "page": "A", "text": "x", "path": "/orders?x=1"}})[0]["comments"]
    assert rows[0]["path"] == "/orders?x=1"


def test_the_inspector_goes_to_the_address(session, app):
    root = session["cwd"]
    db.put(root, root, {"title": "T", "pages": [{"name": "A", "url": app}]})
    assert design_audit.target_url(root, {"board": "t"}) == (app, None)
