"""A missing file under /assets/ is a 404, not the page: a page left open across
a build asks for a piece of script the build deleted, and index.html parsed as
script fails in a way the router's reload-once guard can't tell from a real bug.
Any other unknown path still gets the page (hash URLs never reach the server,
but a typed path or an old bookmark should land on the app).
Run: python3 -m pytest tests/test_dashboard_assets_404.py -q"""
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from bridge import config
from bridge.dashboard import server as dash


@pytest.fixture
def url(tmp_path, monkeypatch):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html><head></head><body>page</body></html>")
    (tmp_path / "assets" / "index-abc.js").write_text("export {}")
    monkeypatch.setattr(dash, "WEB_DIR", str(tmp_path))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), dash.Handler)
    port = httpd.server_address[1]
    monkeypatch.setattr(config, "DASH_PORT", port)
    monkeypatch.setattr(dash, "_HOSTS", {f"127.0.0.1:{port}"})
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    httpd.server_close()


def get(url):
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def test_a_missing_asset_is_a_404(url):
    code, body = get(url + "/assets/Settings-gone.js")
    assert code == 404 and "page" not in body


def test_a_present_asset_is_served(url):
    assert get(url + "/assets/index-abc.js") == (200, "export {}")


@pytest.mark.parametrize("path", ["/", "/some/unknown/path"])
def test_the_page_and_unknown_paths_still_get_the_page(url, path):
    code, body = get(url + path)
    assert code == 200 and "page" in body
