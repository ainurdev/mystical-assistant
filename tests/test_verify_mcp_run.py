"""verify_mcp Run: the model's dev-server start goes over the dashboard API.
Run: `python tests/test_verify_mcp_run.py`  (or pytest)
"""

import json
import os
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import verify_mcp  # noqa: E402


class _Resp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def read(self, *a):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _capture(payload, monkey):
    seen = {}

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url
        seen["body"] = json.loads(req.data)
        seen["token"] = req.get_header("X-dash-token")
        return _Resp(payload)

    monkey.append((urllib.request, "urlopen", urllib.request.urlopen))
    urllib.request.urlopen = fake_urlopen
    return seen


def test_run_posts_to_the_dashboard():
    os.environ["MYSTICAL_DASH"] = "http://127.0.0.1:8790"
    os.environ["MYSTICAL_DASH_TOKEN"] = "sekrit"
    undo = []
    seen = _capture({"message": "✅ Server started (pid 7)",
                     "server": {"url": "http://localhost:5173"}}, undo)
    try:
        out = verify_mcp._run({"command": "npm run dev"})
    finally:
        for obj, name, orig in undo:
            setattr(obj, name, orig)
    assert seen["url"] == "http://127.0.0.1:8790/local/server"
    assert seen["token"] == "sekrit"          # the gate the dashboard checks
    assert seen["body"]["action"] == "start"
    assert seen["body"]["cmd"] == "npm run dev"
    assert seen["body"]["cwd"] == os.getcwd()  # the run dir, not the chat's project
    # The model is told where the human will see it, not just that it started.
    assert "http://localhost:5173" in out and "started" in out


def test_run_stop_action():
    os.environ["MYSTICAL_DASH"] = "http://127.0.0.1:8790"
    undo = []
    seen = _capture({"message": "🛑 Server stopped.", "server": {}}, undo)
    try:
        out = verify_mcp._run({"action": "stop"})
    finally:
        for obj, name, orig in undo:
            setattr(obj, name, orig)
    assert seen["body"]["action"] == "stop"
    assert out == "🛑 Server stopped."


def test_run_without_a_dashboard_says_so():
    os.environ.pop("MYSTICAL_DASH", None)
    out = verify_mcp._run({"command": "npm run dev"})
    assert "dashboard is not running" in out


def test_run_is_advertised():
    assert any(t["name"] == "Run" for t in verify_mcp._TOOLS)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
