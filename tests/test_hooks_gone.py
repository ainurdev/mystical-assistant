"""Inbound hooks were removed (settings remap, 2026-10-15): the public receiver
on the Mini App server is gone, so a webhook URL still pasted somewhere gets the
plain 404 every unknown POST gets. Driven without sockets via the
Handler.__new__ trick (mirrors test_breakdown_endpoint.py).

Run: python -m pytest tests/test_hooks_gone.py -v
"""

import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.miniapp import server as mini  # noqa: E402


def test_a_posted_hook_url_is_a_plain_404():
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h.path = "/hook/abc123"
    h.rfile = io.BytesIO(b'{"title":"build red"}')
    h.headers = {"Content-Length": "21"}
    h.do_POST()
    assert box["code"] == 404
    assert not hasattr(mini.Handler, "_hook")
