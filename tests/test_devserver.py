"""devserver: per-directory concurrent dev servers + localhost URL detection.
Run: `python tests/test_devserver.py`  (or pytest)
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import devserver  # noqa: E402


def test_detect_url_variants():
    assert devserver._detect_url("  ➜  Local:   http://localhost:5173/")[1] == 5173
    assert devserver._detect_url("- Local:        http://localhost:3000")[1] == 3000
    # Vite bolds the port with ANSI codes — must still parse.
    assert devserver._detect_url("Local: http://localhost:\x1b[1m4321\x1b[22m/")[1] == 4321
    # 127.0.0.1 / 0.0.0.0 are normalised to localhost for the iframe.
    u, p = devserver._detect_url("App running at http://127.0.0.1:8080")
    assert u == "http://localhost:8080" and p == 8080
    # A bare host:port with no scheme is not a usable preview URL.
    assert devserver._detect_url("listening on 0.0.0.0:4000") is None
    assert devserver._detect_url("no url here at all") is None


def _fake(port: int, alive: int = 5) -> str:
    # A stand-in dev server: announce a Local URL, then idle so it stays "running".
    return f"printf 'Local: http://localhost:{port}/\\n'; sleep {alive}"


def _wait_url(cwd: str, timeout: float = 6.0):
    end = time.time() + timeout
    while time.time() < end:
        st = devserver.state_for(cwd)
        if st["url"]:
            return st
        time.sleep(0.05)
    return devserver.state_for(cwd)


def test_concurrent_servers_keyed_by_directory():
    base = os.environ["BASE_PATH"]
    a = os.path.join(base, "proj-a"); os.makedirs(a, exist_ok=True)
    b = os.path.join(base, "proj-b"); os.makedirs(b, exist_ok=True)
    try:
        devserver.start(a, _fake(4101), project="/proj-a", branch="main")
        devserver.start(b, _fake(4102), project="/proj-b", branch="dev")
        sa, sb = _wait_url(a), _wait_url(b)
        # Both run at once, each with its own detected port.
        running = [s for s in devserver.list_servers() if s["status"] == "running"]
        assert len(running) == 2
        assert sa["url"] == "http://localhost:4101" and sa["port"] == 4101
        assert sa["branch"] == "main" and sb["branch"] == "dev"
    finally:
        devserver.stop(a)
        devserver.stop(b)
    assert devserver.state_for(a)["status"] == "not started"


def test_one_server_per_directory():
    base = os.environ["BASE_PATH"]
    c = os.path.join(base, "proj-c"); os.makedirs(c, exist_ok=True)
    try:
        devserver.start(c, _fake(4201))
        _wait_url(c)
        msg = devserver.start(c, _fake(4299))  # second start is a no-op
        assert "already running" in msg.lower()
        assert devserver.state_for(c)["port"] == 4201
    finally:
        devserver.stop(c)


def test_immediate_exit_reports_failure():
    base = os.environ["BASE_PATH"]
    d = os.path.join(base, "proj-d"); os.makedirs(d, exist_ok=True)
    msg = devserver.start(d, "echo boom; exit 7")
    assert "exited" in msg.lower() and "boom" in msg
    # The exited server stays queryable so the UI can surface the failure + output.
    st = devserver.state_for(d)
    assert st["status"] == "exited"
    assert any("boom" in ln for ln in st["tail"])
    devserver.stop(d)  # explicit stop clears it
    assert devserver.state_for(d)["status"] == "not started"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
