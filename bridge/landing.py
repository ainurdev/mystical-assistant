"""The landing page (site/dist) served on localhost.

So `mystical status` can hand you a URL for it and you can look at the marketing
page locally, without a Cloudflare Pages deploy. Static files on their own port —
no API, no state, nothing that can act on the machine.
"""

import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "dist")


def built() -> bool:
    return os.path.isfile(os.path.join(DIR, "index.html"))


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass          # every asset request would otherwise land in mystical.log


_httpd: ThreadingHTTPServer | None = None


def start(port: int) -> ThreadingHTTPServer:
    global _httpd
    _httpd = ThreadingHTTPServer(("127.0.0.1", port), partial(_Quiet, directory=DIR))
    threading.Thread(target=_httpd.serve_forever, daemon=True).start()
    return _httpd


def stop():
    global _httpd
    if _httpd is not None:
        _httpd.shutdown()
        _httpd = None
