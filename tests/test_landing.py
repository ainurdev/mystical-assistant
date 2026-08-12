"""The landing server serves site/dist and nothing above it.

Run: `python -m pytest tests/test_landing.py`
"""

import os
import sys
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import landing  # noqa: E402


@pytest.fixture
def server():
    if not landing.built():
        pytest.skip("site/dist not built")
    httpd = landing.start(0)                     # port 0 → the OS picks a free one
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    landing.stop()


def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, r.read()


def test_serves_the_landing_page(server):
    status, body = _get(server + "/")
    assert status == 200
    assert b"<html" in body.lower()


def test_no_escaping_the_dist_dir(server):
    with pytest.raises(urllib.error.HTTPError) as e:
        _get(server + "/../../.env")
    assert e.value.code == 404
