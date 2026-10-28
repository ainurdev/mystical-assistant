"""linux/window.py's pure half: where a navigation goes (the Mac app's
URLPolicy, with a click standing in for the frame WebKitGTK doesn't report),
and what it loads. The GTK half needs a display; this runs anywhere.
Run: python3 -m pytest tests/test_linux_window.py -q"""

import importlib.util
import os

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("linux_window", os.path.join(_ROOT, "linux", "window.py"))
W = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(W)


@pytest.mark.parametrize("url, new_window, gesture, where", [
    # the dashboard under any loopback name stays, the port has to match
    ("http://localhost:8790/?s=1", False, True, "view"),
    ("http://127.0.0.1:8790/x", False, True, "view"),
    ("http://[::1]:8790/", False, True, "view"),
    # a link out goes to the desktop's opener: the default browser
    ("https://github.com/a/b/pull/1", False, True, "browser"),
    ("mailto:a@b.c", False, True, "browser"),
    # nobody clicked: an iframe loading (the preview pane), a redirect
    ("https://xyz.trycloudflare.com/", False, False, "view"),
    # a click inside the preview pane's dev server stays in it
    ("http://localhost:5173/about", False, True, "view"),
    # a new window is never a second view, whatever it is
    ("http://localhost:8790/", True, True, "browser"),
    ("https://example.com/", True, False, "browser"),
    ("file:///etc/passwd", True, True, "ignore"),
    ("file:///etc/passwd", False, True, "ignore"),
    ("about:blank", False, False, "view"),
    ("about:blank", True, True, "ignore"),
    ("", False, True, "ignore"),
])
def test_decide(url, new_window, gesture, where):
    assert W.decide(url, 8790, new_window, gesture) == where


def test_page_url_carries_the_token_and_a_session():
    assert W.page_url(8790, "/?token=abc") == "http://localhost:8790/?token=abc"
    assert W.page_url(8790, None) == "http://localhost:8790/"
    assert W.page_url(8790, "/?token=abc", "s 1") == "http://localhost:8790/?token=abc&s=s%201&skipboot"


def test_the_links_script_names_the_handler():
    assert "mysticalLinux" in W.LINKS and "defaultPrevented" in W.LINKS
