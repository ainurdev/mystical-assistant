"""The dashboard's GET gate: a /local/ read that a browser marks as coming from
another site's page is refused, whatever the route. Dashboard GETs carry no
token (only the Host header is checked), so before this an <img> on any page
could fire one at localhost. Drives do_GET without a socket.
Run: python3 -m pytest tests/test_dashboard_cross_site.py -q"""

import pytest

from bridge import config
from bridge.dashboard import server as dash


def _handler(path, site=None):
    h = dash.Handler.__new__(dash.Handler)
    h.path = path
    h.headers = {"Host": f"127.0.0.1:{config.DASH_PORT}"}
    if site is not None:
        h.headers["Sec-Fetch-Site"] = site
    box = {"routed": None}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._get_api = lambda path, qs: box.update(routed=path)
    h._stream = lambda rest, qs: box.update(routed="stream:" + rest)
    h._static = lambda path: box.update(routed="static:" + path)
    return h, box


@pytest.mark.parametrize("site", ["cross-site", "same-site"])
def test_a_read_from_another_sites_page_is_refused(site):
    h, box = _handler("/local/git/compare?project=p&base=a&head=b", site)
    h.do_GET()
    assert box["code"] == 403 and box["routed"] is None


@pytest.mark.parametrize("site", ["same-origin", "none", None])
def test_the_dashboard_itself_and_non_browser_callers_still_read(site):
    # same-origin: the dashboard's own fetches. none: a URL typed or opened
    # directly. None: curl, the bridge's agents (MYSTICAL_DASH), the probe proxy.
    h, box = _handler("/local/state", site)
    h.do_GET()
    assert box["routed"] == "/local/state"


def test_the_dashboards_own_event_streams_still_open():
    h, box = _handler("/local/stream/logs?token=x", "same-origin")
    h.do_GET()
    assert box["routed"] == "stream:logs"


def test_a_top_level_page_load_is_not_a_local_read():
    h, box = _handler("/", "cross-site")
    h.do_GET()
    assert box["routed"] == "static:/"
