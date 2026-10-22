"""Usage sharing: the install's one answer (bridge/usagesharing.py), its
dashboard route, and what the dashboard scrubs before PostHog sees an event
(bridge/dashboard/web/tools/usage.check.mjs, run here so the suite covers it).
Driven without sockets via Handler.__new__ (mirrors test_fallback_endpoints.py).
"""

import os
import shutil
import subprocess

import pytest

from bridge import usagesharing
from bridge.dashboard import server as dash

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(autouse=True)
def _unasked():
    try:
        os.remove(usagesharing._path())
    except FileNotFoundError:
        pass


def _call(method, path, body=None):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    if method == "GET":
        h._get_api(path, {})
    else:
        h._post_api(path, body)
    return box


def test_unasked_until_answered():
    assert usagesharing.answer() is None
    assert _call("GET", "/local/usage-sharing") == {"obj": {"share": None}, "code": 200}


def test_the_answer_is_kept_both_ways():
    assert _call("POST", "/local/usage-sharing", {"share": True})["obj"] == {"share": True}
    assert usagesharing.answer() is True
    _call("POST", "/local/usage-sharing", {"share": False})
    assert _call("GET", "/local/usage-sharing")["obj"] == {"share": False}


def test_only_a_real_yes_or_no_counts():
    """Nothing but a bool switches it, so a confused client can't opt anyone in."""
    assert _call("POST", "/local/usage-sharing", {"share": "yes"})["code"] == 400
    assert _call("POST", "/local/usage-sharing", {})["code"] == 400
    assert usagesharing.answer() is None


def test_a_garbled_file_reads_as_unasked():
    os.makedirs(os.path.dirname(usagesharing._path()), exist_ok=True)
    with open(usagesharing._path(), "w") as f:
        f.write("{not json")
    assert usagesharing.answer() is None


def test_the_dashboard_scrubs_what_posthog_sees():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    major = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip().lstrip("v").split(".")[0]
    if not major.isdigit() or int(major) < 23:
        pytest.skip("node runs .ts only from 23 on")
    r = subprocess.run([node, os.path.join(ROOT, "bridge", "dashboard", "web", "tools", "usage.check.mjs")],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
