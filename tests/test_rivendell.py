"""Unit tests for the rivendell PR-review plugin (bridge/rivendell.py).

Covers the pure/mechanical parts of one Worker (one rivendell-api connection):
client-frame masking round-trips through the server-side decoder (the same code
rivendell-api's `ws` library implements), the RFC 6455 client handshake against
a socketpair-backed fake server, event filtering/dedup, job waiting, the WS-URL
derivation, and the manager that starts/stops/rewires workers to match the
enabled instances. No network, no Claude.
"""

import base64
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("BASE_PATH", tempfile.mkdtemp())
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import rivendell, wsutil  # noqa: E402


def _inst(**kw):
    """A worker config dict with sensible defaults; override per test."""
    d = {"id": "t1", "name": "test", "enable": True,
         "api_url": "http://api.example:3001", "token": "rvd_testtoken",
         "ws_url": "", "model": "opus", "workdir": "",
         "review_timeout": 3600, "impl_timeout": 10800}
    d.update(kw)
    return d


def _worker(**kw):
    return rivendell.Worker(_inst(**kw))


# --- framing -----------------------------------------------------------------

def test_masked_frame_roundtrips_through_decoder():
    """A client (masked) frame must unmask to the original payload server-side."""
    payload = json.dumps({"type": "pr-review-request", "requestId": "r1"}).encode()
    frame = wsutil.encode_frame(payload, wsutil.OP_TEXT, masked=True)
    assert frame[1] & 0x80, "mask bit must be set on client frames"
    opcode, decoded = wsutil.decode_frame(io.BytesIO(frame))
    assert opcode == wsutil.OP_TEXT
    assert decoded == payload


def test_masked_frame_sizes():
    """Length encodings (7-bit / 16-bit / 64-bit) all survive masking."""
    for size in (5, 200, 70_000):
        payload = os.urandom(size)
        frame = wsutil.encode_frame(payload, wsutil.OP_BINARY, masked=True)
        _, decoded = wsutil.decode_frame(io.BytesIO(frame))
        assert decoded == payload


def test_unmasked_default_unchanged():
    """Default (server) framing stays unmasked — the dashboard terminal path."""
    frame = wsutil.encode_frame(b"hi", wsutil.OP_TEXT)
    assert not frame[1] & 0x80


# --- handshake ---------------------------------------------------------------

def test_client_handshake(monkeypatch):
    """_connect sends a well-formed upgrade (with the instance's bearer header)
    and verifies the Sec-WebSocket-Accept echo."""
    server, client = socket.socketpair()
    monkeypatch.setattr("socket.create_connection", lambda *a, **k: client)
    w = _worker(ws_url="ws://api.example:3001/agent", token="rvd_testtoken")

    captured = {}

    def fake_server():
        request = b""
        while b"\r\n\r\n" not in request:
            request += server.recv(4096)
        captured["request"] = request.decode()
        key = [line.split(": ", 1)[1] for line in captured["request"].split("\r\n")
               if line.lower().startswith("sec-websocket-key")][0]
        server.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {wsutil.accept_key(key)}\r\n"
            "\r\n").encode())

    t = threading.Thread(target=fake_server, daemon=True)
    t.start()
    sock, rfile = w._connect()
    t.join(timeout=5)

    assert "GET /agent HTTP/1.1" in captured["request"]
    assert "Authorization: Bearer rvd_testtoken" in captured["request"]
    assert "Upgrade: websocket" in captured["request"]
    key_line = [l for l in captured["request"].split("\r\n")
                if l.startswith("Sec-WebSocket-Key: ")][0]
    assert base64.b64decode(key_line.split(": ", 1)[1])  # valid base64 nonce
    sock.close()
    server.close()


def test_client_handshake_rejects_bad_accept(monkeypatch):
    server, client = socket.socketpair()
    monkeypatch.setattr("socket.create_connection", lambda *a, **k: client)
    w = _worker(ws_url="ws://api.example:3001/agent")

    def fake_server():
        request = b""
        while b"\r\n\r\n" not in request:
            request += server.recv(4096)
        server.sendall(b"HTTP/1.1 101 Switching Protocols\r\n"
                       b"Sec-WebSocket-Accept: bogus\r\n\r\n")

    threading.Thread(target=fake_server, daemon=True).start()
    try:
        w._connect()
        raised = False
    except ConnectionError:
        raised = True
    assert raised, "a wrong Sec-WebSocket-Accept must fail the handshake"
    server.close()


def test_client_handshake_401_is_an_auth_error(monkeypatch):
    """A proxy/app rejecting the upgrade with 401 is a token problem, surfaced as
    _AuthError so the listener stops dialing rather than backing off."""
    server, client = socket.socketpair()
    monkeypatch.setattr("socket.create_connection", lambda *a, **k: client)
    w = _worker(ws_url="ws://api.example:3001/agent")

    def fake_server():
        request = b""
        while b"\r\n\r\n" not in request:
            request += server.recv(4096)
        server.sendall(b"HTTP/1.1 401 Unauthorized\r\n\r\n")

    threading.Thread(target=fake_server, daemon=True).start()
    raised = None
    try:
        w._connect()
    except rivendell._AuthError:
        raised = "auth"
    except ConnectionError:
        raised = "conn"
    assert raised == "auth", "a 401 handshake must raise _AuthError, not ConnectionError"
    server.close()


# --- event handling ----------------------------------------------------------

def _drain(w):
    drained = []
    while not w._queue.empty():
        drained.append(w._queue.get_nowait())
    return drained


def test_handle_message_filters_and_dedups():
    w = _worker()
    event = json.dumps({"type": "pr-review-request", "requestId": "abc",
                        "pullRequest": {"number": 7,
                                        "repositoryFullName": "acme/app"}}).encode()
    w._handle_message(event)
    w._handle_message(event)                       # duplicate: dropped
    w._handle_message(b"not json at all")          # noise: ignored
    w._handle_message(json.dumps({"type": "other"}).encode())
    assert _drain(w) == [("review", "abc", "acme/app")]


def test_handle_message_implementation_requests():
    """task-implementation-request events queue as "impl" with the repo slug;
    dedup is per kind, so a review and an implementation may share an id."""
    w = _worker()
    impl = json.dumps({"type": "task-implementation-request",
                       "requestId": "abc",
                       "task": {"name": "Add login"},
                       "repository": {"fullName": "acme/app-mirror"}}).encode()
    review = json.dumps({"type": "pr-review-request", "requestId": "abc",
                         "pullRequest": {"number": 7}}).encode()
    w._handle_message(impl)
    w._handle_message(impl)                        # duplicate: dropped
    w._handle_message(review)                      # other kind: kept
    assert _drain(w) == [("impl", "abc", "acme/app-mirror"),
                         ("review", "abc", None)]


def test_handle_message_todolist_requests():
    """project-todolist-request events queue as "todolist" with the project
    name; they carry no repo (the prompt has the whole project context)."""
    w = _worker()
    tl = json.dumps({"type": "project-todolist-request",
                     "requestId": "t9",
                     "project": {"id": "p1", "name": "Rivendell"}}).encode()
    w._handle_message(tl)
    w._handle_message(tl)                          # duplicate: dropped
    assert _drain(w) == [("todolist", "t9", "Rivendell")]


def test_handle_message_task_description_requests():
    """task-description-request events queue as "taskdesc" with the task name;
    they carry no repo (the whole task/project context is in the prompt, and
    rivendell-api writes the result straight onto the Teamwork task)."""
    w = _worker()
    td = json.dumps({"type": "task-description-request",
                     "requestId": "d3",
                     "task": {"id": "k1", "name": "Add login",
                              "htmlUrl": "https://tw/1"}}).encode()
    w._handle_message(td)
    w._handle_message(td)                          # duplicate: dropped
    assert _drain(w) == [("taskdesc", "d3", "Add login")]


def test_dedup_is_separate_across_all_kinds():
    """The kinds have separate id spaces — the same id in each is kept."""
    w = _worker()
    for typ, extra in (("pr-review-request", {"pullRequest": {}}),
                       ("task-implementation-request",
                        {"task": {}, "repository": {}}),
                       ("project-todolist-request", {"project": {}}),
                       ("task-description-request", {"task": {}})):
        w._handle_message(json.dumps({"type": typ, "requestId": "same", **extra}).encode())
    kinds = [k for (k, _rid, _s) in _drain(w)]
    assert kinds == ["review", "impl", "todolist", "taskdesc"]


def test_run_todolist_runs_in_workdir_without_checkout(monkeypatch):
    """A todolist needs no repo match: it runs in the worker's workdir and never
    calls _find_checkout."""
    w = _worker(workdir="/dedicated")
    posted, ran = [], []
    monkeypatch.setattr(w, "_fetch_prompt",
                        lambda kind_path, rid: {"prompt": "make a checklist"})
    monkeypatch.setattr(w, "_find_checkout",
                        lambda slug: (_ for _ in ()).throw(AssertionError("no checkout for todolists")))
    monkeypatch.setattr(w, "_start_run",
                        lambda prompt, workdir: ran.append((prompt, workdir)) or _StubJob("done", result="- [ ] do it"))
    monkeypatch.setattr(w, "_post_result",
                        lambda kind_path, rid, ok, text: posted.append((kind_path, rid, ok, text)))
    w._run_todolist("t1", "Rivendell")
    assert ran == [("make a checklist", "/dedicated")]
    assert posted == [("todolist-requests", "t1", True, "- [ ] do it")]


def test_run_taskdesc_runs_in_workdir_without_checkout(monkeypatch):
    """A task description needs no repo match: it runs in the worker's workdir
    and never calls _find_checkout — the result posts back to the task-
    description endpoint (rivendell-api writes it onto the Teamwork task)."""
    w = _worker(workdir="/dedicated")
    posted, ran = [], []
    monkeypatch.setattr(w, "_fetch_prompt",
                        lambda kind_path, rid: {"prompt": "write a description"})
    monkeypatch.setattr(w, "_find_checkout",
                        lambda slug: (_ for _ in ()).throw(AssertionError("no checkout for task descriptions")))
    monkeypatch.setattr(w, "_start_run",
                        lambda prompt, workdir: ran.append((prompt, workdir)) or _StubJob("done", result="## Context\n…"))
    monkeypatch.setattr(w, "_post_result",
                        lambda kind_path, rid, ok, text: posted.append((kind_path, rid, ok, text)))
    w._run_taskdesc("d1", "Add login")
    assert ran == [("write a description", "/dedicated")]
    assert posted == [("task-description-requests", "d1", True, "## Context\n…")]


def test_workers_have_independent_queues():
    """Two instances dedup and queue separately — the same request id in each
    is two runs, not one deduped away."""
    a, b = _worker(id="a", name="prod"), _worker(id="b", name="local")
    event = json.dumps({"type": "pr-review-request", "requestId": "x",
                        "pullRequest": {"repositoryFullName": "acme/app"}}).encode()
    a._handle_message(event)
    b._handle_message(event)
    assert _drain(a) == [("review", "x", "acme/app")]
    assert _drain(b) == [("review", "x", "acme/app")]


# --- job waiting -------------------------------------------------------------

class _StubJob:
    def __init__(self, status, result=None, error_msg=None, texts=()):
        self.status, self.result = status, result
        self.error_msg, self.texts = error_msg, list(texts)
        self.interrupted = False

    def interrupt(self):
        self.interrupted = True
        self.status = "error"


def test_wait_job_done_returns_result():
    ok, text = _worker()._wait_job(_StubJob("done", result="LGTM"), 60)
    assert ok and text == "LGTM"


def test_wait_job_done_falls_back_to_texts():
    ok, text = _worker()._wait_job(_StubJob("done", texts=["a", "b"]), 60)
    assert ok and text == "ab"


def test_wait_job_error_returns_message():
    ok, text = _worker()._wait_job(_StubJob("error", error_msg="boom"), 60)
    assert not ok and text == "boom"


def test_wait_job_timeout_interrupts():
    job = _StubJob("running")
    ok, text = _worker()._wait_job(job, 0)
    assert not ok and job.interrupted and "timed out" in text


# --- repo discovery ----------------------------------------------------------

def _reset_checkout_cache():
    with rivendell._checkout_lock:
        rivendell._checkout_cache = {}
        rivendell._checkout_cache_at = 0.0


def test_find_checkout_matches_case_insensitively(monkeypatch):
    _reset_checkout_cache()
    w = _worker(workdir="")
    monkeypatch.setattr("bridge.browser.list_projects",
                        lambda: ["/acme/app", "/acme/lib"])
    monkeypatch.setattr(
        "bridge.github.remote_slug",
        lambda path: {"app": "Acme/App", "lib": "acme/lib"}[
            os.path.basename(path)])
    expected = os.path.join(rivendell.config.BASE_PATH, "acme/app")
    assert w._find_checkout("acme/app") == expected
    assert w._find_checkout("ACME/APP") == expected
    assert w._find_checkout(None) is None


def test_find_checkout_miss_rescans_and_ttl_expires(monkeypatch):
    _reset_checkout_cache()
    w = _worker(workdir="")
    projects = ["/acme/app"]
    scans = []
    monkeypatch.setattr("bridge.browser.list_projects",
                        lambda: scans.append(1) or list(projects))
    monkeypatch.setattr("bridge.github.remote_slug",
                        lambda path: f"acme/{os.path.basename(path)}")

    assert w._find_checkout("acme/new") is None    # miss: scanned once
    projects.append("/acme/new")
    assert w._find_checkout("acme/new") is not None  # miss: rescan finds it
    assert w._find_checkout("acme/app") is not None  # hit: cache, no scan
    assert len(scans) == 2

    # An expired cache rescans even on a hit.
    rivendell._checkout_cache_at = 0.0
    assert w._find_checkout("acme/app") is not None
    assert len(scans) == 3


def test_find_checkout_prefers_matching_workdir(monkeypatch):
    _reset_checkout_cache()
    w = _worker(workdir="/dedicated/app")
    monkeypatch.setattr("bridge.github.remote_slug",
                        lambda path: "acme/app" if path == "/dedicated/app" else None)
    monkeypatch.setattr("bridge.browser.list_projects", lambda: [])
    assert w._find_checkout("acme/app") == "/dedicated/app"


def test_run_implementation_fails_without_checkout(monkeypatch):
    """No local checkout for the slug -> FAILED result, never a fallback run."""
    w = _worker()
    posted = []
    monkeypatch.setattr(w, "_fetch_prompt",
                        lambda kind_path, rid: {"prompt": "do it",
                                                "repositoryFullName": "acme/gone"})
    monkeypatch.setattr(w, "_find_checkout", lambda slug: None)
    monkeypatch.setattr(w, "_post_result",
                        lambda kind_path, rid, ok, text:
                        posted.append((kind_path, rid, ok, text)))
    monkeypatch.setattr(
        w, "_start_run",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not run")))
    w._run_implementation("r1", "acme/other")
    assert posted == [("implementation-requests", "r1", False,
                       f"no local checkout for 'acme/gone' under "
                       f"{rivendell.config.BASE_PATH}")]


# --- ws-url derivation -------------------------------------------------------

def test_ws_url_derived_from_api_url():
    """http -> ws with /agent appended, read live from the instance."""
    assert _worker(ws_url="", api_url="http://api.example:3001")._ws_url() \
        == "ws://api.example:3001/agent"
    assert _worker(ws_url="", api_url="https://api.example")._ws_url() \
        == "wss://api.example/agent"


def test_ws_url_override_wins():
    assert _worker(ws_url="ws://elsewhere/sock")._ws_url() == "ws://elsewhere/sock"


def test_origin_is_namespaced_per_instance():
    """A run's session origin names its instance, under the rivendell prefix so
    it stays visible in the dashboards (config.is_plugin_origin)."""
    assert _worker(name="production").origin == "rivendell:production"
    assert _worker(name="Local Dev").origin == "rivendell:local-dev"
    assert rivendell.config.is_plugin_origin("rivendell:production")
    assert rivendell.config.is_plugin_origin("rivendell")
    assert not rivendell.config.is_plugin_origin("dashboard")


# --- manager (reconfigure) ---------------------------------------------------

def _patch_worker_lifecycle(monkeypatch, calls):
    monkeypatch.setattr(rivendell.Worker, "start",
                        lambda self: calls.append(("start", self.id)))
    monkeypatch.setattr(rivendell.Worker, "stop",
                        lambda self: calls.append(("stop", self.id)))
    monkeypatch.setattr(rivendell.Worker, "_drop_connection",
                        lambda self: calls.append(("drop", self.id)))


def test_reconfigure_starts_enabled_and_stops_removed(monkeypatch):
    calls = []
    insts = [_inst(id="a", enable=True)]
    monkeypatch.setattr("bridge.rivendell_instances.raw_instances", lambda: list(insts))
    _patch_worker_lifecycle(monkeypatch, calls)
    rivendell._workers.clear()

    rivendell.reconfigure()
    assert ("start", "a") in calls and "a" in rivendell._workers

    # Disabled instances are stopped and dropped from the running set.
    insts[:] = [_inst(id="a", enable=False)]
    rivendell.reconfigure()
    assert ("stop", "a") in calls and "a" not in rivendell._workers
    rivendell._workers.clear()


def test_reconfigure_swaps_changed_config_in_place(monkeypatch):
    """A URL/token edit keeps the same worker (so an in-flight review survives)
    and only forces a reconnect with the new config."""
    calls = []
    insts = [_inst(id="a", enable=True, api_url="http://one")]
    monkeypatch.setattr("bridge.rivendell_instances.raw_instances", lambda: list(insts))
    _patch_worker_lifecycle(monkeypatch, calls)
    rivendell._workers.clear()

    rivendell.reconfigure()
    w = rivendell._workers["a"]
    insts[:] = [_inst(id="a", enable=True, api_url="http://two")]
    rivendell.reconfigure()

    assert rivendell._workers["a"] is w, "must reuse the worker, not replace it"
    assert w.inst["api_url"] == "http://two"
    assert ("drop", "a") in calls
    rivendell._workers.clear()


def test_status_snapshot_tracks_state():
    w = _worker()
    assert w.status_snapshot()["state"] == "off"
    w._set_status("connecting", "ws://x/agent")
    assert w.status_snapshot()["state"] == "connecting"
    assert w.connected_since is None
    w._set_status("connected", "ws://x/agent")
    snap = w.status_snapshot()
    assert snap["state"] == "connected" and snap["connected_since"] is not None
    w._set_status("error", "boom")
    snap = w.status_snapshot()
    assert snap["state"] == "error" and snap["detail"] == "boom"
    assert snap["connected_since"] is None, "an error clears the connected clock"


def test_manager_status_exposes_running_workers(monkeypatch):
    monkeypatch.setattr("bridge.rivendell_instances.raw_instances",
                        lambda: [_inst(id="a", enable=True)])
    monkeypatch.setattr(rivendell.Worker, "start", lambda self: None)
    monkeypatch.setattr(rivendell.Worker, "_drop_connection", lambda self: None)
    rivendell._workers.clear()
    rivendell.reconfigure()
    assert rivendell.status()["a"]["state"] == "off"   # started but not yet dialed
    rivendell._workers.clear()


def test_reconfigure_skips_instances_without_url_or_token(monkeypatch):
    calls = []
    monkeypatch.setattr("bridge.rivendell_instances.raw_instances",
                        lambda: [_inst(id="a", enable=True, token=""),
                                 _inst(id="b", enable=True, api_url="")])
    _patch_worker_lifecycle(monkeypatch, calls)
    rivendell._workers.clear()
    rivendell.reconfigure()
    assert not rivendell._workers and not calls
    rivendell._workers.clear()


# --- token rejection: idle until the token changes ---------------------------

def _wait_until(pred, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met within timeout")


def test_block_on_token_records_failing_token_and_status():
    w = _worker(token="bad")
    w._block_on_token("token rejected by gateway (4401)")
    assert w._blocked_token == "bad"
    assert w.status == "auth_error"
    assert w.status_snapshot()["connected_since"] is None


def test_auth_error_stops_dialing_until_token_changes(monkeypatch):
    """A rejected token idles the listener — no reconnect churn — until the token
    is changed, at which point _wake resumes a single fresh dial."""
    w = _worker(token="bad")
    attempts = []

    def fake_connect():
        attempts.append(w.token)
        raise rivendell._AuthError("token rejected by gateway (4401)")

    monkeypatch.setattr(w, "_connect", fake_connect)
    monkeypatch.setattr(w, "_catch_up", lambda: 0)

    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    try:
        _wait_until(lambda: len(attempts) == 1)
        assert w.status == "auth_error" and w._blocked_token == "bad"
        # It parks on the bad token — no busy re-dialing.
        time.sleep(0.2)
        assert len(attempts) == 1, "must not re-dial a rejected token"

        # Change the token and wake it: exactly one fresh dial, with the new token.
        w.inst = _inst(token="good")
        w._wake.set()
        _wait_until(lambda: len(attempts) == 2)
        assert attempts[1] == "good"
    finally:
        w.stop()
        t.join(timeout=2)


def test_gateway_close_4403_is_treated_as_token_rejection(monkeypatch):
    """The gateway accepts the upgrade then closes 4401/4403 for a bad/insufficient
    token; the listener must read that close code as a token rejection (park), not
    a transient drop (backoff-reconnect)."""
    server, client = socket.socketpair()
    monkeypatch.setattr("socket.create_connection", lambda *a, **k: client)
    w = _worker(ws_url="ws://api.example:3001/agent", token="bad")
    monkeypatch.setattr(w, "_catch_up", lambda: 0)

    def fake_server():
        request = b""
        while b"\r\n\r\n" not in request:
            request += server.recv(4096)
        key = [line.split(": ", 1)[1] for line in request.decode().split("\r\n")
               if line.lower().startswith("sec-websocket-key")][0]
        server.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            f"Sec-WebSocket-Accept: {wsutil.accept_key(key)}\r\n\r\n").encode())
        payload = (4403).to_bytes(2, "big") + b"LLM capability required"
        server.sendall(wsutil.encode_frame(payload, wsutil.OP_CLOSE, masked=False))

    threading.Thread(target=fake_server, daemon=True).start()
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    try:
        _wait_until(lambda: w.status == "auth_error")
        assert w._blocked_token == "bad"
        assert "4403" in w.status_detail
    finally:
        w.stop()
        t.join(timeout=2)
        server.close()


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
