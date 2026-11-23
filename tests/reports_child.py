"""One bridge start for tests/test_reports.py, in its own process: the gate is
decided once per process and the SDK, once in, hooks threads and the excepthook
for good, so no other test may share an interpreter with it.

argv[1] is the case as JSON; the last stdout line is what this process saw.
The suite's pins come from conftest itself (imported, not copied), so this
child runs against a fresh state dir and never the live one.
"""

import json
import logging
import os
import sys
import threading
import time
import types
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import pytest  # noqa: F401
except ImportError:            # a bare Python 3.10: conftest only needs the decorator
    sys.modules["pytest"] = types.SimpleNamespace(
        fixture=lambda *a, **k: a[0] if a and callable(a[0]) else (lambda f: f))
import conftest  # noqa: F401,E402

from bridge import config, reports, rivendell_instances, selfupdate, store  # noqa: E402

case = json.loads(sys.argv[1])
PLANT = case.get("plant") or {}
reports.DSN = case["dsn"]
selfupdate.BOOT_HEAD = case["release"]
store.init()
for inst in case.get("instances", []):
    rivendell_instances.add_instance(**inst)
reports.boot()

if case.get("sdk_only"):       # the SDK alone: the rest of the bridge needs 3.11's tomllib
    try:
        raise RuntimeError("sent from an older Python")
    except RuntimeError as e:
        reports.request_crash("dashboard", "GET", "/local/x", e)
    reports._sdk.flush(5)
    print(json.dumps({"booted": reports.on(), "python": list(sys.version_info[:2])}))
    sys.exit(0)

from bridge.dashboard import server as dash  # noqa: E402
from bridge.miniapp import server as mini  # noqa: E402

_get_api = dash.Handler._get_api


def _boom(self, path, qs):
    if not path.startswith("/local/boom/"):
        return _get_api(self, path, qs)
    planted_local = PLANT.get("local")  # noqa: F841 - must never reach a report
    n = path.rsplit("/", 1)[1]
    kind = type(f"Boom{n}", (RuntimeError,), {}) if case.get("distinct") else RuntimeError
    raise kind(PLANT.get("message", "boom"))


def _mini_boom(self, path):
    raise ValueError("mini app route failed")


dash.Handler._get_api = _boom
mini.Handler._serve_static = _mini_boom


def _serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def _get(port, path):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                 headers={"Host": f"127.0.0.1:{config.DASH_PORT}"})
    t = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            code, body = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, body = e.code, e.read()
    return code, json.loads(body or b"null"), time.monotonic() - t


out = {"booted": reports.on()}
dport, mport = _serve(dash.Handler), _serve(mini.Handler)
for step in case["steps"]:
    if step == "crumbs":       # a log line and an outgoing call, before the crash
        logging.getLogger("bridge.test").warning(PLANT["log"])
        try:
            urllib.request.urlopen(case["outgoing"], timeout=5).read()
        except (urllib.error.URLError, OSError):
            pass
    elif step.startswith("dash"):
        n = int(step[4:] or 1)
        got = [_get(dport, f"/local/boom/7f3a9c{i:02d}") for i in range(n)]
        out["codes"] = [c for c, _, _ in got]
        out["slowest"] = max(t for _, _, t in got)
    elif step == "mini":
        out["mini"] = _get(mport, "/boom/abc123def")[0]
    elif step == "status":
        out["status"] = _get(dport, "/local/reports")[1]
    elif step == "thread":
        def die():
            raise RuntimeError("a bridge thread died")
        t = threading.Thread(target=die, name="test-loop")
        t.start()
        t.join()
    elif step == "turn":
        from bridge import learn, runner, titler, toolsets
        config.CLAUDE_BIN = case["claude_bin"]
        for mod in (titler, learn):
            mod.kick = lambda *a, **k: None
        runner._announce_end = lambda job: None
        runner._notify = lambda *a, **k: None
        toolsets.ready = lambda: True
        store.default_disabled_tools = lambda: []
        sid = store.create_session(555, "p-crash", cwd=config.BASE_PATH)["id"]
        job = runner.start_streaming_job(555, PLANT["prompt"], [], project=config.BASE_PATH,
                                         session_id=sid, permission_mode="bypassPermissions",
                                         model="claude-test-model")
        assert job.exited.wait(30)
        out["session"], out["turn_status"] = sid, job.status

if reports.on() and case.get("flush", True):
    reports._sdk.flush(5)
out["sentry_imported"] = any(m == "sentry_sdk" or m.startswith("sentry_sdk.") for m in sys.modules)
out["vendor_on_path"] = reports.VENDOR in sys.path
print(json.dumps(out))
