"""Reports (bridge/reports.py): which installs send a crash, what one carries,
and what it never carries. Each case is one bridge start in its own process
(tests/reports_child.py), sending to a fake Sentry receiver here.
"""

import gzip
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TEAM = {"name": "mahzi", "api_url": "https://api.rivendell.ainurhq.cloud", "token": "riv-PLANTED-token-123456"}
RELEASE = "0123456789abcdef0123456789abcdef01234567"
PLANT = {
    "local": "PLANTED-local-variable",
    "log": "PLANTED log line",
    "prompt": "fix the login page\nPLANTED second line of the prompt",
    "message": " | ".join([
        "dash test-dash-token", "bot https://api.telegram.org/bot12345:TESTTOKEN/getMe",
        "raw 12345:TESTTOKEN", "key sk-ant-oat01-PLANTEDabcdef1234567890",
        "gh ghp_PLANTEDaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "riv riv-PLANTED-token-123456",
        "Authorization: Bearer PLANTEDbearer.abc", "url https://example.com/cb?code=PLANTEDquery",
    ]),
}
_LEAKS = ("PLANTED", "test-dash-token", "TESTTOKEN")


class _Receiver:
    """Sentry's envelope endpoint, or one that never answers (hang)."""

    def __init__(self, hang=False):
        self.raw, self.events, self.hang, self.gate = [], [], hang, threading.Event()
        me = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                if me.hang:
                    me.gate.wait(30)
                    return
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                me.raw.append(body)
                lines = body.decode().split("\n")
                for head, payload in zip(lines[1::2], lines[2::2]):
                    if json.loads(head).get("type") == "event":
                        me.events.append(json.loads(payload))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        self.dsn = f"http://publickey@127.0.0.1:{self.srv.server_address[1]}/1"

    def close(self):
        self.gate.set()
        self.srv.shutdown()


@pytest.fixture
def receiver():
    r = _Receiver()
    yield r
    r.close()


def _start(steps, dsn, instances=(TEAM,), python=sys.executable, env=None, **case):
    case.update(steps=steps, dsn=dsn, instances=list(instances), release=RELEASE, plant=PLANT)
    p = subprocess.run([python, os.path.join(HERE, "reports_child.py"), json.dumps(case)],
                       capture_output=True, text=True, timeout=90, env={**os.environ, **(env or {})})
    assert p.returncode == 0, p.stderr[-3000:]
    return json.loads(p.stdout.strip().splitlines()[-1])


def _no_leaks(receiver):
    raw = b"".join(receiver.raw).decode()
    assert not [s for s in _LEAKS if s in raw], raw[:4000]


# --- who sends -------------------------------------------------------------------

@pytest.mark.parametrize("instances,env", [
    ((), {}),
    (({**TEAM, "enable": False},), {}),
    (({**TEAM, "api_url": "https://rivendell.example.com"},), {}),
    ((TEAM,), {"MYSTICAL_SENTRY": "0"}),
], ids=["no-connection", "disabled", "other-rivendell", "opted-out"])
def test_anything_but_a_team_install_sends_nothing_and_never_loads_the_sdk(receiver, instances, env):
    out = _start(["status", "dash", "thread"], receiver.dsn, instances, env=env)
    assert out["codes"] == [500]
    assert out["status"] == {"on": False}
    assert not out["booted"] and not out["sentry_imported"] and not out["vendor_on_path"]
    time.sleep(0.3)
    assert receiver.raw == []


def test_an_empty_dsn_keeps_a_team_install_off(receiver):
    out = _start(["status", "dash"], "")
    assert out["status"] == {"on": False} and not out["sentry_imported"] and not out["vendor_on_path"]
    assert receiver.raw == []


def test_an_sdk_that_fails_to_start_leaves_the_bridge_up_with_reports_off(receiver, tmp_path):
    (tmp_path / "sentry_sdk").mkdir()
    (tmp_path / "sentry_sdk" / "__init__.py").write_text("raise ImportError('a bad vendor refresh')\n")
    out = _start(["status", "dash"], receiver.dsn, vendor=str(tmp_path))
    assert out["codes"] == [500] and out["status"] == {"on": False} and not out["vendor_on_path"]
    assert receiver.raw == []


# --- what a crash carries -----------------------------------------------------------

def test_a_route_that_raises_sends_one_scrubbed_crash_and_still_answers_500(receiver):
    out = _start(["status", "crumbs", "dash"], receiver.dsn, outgoing=receiver.base + "/PLANTED-outgoing")
    assert out["codes"] == [500]
    assert out["status"] == {"on": True, "dsn": receiver.dsn, "user": "mahzi",
                             "os": "macos" if sys.platform == "darwin" else out["status"]["os"]}
    [ev] = receiver.events
    assert ev["tags"]["route"] == "GET /local/boom/:id"
    assert ev["tags"]["side"] == "bridge" and ev["tags"]["os"] == out["status"]["os"]
    assert ev["user"] == {"username": "mahzi"} and ev["release"] == RELEASE
    frames = ev["exception"]["values"][-1]["stacktrace"]["frames"]
    assert frames[-1]["abs_path"] == os.path.join(HERE, "reports_child.py")   # full paths stay
    assert not ev.get("breadcrumbs") and not any("vars" in f for f in frames)
    _no_leaks(receiver)


def test_a_mini_app_route_that_raises_sends_a_crash(receiver):
    out = _start(["mini"], receiver.dsn)
    assert out["mini"] == 500
    [ev] = receiver.events
    assert ev["tags"]["route"] == "GET /boom/:id" and ev["tags"]["surface"] == "miniapp"
    assert ev["user"] == {"username": "mahzi"} and ev["release"] == RELEASE


def test_a_bridge_thread_that_dies_sends_a_crash(receiver):
    _start(["thread"], receiver.dsn)
    [ev] = receiver.events
    assert ev["exception"]["values"][-1]["value"] == "a bridge thread died"
    assert ev["tags"]["side"] == "bridge"


def test_a_turn_that_ends_crashed_sends_its_error_and_only_the_prompts_first_line(receiver, tmp_path):
    cli = tmp_path / "claude"
    cli.write_text("#!/bin/sh\nsleep 0.2\necho 'Segfault in the CLI: last words' >&2\nexit 3\n")
    cli.chmod(0o755)
    out = _start(["turn"], receiver.dsn, claude_bin=str(cli))
    assert out["turn_status"] == "error"
    [ev] = receiver.events
    msg = ev.get("logentry", {}).get("formatted") or ev.get("logentry", {}).get("message") or ev.get("message")
    assert "Segfault in the CLI" in msg
    turn = ev["contexts"]["turn"]
    assert turn["prompt"] == "fix the login page"
    assert turn["session"] == out["session"] and turn["project"] == "p-crash"
    assert turn["model"] == "claude-test-model" and turn["account"] == "default"
    raw = b"".join(receiver.raw).decode()
    assert "second line" not in raw


# --- how much, and never in the way ------------------------------------------------------

def test_the_same_crash_twice_in_a_minute_sends_one(receiver):
    _start(["dash2"], receiver.dsn)
    assert len(receiver.events) == 1


def test_no_more_than_100_reports_an_hour(receiver):
    out = _start(["dash101"], receiver.dsn, distinct=True)
    assert out["codes"] == [500] * 101
    assert len(receiver.events) == 100


@pytest.mark.parametrize("down", ["refusing", "hanging"])
def test_a_dead_receiver_never_slows_a_request(down):
    if down == "hanging":
        r = _Receiver(hang=True)
        dsn = r.dsn
    else:
        r = _Receiver()
        dsn = r.dsn
        r.close()                       # nothing listens on that port now
    try:
        out = _start(["dash"], dsn, flush=False)
    finally:
        r.close()
    assert out["booted"] and out["codes"] == [500]
    assert out["slowest"] < 0.5


def _python310():
    found = shutil.which("python3.10")
    if not found and shutil.which("uv"):
        p = subprocess.run(["uv", "python", "find", "3.10"], capture_output=True, text=True)
        found = p.stdout.strip() if p.returncode == 0 else None
    return found


def test_the_vendored_sdk_imports_and_sends_under_python_3_10(receiver):
    py = _python310()
    if not py:
        pytest.skip("no Python 3.10 here")
    out = _start([], receiver.dsn, python=py, sdk_only=True)
    assert out == {"booted": True, "python": [3, 10]}
    [ev] = receiver.events
    assert ev["exception"]["values"][-1]["value"] == "sent from an older Python"
