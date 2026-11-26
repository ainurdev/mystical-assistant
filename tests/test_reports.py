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


# --- slow spots ----------------------------------------------------------------------

def _slow_spots(receiver):
    return [ev for ev in receiver.events if ev["tags"].get("kind") == "slow spot"]


def _name(ev):
    return ev.get("logentry", {}).get("formatted") or ev.get("logentry", {}).get("message") or ev.get("message")


def test_a_slow_route_sends_one_bridge_call_and_fast_streamed_or_long_ones_send_nothing(receiver):
    out = _start(["GET /local/slow/7f3a9c01?sleep=0.7", "GET /local/fast?sleep=0",
                  "GET /local/stream/session/abc123def?sleep=0.7", "GET /local/graph/explain?sleep=0.7",
                  "GET /local/storage?sleep=0.7"],
                 receiver.dsn)
    assert [c for c, _ in out["calls"]] == [200, 200, 200, 200, 200]
    [ev] = _slow_spots(receiver)
    assert _name(ev) == "bridge call: GET /local/slow/:id"
    assert ev["level"] == "warning" and ev["contexts"]["slow"]["status"] == 200
    assert ev["contexts"]["slow"]["ms"] >= 700
    assert ev["tags"]["side"] == "bridge" and ev["user"] == {"username": "mahzi"}


def test_the_same_slow_spot_twice_in_ten_minutes_sends_one(receiver):
    _start(["GET /local/slow/7f3a9c01?sleep=0.6", "GET /local/slow/9b2e4d07?sleep=0.6"], receiver.dsn)
    assert len(_slow_spots(receiver)) == 1


def test_a_wait_outside_the_bridge_leaves_the_requests_time(receiver):
    # GitHub through gh, Rivendell, the weather service, a login's meter through the CLI:
    # about 110 of the reports of 2026-11-25 and 26 were such reads, as slow as the network.
    out = _start(["GET /local/waits/7f3a9c01?outside=0.7",
                  "GET /local/both/7f3a9c01?outside=0.4&sleep=0.6",
                  "GET /local/after/7f3a9c01?sleep=0.3"], receiver.dsn)
    assert [c for c, _ in out["calls"]] == [200, 200, 200]
    [ev] = _slow_spots(receiver)
    assert _name(ev) == "bridge call: GET /local/both/:id"
    assert 600 <= ev["contexts"]["slow"]["ms"] < 900          # its own time, the 0.4 s outside left out


def test_a_long_poll_an_agents_tool_call_and_a_server_start_are_untimed(monkeypatch):
    # In this process, off the rule itself: the child can slow only GET routes of the page.
    from bridge import reports
    sent = []
    monkeypatch.setattr(reports, "_sdk", object())
    monkeypatch.setattr(reports, "_slow", lambda name, *a, **k: sent.append(name))
    for method, path in [("GET", "/local/runs/0123456789abcdef?wait=25"), ("POST", "/local/gateway"),
                         ("POST", "/local/server"), ("POST", "/local/git/worktree/remove"),
                         ("GET", "/local/complete/symbols?project=/x"), ("GET", "/local/runs")]:
        reports.bridge_call(method, path, 200, 30.0)
    assert sent == ["bridge call: GET /local/runs"]           # the list of runs waits on nothing


def test_gh_rivendell_and_the_weather_service_are_waits_outside_the_bridge(monkeypatch):
    import types
    import urllib.request
    from bridge import github, reports, rivendell, weather

    def run(*a, **k):
        time.sleep(0.05)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    class Answer:
        def __enter__(self):
            time.sleep(0.05)
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"{}"

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: Answer())
    reports.take_outside()
    github._run("git", "status")
    assert reports.take_outside() == 0                        # git is the bridge's own work
    github._run("gh", "pr", "view")
    assert reports.take_outside() >= 0.05
    weather._get_json("https://weather.test/now")
    assert reports.take_outside() >= 0.05
    rivendell.Worker._api(types.SimpleNamespace(api_url="https://rivendell.test", token="t"), "/plugin/x")
    assert reports.take_outside() >= 0.05


def _cli(tmp_path, wait):
    cli = tmp_path / "claude"
    cli.write_text("#!/bin/sh\n"
                   f"sleep {wait}\n"
                   """echo '{"type":"system","subtype":"init"}'\n"""
                   """echo '{"type":"result","subtype":"success","result":"ok","num_turns":1}'\n""")
    cli.chmod(0o755)
    return str(cli)


def test_a_turn_slow_to_start_sends_turn_start_naming_what_it_waited_on(receiver, tmp_path):
    out = _start(["turn"], receiver.dsn, claude_bin=_cli(tmp_path, 2.5))
    assert out["turn_status"] == "done"
    [ev] = _slow_spots(receiver)
    assert _name(ev) == "turn start"
    slow = ev["contexts"]["slow"]
    assert slow["waited_on"] == "starting Claude" and slow["ms"] >= 2500
    assert slow["session"] == out["session"] and slow["project"] == "p-crash"
    assert slow["prompt"] == "fix the login page"
    _no_leaks(receiver)


def test_a_turn_quick_to_start_sends_nothing(receiver, tmp_path):
    out = _start(["turn"], receiver.dsn, claude_bin=_cli(tmp_path, 0))
    assert out["turn_status"] == "done"
    assert receiver.events == []


def test_each_bridge_start_sends_its_start_up_with_four_phases(receiver):
    _start(["GET /local/sessions", "GET /local/sessions"], receiver.dsn)
    [ev] = [e for e in _slow_spots(receiver) if _name(e) == "start-up: bridge"]   # a busy machine adds a bridge call
    phases = ev["contexts"]["slow"]["phases"]
    assert list(phases) == ["imports", "store", "servers listening", "first session list"]
    assert phases["imports"] <= phases["store"] <= phases["servers listening"] <= phases["first session list"]


def test_off_installs_time_nothing_and_send_nothing(receiver, tmp_path):
    out = _start(["GET /local/sessions", "GET /local/slow/7f3a9c01?sleep=0.6"], receiver.dsn, instances=())
    assert not out["booted"] and not out["sentry_imported"]
    time.sleep(0.3)
    assert receiver.raw == []


@pytest.mark.parametrize("down", ["refusing", "hanging"])
def test_a_dead_receiver_never_slows_a_slow_route_or_a_turn(receiver, down, tmp_path):
    steps, cli = ["GET /local/slow/7f3a9c01?sleep=0.6", "turn"], _cli(tmp_path, 2.2)
    up = _start(steps, receiver.dsn, claude_bin=cli)
    r = _Receiver(hang=down == "hanging")
    if down == "refusing":
        r.close()
    try:
        out = _start(steps, r.dsn, flush=False, claude_bin=cli)
    finally:
        r.close()
    assert out["booted"] and out["turn_status"] == "done"
    assert len(_slow_spots(receiver)) == 2                    # both were slow spots, sent with it up
    assert out["calls"][0][1] < up["calls"][0][1] + 0.3
    assert out["turn_took"] < up["turn_took"] + 0.5


def test_a_blank_request_line_is_refused_without_a_crash(receiver):
    out = _start(["blank"], receiver.dsn)
    assert out["handler_errors"] == 0
