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
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("BASE_PATH", tempfile.mkdtemp())
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

import pytest  # noqa: E402

from bridge import rivendell, wsutil  # noqa: E402

_real_ack = rivendell.Worker._ack


@pytest.fixture(autouse=True)
def acks(monkeypatch):
    """Acks go off-thread over HTTP; record them instead, so no test reaches the
    network. The (key, state) pairs sent, in order."""
    sent = []
    monkeypatch.setattr(rivendell.Worker, "_ack",
                        lambda self, key, state: sent.append((key, state)))
    return sent


@pytest.fixture(autouse=True)
def no_link_alerts(monkeypatch):
    """A rejected token (or a long outage) pings Telegram once per break
    (Worker._alert_broken); no test here may reach the network for it."""
    monkeypatch.setattr(rivendell.Worker, "_alert_broken", lambda self: None)


def _http_error(code, path="/x"):
    return urllib.error.HTTPError(f"http://api{path}", code, "err", None, None)


def _raise_http(code):
    """An _api stand-in that fails every call with HTTP `code`."""
    def api(path, payload=None):
        raise _http_error(code, path)
    return api


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
    """The pending requests as (kind, request_id, slug) tuples, oldest first —
    requests are held PENDING for the operator now, not auto-consumed."""
    items = w.queue_snapshot()
    w._pending.clear()
    return [(it["kind"], it["request_id"], it["slug"]) for it in items]


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


def test_handle_message_keeps_the_batch_on_the_row():
    w = _worker()
    w._handle_message(json.dumps({
        "type": "task-implementation-request", "requestId": "b1",
        "task": {"name": "Login fixes (2 tasks)"}, "repository": {"fullName": "acme/app"},
        "batch": {"id": "bb", "name": "Login fixes", "mode": "queue",
                  "url": "https://rv/task-management/sessions/s1",
                  "tasks": [{"id": "t1", "externalId": "1", "name": "A", "url": "https://rv/t/1"}]},
    }).encode())
    [row] = w.queue_snapshot()
    assert row["label"] == "Login fixes" and row["link"] == "https://rv/task-management/sessions/s1"
    assert row["mode"] == "queue" and row["batch"]["tasks"][0]["url"] == "https://rv/t/1"


def test_queue_snapshot_labels_a_plain_request_by_its_slug():
    w = _worker()
    w._enqueue("impl", "r1", "acme/app")
    [row] = w.queue_snapshot()
    assert row["label"] == "acme/app" and row["link"] is None and row["mode"] is None


def test_catch_up_keeps_the_batch_too(monkeypatch):
    w = _worker()
    listing = {"/plugin/implementation-requests": [
        {"id": "b1", "repositoryFullName": "acme/app",
         "batch": {"id": "bb", "name": "Login fixes", "mode": "subagents", "url": "https://rv/s/1", "tasks": []}}]}
    monkeypatch.setattr(w, "_api", lambda path, payload=None: listing.get(path, []))
    monkeypatch.setattr(w, "_apply_policy", lambda key: None)
    assert w._catch_up() == 1
    [row] = w.queue_snapshot()
    assert row["label"] == "Login fixes" and row["mode"] == "subagents"


def test_queued_message_names_the_batch():
    w = _worker()
    key = w._enqueue("impl", "b1", "acme/app",
                     batch={"name": "Login fixes", "mode": "queue", "url": None, "tasks": []})
    text, _ = w._queued_message(w._pending[key], "tok")
    assert "batch queued — Login fixes" in text
    plain = w._enqueue("impl", "r2", "acme/app")
    text, _ = w._queued_message(w._pending[plain], "tok")
    assert "implementation queued — acme/app" in text


def test_running_rows_carry_the_session_and_link():
    w = _worker()
    w._track("r1", "impl", "acme/app", "sess-1", label="Login fixes", link="https://rv/s/1")
    [row] = w.running_snapshot()
    assert row["request_id"] == "r1" and row["session_id"] == "sess-1" and row["key"] == "impl:r1"
    assert row["label"] == "Login fixes" and row["link"] == "https://rv/s/1" and row["kind"] == "impl"
    assert row["instance_id"] == "t1" and isinstance(row["created_at"], float)
    w._untrack("r1")
    assert w.running_snapshot() == []


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


def test_handle_message_records_the_todolist_step():
    """A todolist's two steps share the event and the "todolist" kind; the
    event's `kind` only records which step it is (None from an older API)."""
    w = _worker()
    for rid, kind in (("a", "RECOMMENDATIONS"), ("b", "TODOLIST"), ("c", None)):
        w._handle_message(json.dumps({
            "type": "project-todolist-request", "requestId": rid,
            **({"kind": kind} if kind else {}),
            "project": {"id": "p1", "name": "Rivendell"}}).encode())
    steps = [(r["key"], r["step"]) for r in w.queue_snapshot()]
    assert steps == [("todolist:a", "recommendations"),
                     ("todolist:b", "todolist"), ("todolist:c", None)]


def test_catch_up_records_the_todolist_step(monkeypatch):
    """Catch-up reads the step from each listed request's `kind` too."""
    w = _worker()
    monkeypatch.setattr(w, "_apply_policy", lambda key: None)

    def api(path, payload=None):
        if path == "/plugin/todolist-requests":
            return [{"id": "t1", "projectName": "Proj", "kind": "RECOMMENDATIONS"}]
        return []
    monkeypatch.setattr(w, "_api", api)
    w._catch_up()
    assert [(r["key"], r["step"]) for r in w.queue_snapshot()] == [
        ("todolist:t1", "recommendations")]


def test_recommendations_are_labelled_as_such():
    """The Telegram ping names a recommendations run for what it is."""
    w = _worker(name="prod")
    item = {"key": "todolist:t1", "kind": "todolist", "request_id": "t1",
            "slug": "Proj", "step": "recommendations", "created_at": 0.0}
    text, _kb = w._queued_message(item, "tok")
    assert "task recommendations" in text and "Proj" in text
    item["step"] = "todolist"
    assert "Rivendell todolist queued" in w._queued_message(item, "tok")[0]


def test_run_todolist_posts_recommendations_json_verbatim(monkeypatch):
    """A recommendations run answers JSON; the bridge posts it untouched to the
    same todolist endpoint — rivendell-api parses it by the request's kind."""
    w = _worker(workdir="/dedicated")
    answer = '{"recommendations": [{"action": "create", "title": "Fix it"}]}'
    posted = []
    monkeypatch.setattr(w, "_fetch_prompt", lambda kind_path, rid: {"prompt": "recommend"})
    monkeypatch.setattr(w, "_start_run", lambda prompt, workdir: _StubJob("done", result=answer))
    monkeypatch.setattr(w, "_post_result",
                        lambda kind_path, rid, ok, text: posted.append((kind_path, rid, ok, text)))
    w._run_todolist("t1", "Proj", "recommendations")
    assert posted == [("todolist-requests", "t1", True, answer)]


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


def test_handle_message_changelog_requests():
    """changelog-request events queue as "changelog" with the project name; the
    picked tasks/PRs/commits are rendered into the prompt server-side."""
    w = _worker()
    cl = json.dumps({"type": "changelog-request",
                     "requestId": "c7",
                     "project": {"id": "p1", "name": "Rivendell"}}).encode()
    w._handle_message(cl)
    w._handle_message(cl)                          # duplicate: dropped
    assert _drain(w) == [("changelog", "c7", "Rivendell")]


def test_handle_message_news_requests():
    """news-request events queue as "news" with the reader's name; the paper is
    written by that reader's own bridge from rivendell's MCP context."""
    w = _worker()
    nw = json.dumps({"type": "news-request", "requestId": "n7", "editionDate": "2026-10-09",
                     "user": {"id": "u1", "name": "Mahdi"}}).encode()
    w._handle_message(nw)
    w._handle_message(nw)                          # duplicate: dropped
    assert _drain(w) == [("news", "n7", "Mahdi")]


def test_dedup_is_separate_across_all_kinds():
    """The kinds have separate id spaces — the same id in each is kept."""
    w = _worker()
    for typ, extra in (("pr-review-request", {"pullRequest": {}}),
                       ("task-implementation-request",
                        {"task": {}, "repository": {}}),
                       ("project-todolist-request", {"project": {}}),
                       ("task-description-request", {"task": {}}),
                       ("changelog-request", {"project": {}}),
                       ("news-request", {"user": {}})):
        w._handle_message(json.dumps({"type": typ, "requestId": "same", **extra}).encode())
    kinds = [k for (k, _rid, _s) in _drain(w)]
    assert kinds == ["review", "impl", "todolist", "taskdesc", "changelog", "news"]


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


def test_run_changelog_runs_in_workdir_without_checkout(monkeypatch):
    """A changelog needs no repo match: it runs in the worker's workdir and
    posts the markdown back to the changelog endpoint."""
    w = _worker(workdir="/dedicated")
    posted, ran = [], []
    monkeypatch.setattr(w, "_fetch_prompt",
                        lambda kind_path, rid: {"prompt": "write a changelog"})
    monkeypatch.setattr(w, "_find_checkout",
                        lambda slug: (_ for _ in ()).throw(AssertionError("no checkout for changelogs")))
    monkeypatch.setattr(w, "_start_run",
                        lambda prompt, workdir: ran.append((prompt, workdir)) or _StubJob("done", result="## Unreleased"))
    monkeypatch.setattr(w, "_post_result",
                        lambda kind_path, rid, ok, text: posted.append((kind_path, rid, ok, text)))
    w._run_changelog("c1", "Rivendell")
    assert ran == [("write a changelog", "/dedicated")]
    assert posted == [("changelog-requests", "c1", True, "## Unreleased")]


def test_run_news_forces_the_rivendell_mcp_server(monkeypatch):
    """A newspaper needs no checkout, and it is nothing without rivendell's MCP
    tools: the run asks for that server whatever the operator's tool defaults
    say, and the JSON posts back to the news endpoint verbatim."""
    w = _worker(workdir="/dedicated")
    posted, ran = [], []
    monkeypatch.setattr(w, "_fetch_prompt",
                        lambda kind_path, rid: {"prompt": "write the paper"})
    monkeypatch.setattr(w, "_find_checkout",
                        lambda slug: (_ for _ in ()).throw(AssertionError("no checkout for newspapers")))
    monkeypatch.setattr(w, "_start_run",
                        lambda prompt, workdir, hang_timeout=None, mcp_on=None:
                        ran.append((prompt, workdir, mcp_on)) or _StubJob("done", result='{"lead": null}'))
    monkeypatch.setattr(w, "_post_result",
                        lambda kind_path, rid, ok, text: posted.append((kind_path, rid, ok, text)))
    w._run_news("n1", "Mahdi")
    assert ran == [("write the paper", "/dedicated", "rivendell")]
    assert posted == [("news-requests", "n1", True, '{"lead": null}')]


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


# --- accept/reject gate ------------------------------------------------------

def test_enqueue_holds_pending_until_accepted():
    """A request event is held PENDING, exposed to the dashboard — it does not
    run on sight; the operator's accept is what starts it."""
    w = _worker()
    w._handle_message(json.dumps({"type": "pr-review-request", "requestId": "r1",
                                  "pullRequest": {"repositoryFullName": "acme/app"}}).encode())
    snap = w.queue_snapshot()
    assert len(snap) == 1
    assert snap[0]["kind"] == "review"
    assert snap[0]["request_id"] == "r1"
    assert snap[0]["slug"] == "acme/app"
    assert snap[0]["key"] == "review:r1"


def test_accept_pops_pending_and_runs(monkeypatch):
    """accept() removes the request from the queue and dispatches it once; a
    second accept of the same key is a no-op (already gone)."""
    w = _worker()
    w._enqueue("review", "r1", "acme/app")
    seen, ev = [], threading.Event()
    monkeypatch.setattr(w, "_run_accepted", lambda item: (seen.append(item), ev.set()))
    assert w.accept("review:r1") is True
    assert ev.wait(2), "accept must dispatch the run"
    assert seen[0]["request_id"] == "r1"
    assert w.queue_snapshot() == []
    assert w.accept("review:r1") is False


def test_run_accepted_dispatches_by_kind(monkeypatch):
    """_run_accepted routes each kind to its runner with (request_id, slug)."""
    w = _worker()
    calls = []
    monkeypatch.setattr(w, "_run_review", lambda rid, slug: calls.append(("review", rid, slug)))
    monkeypatch.setattr(w, "_run_implementation", lambda rid, slug: calls.append(("impl", rid, slug)))
    monkeypatch.setattr(w, "_run_todolist", lambda rid, slug, step=None: calls.append(("todolist", rid, slug)))
    monkeypatch.setattr(w, "_run_taskdesc", lambda rid, slug: calls.append(("taskdesc", rid, slug)))
    monkeypatch.setattr(w, "_run_changelog", lambda rid, slug: calls.append(("changelog", rid, slug)))
    monkeypatch.setattr(w, "_run_news", lambda rid, slug: calls.append(("news", rid, slug)))
    w._run_accepted({"kind": "impl", "request_id": "i1", "slug": "acme/app"})
    w._run_accepted({"kind": "todolist", "request_id": "t1", "slug": "Proj"})
    w._run_accepted({"kind": "changelog", "request_id": "c1", "slug": "Proj"})
    w._run_accepted({"kind": "news", "request_id": "n1", "slug": "Mahdi"})
    w._run_accepted({"kind": "review", "request_id": "r1", "slug": None})
    assert calls == [("impl", "i1", "acme/app"), ("todolist", "t1", "Proj"),
                     ("changelog", "c1", "Proj"), ("news", "n1", "Mahdi"), ("review", "r1", None)]


def test_reject_refuses_as_dismissed_without_claiming(monkeypatch):
    """reject() refuses the request ("dismissed") so Rivendell asks its requester
    what to do; it neither claims nor FAILs it, and forgets the key so the
    re-send after "keep waiting" is queued afresh. A second reject is a no-op."""
    w = _worker()
    w._enqueue("impl", "i1", "acme/app")
    calls = []
    monkeypatch.setattr(w, "_api",
                        lambda path, payload=None: calls.append((path, payload)))
    monkeypatch.setattr(w, "_fetch_prompt",
                        lambda kp, rid: (_ for _ in ()).throw(AssertionError("must not claim")))
    monkeypatch.setattr(w, "_post_result",
                        lambda *a: (_ for _ in ()).throw(AssertionError("must not FAIL")))
    assert w.reject("impl:i1") is True
    _wait_until(lambda: "impl:i1" not in w._seen)       # reject is off-thread
    assert calls == [("/plugin/implementation-requests/i1/refuse",
                      {"reason": "dismissed"})]
    assert w.queue_snapshot() == []
    assert w.reject("impl:i1") is False
    assert w._enqueue("impl", "i1", "acme/app") == "impl:i1"   # the re-send


def test_reject_falls_back_to_claim_and_fail_on_older_api(monkeypatch):
    """An older rivendell-api 404s refuse: reject() then claims the request (so
    the result POST is accepted) and posts FAILED "declined by operator". The
    key stays in _seen — a FAILED job is not re-offered."""
    w = _worker()
    w._enqueue("impl", "i1", "acme/app")
    claimed, posted, ev = [], [], threading.Event()
    monkeypatch.setattr(w, "_api", _raise_http(404))
    monkeypatch.setattr(w, "_fetch_prompt",
                        lambda kp, rid: claimed.append((kp, rid)) or {"prompt": "x"})
    monkeypatch.setattr(w, "_post_result",
                        lambda kp, rid, ok, text: posted.append((kp, rid, ok, text)) or ev.set())
    assert w.reject("impl:i1") is True
    assert ev.wait(2), "reject must post a result"
    assert claimed == [("implementation-requests", "i1")]
    assert posted == [("implementation-requests", "i1", False, "declined by operator")]
    assert "impl:i1" in w._seen


def test_reject_refuse_409_posts_nothing(monkeypatch):
    """A 409 on refuse is a job not ours (or finished): no fallback claim/FAIL."""
    w = _worker()
    monkeypatch.setattr(w, "_api", _raise_http(409))
    monkeypatch.setattr(w, "_fetch_prompt",
                        lambda kp, rid: (_ for _ in ()).throw(AssertionError("must not claim")))
    monkeypatch.setattr(w, "_post_result",
                        lambda *a: (_ for _ in ()).throw(AssertionError("must not FAIL")))
    w._do_reject({"kind": "review", "request_id": "r1", "slug": None})


def test_accepted_request_is_not_re_added_by_catch_up():
    """A key that left the queue for a run stays in _seen, so a catch-up that
    still lists it (IN_PROGRESS) does not put it back in the queue."""
    w = _worker()
    w._enqueue("review", "r1", "acme/app")
    with w._q_lock:
        w._pending.pop("review:r1")            # accept() removed it; _seen kept
    w._enqueue("review", "r1", "acme/app")      # a catch-up re-offer
    assert w.queue_snapshot() == []


# --- auto-accept policy: first into an idle queue runs, the rest ping ---------

def test_lone_request_auto_accepts_and_next_pings(monkeypatch):
    """The first request into an idle queue is auto-accepted with no Telegram ping;
    a second, arriving while the first is still pending, is held and pinged."""
    w = _worker()
    accepted, pinged = [], []
    monkeypatch.setattr(w, "accept", lambda key: accepted.append(key) or True)
    monkeypatch.setattr(w, "_notify_queued", lambda key: pinged.append(key))
    w._apply_policy(w._enqueue("review", "r1", "acme/app"))
    assert accepted == ["review:r1"] and pinged == []
    # accept() was stubbed (r1 stays pending), so the queue is no longer idle.
    w._apply_policy(w._enqueue("review", "r2", "acme/app"))
    assert accepted == ["review:r1"] and pinged == ["review:r2"]


def test_apply_policy_ignores_duplicate_enqueue(monkeypatch):
    """A duplicate _enqueue returns None; _apply_policy must neither accept nor
    ping on it."""
    w = _worker()
    hits = []
    monkeypatch.setattr(w, "accept", lambda key: hits.append(("a", key)) or True)
    monkeypatch.setattr(w, "_notify_queued", lambda key: hits.append(("n", key)))
    w._apply_policy(w._enqueue("review", "r1"))    # first: auto-accepted
    w._apply_policy(w._enqueue("review", "r1"))    # duplicate: None -> no-op
    assert hits == [("a", "review:r1")]


def test_active_run_keeps_queue_busy_so_next_pings(monkeypatch):
    """A request that arrives while an accepted run is still in flight is held and
    pinged — not auto-accepted a second time — even though the queue is empty."""
    w = _worker()
    pinged = []
    monkeypatch.setattr(w, "_notify_queued", lambda key: pinged.append(key))
    monkeypatch.setattr(w, "_run_accepted", lambda item: None)   # don't really run
    w._apply_policy(w._enqueue("review", "r1"))     # real accept: pops, marks busy
    assert w.queue_snapshot() == [] and w._active_runs == 1 and pinged == []
    w._apply_policy(w._enqueue("review", "r2"))     # queue empty but a run is live
    assert [r["key"] for r in w.queue_snapshot()] == ["review:r2"]
    assert pinged == ["review:r2"]


def test_held_request_starts_once_the_bridge_is_free(monkeypatch):
    """A request held because a run was in flight starts on its own when that
    run finishes and nothing else runs — it does not wait on an Approve forever.
    (The ping still lets the operator start it early, or dismiss it.)"""
    w = _worker()
    ran, release, second_done = [], threading.Event(), threading.Event()
    monkeypatch.setattr(w, "_notify_queued", lambda key: None)

    def run_review(rid, slug):
        ran.append(rid)
        if rid == "r1":
            release.wait(2)                          # busy until released
        else:
            second_done.set()
    monkeypatch.setattr(w, "_run_review", run_review)
    w._apply_policy(w._enqueue("review", "r1"))     # idle: auto-accepted, running
    w._apply_policy(w._enqueue("review", "r2"))     # busy: held
    assert [r["key"] for r in w.queue_snapshot()] == ["review:r2"]
    release.set()                                    # r1 finishes
    assert second_done.wait(2), "the held request must start once the bridge is free"
    assert ran == ["r1", "r2"] and w.queue_snapshot() == []


def test_implementation_without_checkout_is_refused(monkeypatch, acks):
    """An implementation for a repo with no local checkout is dropped here —
    never accepted (that claims it, only to FAIL it), pinged or acked — and
    refused ("no-checkout"), so rivendell-api asks its requester whether another
    bridge may run it. The key is forgotten, so the re-send after "keep
    waiting" goes through the policy again. One whose repo is checked out
    still auto-accepts as usual."""
    w = _worker()
    hits, calls = [], []
    monkeypatch.setattr(w, "_find_checkout",
                        lambda slug: "/co/app" if slug == "acme/app" else None)
    monkeypatch.setattr(w, "accept", lambda key: hits.append(("a", key)) or True)
    monkeypatch.setattr(w, "_notify_queued", lambda key: hits.append(("n", key)))
    monkeypatch.setattr(w, "_api", lambda path, payload=None: calls.append((path, payload)))
    w._apply_policy(w._enqueue("impl", "i1", "acme/elsewhere"))
    assert hits == [] and acks == [] and w.queue_snapshot() == []
    assert calls == [("/plugin/implementation-requests/i1/refuse",
                      {"reason": "no-checkout"})]
    assert "impl:i1" not in w._seen
    # "keep waiting": the re-sent event is a new job, and is refused again.
    w._apply_policy(w._enqueue("impl", "i1", "acme/elsewhere"))
    assert len(calls) == 2 and hits == []
    w._apply_policy(w._enqueue("impl", "i2", "acme/app"))   # queue idle again
    assert hits == [("a", "impl:i2")] and len(calls) == 2


def test_implementation_without_checkout_falls_back_to_pass(monkeypatch):
    """An older rivendell-api 404s refuse: the implementation is passed on the
    old way instead, and stays in _seen (that API's catch-up keeps listing it)."""
    w = _worker()
    calls = []
    monkeypatch.setattr(w, "_find_checkout", lambda slug: None)

    def api(path, payload=None):
        calls.append((path, payload))
        if path.endswith("/refuse"):
            raise _http_error(404, path)
    monkeypatch.setattr(w, "_api", api)
    w._apply_policy(w._enqueue("impl", "i1", "acme/elsewhere"))
    assert calls == [
        ("/plugin/implementation-requests/i1/refuse", {"reason": "no-checkout"}),
        ("/plugin/implementation-requests/i1/pass", {})]
    assert "impl:i1" in w._seen and w.queue_snapshot() == []


# --- acks: tell Rivendell the job arrived, so it stops re-sending -------------

def test_auto_accept_acks_received(monkeypatch, acks):
    w = _worker()
    monkeypatch.setattr(w, "accept", lambda key: True)
    monkeypatch.setattr(w, "_notify_queued", lambda key: None)
    w._apply_policy(w._enqueue("review", "r1", "acme/app"))
    assert acks == [("review:r1", "received")]


def test_left_for_operator_acks_queued(monkeypatch, acks):
    w = _worker()
    monkeypatch.setattr(w, "accept", lambda key: True)       # r1 stays pending
    monkeypatch.setattr(w, "_notify_queued", lambda key: None)
    w._apply_policy(w._enqueue("review", "r1"))
    w._apply_policy(w._enqueue("changelog", "c1", "Proj"))
    assert acks == [("review:r1", "received"), ("changelog:c1", "queued")]


def test_duplicate_while_pending_re_acks_queued(monkeypatch, acks):
    """Rivendell re-sends until it hears an ack: a duplicate of a job still held
    here re-acks "queued"; one for a job that already left the queue (running
    or finished) is ignored, and neither re-runs the policy."""
    w = _worker()
    hits = []
    monkeypatch.setattr(w, "accept", lambda key: hits.append(key) or True)
    monkeypatch.setattr(w, "_notify_queued", lambda key: hits.append(key))
    event = json.dumps({"type": "task-description-request", "requestId": "d1",
                        "task": {"name": "Add login"}}).encode()
    assert w._handle_message(event) == "taskdesc:d1"
    w._apply_policy(w._handle_message(event))                # re-send
    assert acks == [("taskdesc:d1", "queued")] and hits == []
    with w._q_lock:
        w._pending.clear()                                   # now running
    w._apply_policy(w._handle_message(event))
    assert acks == [("taskdesc:d1", "queued")] and hits == []


def test_ack_posts_state_and_swallows_errors(monkeypatch):
    """_ack POSTs {"state": ...} to the kind's ack endpoint off-thread; an older
    API's 404 is only logged."""
    w = _worker()
    calls, ev = [], threading.Event()

    def api(path, payload=None):
        calls.append((path, payload))
        ev.set()
        raise _http_error(404, path)
    monkeypatch.setattr(w, "_api", api)
    _real_ack(w, "impl:i1", "queued")
    assert ev.wait(2), "ack must be posted"
    assert calls == [("/plugin/implementation-requests/i1/ack", {"state": "queued"})]


def _conflict(kind_path, rid):
    raise urllib.error.HTTPError(f"http://api/{kind_path}/{rid}/prompt", 409,
                                 "Conflict", None, None)


def test_claim_refused_with_409_posts_nothing(monkeypatch):
    """A 409 on claim means the request is another bridge's (claimed, or waiting
    for its requester's own bridge) or already finished: not ours to fail, so
    nothing runs and nothing is posted. Any other claim error still lands FAILED."""
    w = _worker()
    posted = []
    monkeypatch.setattr(w, "_fetch_prompt", _conflict)
    monkeypatch.setattr(w, "_post_result",
                        lambda kp, rid, ok, text: posted.append((kp, rid, ok, text)))
    monkeypatch.setattr(
        w, "_start_run",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not run")))
    w._run_implementation("i1", "acme/app")
    w._run_review("r1", "acme/app")
    w._run_todolist("t1", "Proj")
    # An older API (refuse 404s) falls back to claim+FAIL: a 409 claim stops it.
    monkeypatch.setattr(w, "_api", _raise_http(404))
    w._do_reject({"kind": "impl", "request_id": "i2", "slug": "acme/app"})
    assert posted == []

    def down(kind_path, rid):
        raise urllib.error.URLError("down")
    monkeypatch.setattr(w, "_fetch_prompt", down)
    w._run_review("r2", "acme/app")
    assert posted == [("review-requests", "r2", False,
                       "prompt fetch failed: <urlopen error down>")]


def test_run_accepted_releases_active_run(monkeypatch):
    """_run_accepted always drops the active-run count in its finally, and clamps
    so a stray call never drives it negative."""
    w = _worker()
    monkeypatch.setattr(w, "_run_review", lambda rid, slug: None)
    with w._q_lock:
        w._active_runs = 1
    w._run_accepted({"kind": "review", "request_id": "r1", "slug": None})
    assert w._active_runs == 0
    w._run_accepted({"kind": "review", "request_id": "r2", "slug": None})
    assert w._active_runs == 0                       # clamped, not -1


# --- Telegram ping for queued requests ---------------------------------------

def test_queued_message_has_approve_dismiss_buttons():
    w = _worker(name="prod")
    item = {"key": "review:r1", "kind": "review", "request_id": "r1",
            "slug": "acme/app", "created_at": 0.0}
    text, kb = w._queued_message(item, "tok123")
    assert "PR review" in text and "acme/app" in text and "prod" in text
    buttons = kb["inline_keyboard"][0]
    assert [b["callback_data"] for b in buttons] == ["rv:a:tok123", "rv:d:tok123"]


def test_notify_queued_pings_when_pending(monkeypatch):
    w = _worker()
    w._enqueue("impl", "i1", "acme/app")
    sent = []
    monkeypatch.setattr(w, "_deliver_telegram",
                        lambda text, kb: sent.append((text, kb)))
    w._notify_queued("impl:i1")
    _wait_until(lambda: len(sent) == 1)             # delivery is off-thread
    text, kb = sent[0]
    assert "implementation" in text
    assert kb["inline_keyboard"][0][0]["callback_data"].startswith("rv:a:")


def test_notify_queued_noop_when_already_decided(monkeypatch):
    """A ping fired for a request that was decided in the meantime sends nothing."""
    w = _worker()
    calls = []
    monkeypatch.setattr(w, "_deliver_telegram", lambda text, kb: calls.append(1))
    w._notify_queued("review:gone")                 # never queued
    time.sleep(0.05)
    assert calls == []


def test_deliver_telegram_sends_to_dash_chat(monkeypatch):
    import bridge.telegram as tg_mod
    sent = []
    monkeypatch.setattr(tg_mod, "send", lambda chat, text, kb: sent.append((chat, text, kb)))
    monkeypatch.setattr(rivendell.config, "NOTIFY_ENABLE", True)
    monkeypatch.setattr(rivendell.config, "TOKEN", "x")
    monkeypatch.setattr(rivendell.config, "DASH_CHAT_ID", 555)
    _worker()._deliver_telegram("hi", {"inline_keyboard": []})
    assert sent == [(555, "hi", {"inline_keyboard": []})]


def test_deliver_telegram_silent_without_telegram(monkeypatch):
    import bridge.telegram as tg_mod
    monkeypatch.setattr(tg_mod, "send",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not send")))
    monkeypatch.setattr(rivendell.config, "TOKEN", "")
    _worker()._deliver_telegram("hi", {})           # no TOKEN -> silent


def test_token_registry_resolves_once():
    tok = rivendell._register_token("inst", "review:r1")
    assert rivendell.resolve_token(tok) == ("inst", "review:r1")
    assert rivendell.resolve_token(tok) is None      # one-shot: consumed
    assert rivendell.resolve_token("nope") is None


# --- job waiting -------------------------------------------------------------

class _StubJob:
    def __init__(self, status, result=None, error_msg=None, texts=(), exited=None):
        self.status, self.result = status, result
        self.error_msg, self.texts = error_msg, list(texts)
        self.interrupted = False
        self.store_session_id = None  # a real Job always has one; stubs are session-less
        if exited is not None:      # a real Job always has one; stubs opt in
            self.exited = exited

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


def test_wait_job_waits_for_the_process_to_exit_not_the_first_result(monkeypatch):
    """claude -p emits `result` when the model ends its turn with a background
    subagent pending, then keeps the process alive and wakes the model again:
    the wait must hold until the runner's finally sets `exited`."""
    monkeypatch.setattr(rivendell, "_POLL_INTERVAL", 0.01)
    gone = threading.Event()
    job = _StubJob("done", result="interim", exited=gone)
    out = []
    t = threading.Thread(target=lambda: out.append(_worker()._wait_job(job, 5)), daemon=True)
    t.start()
    time.sleep(0.2)
    assert out == [], "must not return on status alone"
    job.result = "final"
    gone.set()
    t.join(5)
    assert out == [(True, "final")]


def test_wait_job_times_out_when_the_process_never_exits():
    job = _StubJob("done", result="interim", exited=threading.Event())
    ok, text = _worker()._wait_job(job, 0)
    assert not ok and job.interrupted and "timed out" in text


def test_wait_job_reads_an_exited_job_by_its_status():
    gone = threading.Event()
    gone.set()
    ok, text = _worker()._wait_job(_StubJob("error", error_msg="boom", exited=gone), 60)
    assert not ok and text == "boom"


def test_wait_job_reports_a_watchdog_kill_as_failure():
    """A hung run the watchdog killed may still read "done" (an interim result
    landed before the silence): never post that text as the batch's result."""
    gone = threading.Event()
    gone.set()
    job = _StubJob("done", result="interim", exited=gone)
    job.timed_out = True
    ok, text = _worker()._wait_job(job, 60)
    assert not ok and "silence" in text


def test_runs_carry_their_kinds_timeout_as_the_hang_timeout(monkeypatch):
    """A Rivendell run is silent for as long as its work takes (a subagents
    batch's parent waits on its agents), so the watchdog's ceiling is the
    kind's own timeout, not the 30-minute default."""
    w = _worker(impl_timeout=7200, review_timeout=900)
    started = []
    monkeypatch.setattr(w, "_find_checkout", lambda slug: "/repo")
    monkeypatch.setattr(w, "_fetch_prompt",
                        lambda kind_path, rid: {"prompt": "p", "repositoryFullName": "acme/app"})
    monkeypatch.setattr(w, "_start_run",
                        lambda prompt, workdir, hang_timeout=None:
                        started.append(hang_timeout) or _StubJob("done", result="ok"))
    monkeypatch.setattr(w, "_post_result", lambda *a: None)
    w._run_implementation("r1", "acme/app")
    w._run_review("r2", "acme/app")
    assert started == [7200, 900]


def test_watchdog_honours_the_jobs_own_hang_timeout():
    from bridge import runner

    class Proc:
        def __init__(self):
            self.killed = False

        def poll(self):
            return 0 if self.killed else None

        def kill(self):
            self.killed = True

    job = runner.Job("j", 555)
    job.hang_timeout = 1.5                 # this run's own ceiling, well under RUN_TIMEOUT
    proc = Proc()
    runner._watchdog(job, proc)            # returns once it has killed (about 2 s)
    assert proc.killed and job.timed_out


def test_interrupt_acts_while_the_child_is_alive_even_after_an_interim_result():
    """A turn that reported `result` with a background agent pending reads "done"
    while its process lives on; a timeout (or a dashboard Stop) must still stop it."""
    from bridge import runner

    class Proc:
        stdin = None
        def poll(self):
            return None            # alive
        def terminate(self):
            pass
    job = runner.Job("j1", 555)
    job.proc = Proc()
    job.status = "done"
    try:
        assert job.interrupt() is True
        assert job.interrupted is True
    finally:
        job._interrupt_timer.cancel()

    class Gone(Proc):
        def poll(self):
            return 0               # exited
    done = runner.Job("j2", 555)
    done.proc = Gone()
    assert done.interrupt() is False


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


def test_project_dir_is_the_folder_holding_the_projects_checkouts(monkeypatch):
    """A project-level job runs beside this machine's checkouts of the
    project's repos: a checkout matches on ANY remote (a fork's origin and its
    upstream alike), several matches give the folder holding them, one gives
    the repo itself — and nothing here, or only BASE_PATH in common, is None."""
    monkeypatch.setattr("bridge.browser.list_projects",
                        lambda: ["/org/nr/apex", "/org/nr/apex-app",
                                 "/org/nr/portal", "/solo"])
    remotes = {"apex": {"ainurdev/apex", "nationalerijschool/apex"},
               "apex-app": {"ainurdev/apex-app"},
               "portal": {"nationalerijschool/portal"},
               "solo": {"me/solo"}}
    monkeypatch.setattr("bridge.github.remote_slugs",
                        lambda path: remotes[os.path.basename(path)])
    base = rivendell.config.BASE_PATH
    nr = os.path.join(base, "org/nr")

    assert rivendell._project_dir(["NationaleRijschool/Apex",
                                   "nationalerijschool/portal",
                                   "nationalerijschool/not-cloned"]) == nr
    # Path components, not characters: apex + apex-app is org/nr, not ".../apex".
    assert rivendell._project_dir(["ainurdev/apex", "ainurdev/apex-app"]) == nr
    assert rivendell._project_dir(["me/solo"]) == os.path.join(base, "solo")
    assert rivendell._project_dir(["ainurdev/apex", "me/solo"]) is None
    assert rivendell._project_dir(["x/unknown"]) is None
    assert rivendell._project_dir([]) is None
    assert rivendell._project_dir(None) is None


def test_run_todolist_files_under_the_projects_checkouts(monkeypatch):
    """A claim that names the project's repositories runs beside this machine's
    checkouts of them, not in the generic workdir — so its session lands under
    that project instead of BASE_PATH's root."""
    w = _worker(workdir="")
    ran = []
    monkeypatch.setattr(w, "_fetch_prompt", lambda kind_path, rid: {
        "prompt": "make a checklist", "repositories": ["acme/app"]})
    monkeypatch.setattr(rivendell, "_project_dir",
                        lambda repos: "/projects/acme/app" if repos == ["acme/app"] else None)
    monkeypatch.setattr(w, "_start_run",
                        lambda prompt, workdir: ran.append(workdir) or _StubJob("done", result="- [ ] do it"))
    monkeypatch.setattr(w, "_post_result", lambda *a: None)
    w._run_todolist("t1", "Acme")
    assert ran == ["/projects/acme/app"]


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


# --- quiet intervals keep the connection -------------------------------------

def test_quiet_interval_pings_and_keeps_the_connection(monkeypatch):
    """A read timeout (quiet interval) poisons the socket file; the listener
    must ping and read on over the SAME connection — not redial every interval
    ("cannot read from timed out object") — and deliver the next frame."""
    server, client = socket.socketpair()
    monkeypatch.setattr(rivendell, "_PING_INTERVAL", 0.2)
    w = _worker()
    connects, queued = [], []

    def fake_connect():
        connects.append(1)
        if len(connects) > 1:
            raise ConnectionError("redialed")
        return client, client.makefile("rb")
    monkeypatch.setattr(w, "_connect", fake_connect)
    monkeypatch.setattr(w, "_catch_up", lambda: 0)
    monkeypatch.setattr(w, "_apply_policy", lambda key: queued.append(key))

    def fake_server():
        srv = server.makefile("rb")
        # Stay silent until the client times out and pings, then send an event.
        while wsutil.decode_frame(srv)[0] != wsutil.OP_PING:
            pass
        event = json.dumps({"type": "pr-review-request", "requestId": "r1",
                            "pullRequest": {"repositoryFullName": "acme/app"}})
        server.sendall(wsutil.encode_frame(event.encode(), wsutil.OP_TEXT))

    threading.Thread(target=fake_server, daemon=True).start()
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    try:
        _wait_until(lambda: queued == ["review:r1"])
        assert connects == [1], "a quiet interval must not drop the connection"
        assert w.status == "connected"
    finally:
        w.stop()
        t.join(timeout=2)
        server.close()


# --- the RIVENDELL tab: a repo's open tasks, and IMPLEMENT --------------------

@pytest.fixture
def workers():
    """The running-worker registry, emptied around the test."""
    rivendell._workers.clear()
    yield rivendell._workers
    rivendell._workers.clear()


def _answering(answer, calls=None):
    """An _api stand-in that records each call and returns `answer`."""
    def api(path, payload=None):
        if calls is not None:
            calls.append((path, payload))
        return json.loads(json.dumps(answer))
    return api


_TASKS = {
    "projects": [{"id": "p1", "name": "Rivendell", "url": "https://rv/projects/p1"}],
    "tasks": [
        {"id": "t1", "name": "Inbox", "implementation":
            {"id": "r1", "status": "IN_PROGRESS", "createdAt": "x", "completedAt": None}},
        {"id": "t2", "name": "Docs", "implementation": None},
    ],
}


def test_tasks_asks_every_running_instance_and_tags_its_rows(workers):
    calls = []
    a, b = _worker(id="a", name="prod"), _worker(id="b", name="local")
    a._api = _answering(_TASKS, calls)
    b._api = _answering({"projects": [], "tasks": [{"id": "t9", "name": "Other",
                                                    "implementation": None}]})
    workers.update(a=a, b=b)

    out = rivendell.tasks("acme/app")

    assert calls == [("/plugin/tasks?repository=acme/app", None)]
    assert [(t["id"], t["instance_id"]) for t in out["tasks"]] == \
        [("t1", "a"), ("t2", "a"), ("t9", "b")]
    assert out["projects"] == [{**_TASKS["projects"][0], "instance_id": "a"}]
    assert out["errors"] == [] and out["instances"] == 2


def test_tasks_quotes_the_repository(workers):
    calls = []
    w = _worker(id="a")
    w._api = _answering({"projects": [], "tasks": []}, calls)
    workers["a"] = w
    rivendell.tasks("acme/app&x=1")
    assert calls[0][0] == "/plugin/tasks?repository=acme/app%26x%3D1"


def test_tasks_reports_each_failing_instance_and_keeps_the_rest(workers):
    ok, bad_token, old, down = (_worker(id=i, name=i) for i in ("ok", "tok", "old", "down"))
    ok._api = _answering(_TASKS)
    bad_token._api = _raise_http(401)
    old._api = _raise_http(404)

    def unreachable(path, payload=None):
        raise urllib.error.URLError("connection refused")
    down._api = unreachable
    workers.update(ok=ok, tok=bad_token, old=old, down=down)

    out = rivendell.tasks("acme/app")

    assert [t["id"] for t in out["tasks"]] == ["t1", "t2"]
    assert {e["instance_id"]: e["error"] for e in out["errors"]} == {
        "tok": "token_rejected", "old": "not_deployed", "down": "unreachable"}
    assert all(e["instance"] == e["instance_id"] and e["detail"] for e in out["errors"])


def test_tasks_does_not_call_an_instance_parked_on_a_rejected_token(workers):
    """The listener already knows the token is dead; a poll every few seconds
    must not hammer the API with it (the same reason the socket stops dialing)."""
    w = _worker(id="a")
    w._set_status("auth_error", "token rejected by gateway (4401)")
    w._api = lambda path, payload=None: (_ for _ in ()).throw(AssertionError("called"))
    workers["a"] = w
    out = rivendell.tasks("acme/app")
    assert out["tasks"] == [] and [e["error"] for e in out["errors"]] == ["token_rejected"]


def test_tasks_names_the_session_running_a_request_here(workers):
    w = _worker(id="a")
    w._api = _answering(_TASKS)
    w._track("r1", "impl", None, "sess-1", label=None, link=None)
    workers["a"] = w
    by_id = {t["id"]: t for t in rivendell.tasks("acme/app")["tasks"]}
    assert by_id["t1"]["session_id"] == "sess-1"
    assert by_id["t2"]["session_id"] is None


def test_tasks_with_no_running_instance_says_so(workers):
    assert rivendell.tasks("acme/app") == {
        "instances": 0, "projects": [], "tasks": [], "errors": [], "links": []}


def test_implement_asks_the_instance_to_create_the_request(workers):
    calls = []
    w = _worker(id="a")
    w._api = _answering({"id": "r7", "status": "PENDING"}, calls)
    workers["a"] = w
    assert rivendell.implement("a", "t1") == {"id": "r7", "status": "PENDING"}
    assert calls == [("/plugin/implementation-requests", {"taskId": "t1"})]


def test_implement_on_an_unknown_instance_is_an_error(workers):
    with pytest.raises(rivendell.TasksError) as e:
        rivendell.implement("nope", "t1")
    assert e.value.code == "no_instance"


def test_implement_explains_a_refusal_in_rivendells_words(workers):
    """A 400 from create() carries an actionable line (e.g. no repo linked to
    the task's project); that line is what the operator needs to see."""
    body = io.BytesIO(json.dumps({"message": "No repository is linked to this "
                                  "task's project.", "statusCode": 400}).encode())

    def refuse(path, payload=None):
        raise urllib.error.HTTPError("http://api/x", 400, "Bad Request", None, body)
    w = _worker(id="a")
    w._api = refuse
    workers["a"] = w
    with pytest.raises(rivendell.TasksError) as e:
        rivendell.implement("a", "t1")
    assert e.value.code == "refused"
    assert str(e.value) == "No repository is linked to this task's project."


def test_run_implementation_names_its_session_only_while_it_runs(monkeypatch):
    """OPEN SESSION needs request -> session while the run is live; once the
    result is posted the card shows DONE/FAILED and the entry is gone."""
    w = _worker()
    seen = []

    class _Job:
        store_session_id = "sess-9"

    monkeypatch.setattr(w, "_fetch_prompt", lambda kp, rid: {"prompt": "do it"})
    monkeypatch.setattr(w, "_find_checkout", lambda slug: "/tmp")
    monkeypatch.setattr(w, "_start_run", lambda prompt, workdir, hang_timeout=None: _Job())
    monkeypatch.setattr(w, "_wait_job",
                        lambda job, timeout: (seen.append(w.running_snapshot()), (True, "ok"))[1])
    monkeypatch.setattr(w, "_post_result", lambda *a: None)
    w._run_implementation("r1", "acme/app")
    assert [(r["request_id"], r["session_id"]) for r in seen[0]] == [("r1", "sess-9")]
    assert w.running_snapshot() == []


@pytest.mark.parametrize("run, kind", [("_run_review", "review"), ("_run_todolist", "todolist"),
                                       ("_run_taskdesc", "taskdesc"), ("_run_changelog", "changelog")])
def test_every_kind_is_listed_in_flight_only_while_it_runs(monkeypatch, run, kind):
    """The QUEUE tab lists every accepted run, not only implementations."""
    w = _worker()
    seen = []

    class _Job:
        store_session_id = "sess-9"

    monkeypatch.setattr(w, "_fetch_prompt", lambda kp, rid: {"prompt": "do it"})
    monkeypatch.setattr(w, "_find_checkout", lambda slug: "/tmp")
    monkeypatch.setattr(w, "_start_run", lambda prompt, workdir, hang_timeout=None: _Job())
    monkeypatch.setattr(w, "_wait_job",
                        lambda job, timeout: (seen.append(w.running_snapshot()), (True, "ok"))[1])
    monkeypatch.setattr(w, "_post_result", lambda *a: None)
    getattr(w, run)("r1", "Proj")
    assert [(r["kind"], r["request_id"], r["session_id"], r["label"]) for r in seen[0]] == [
        (kind, "r1", "sess-9", "Proj")]
    assert w.running_snapshot() == []


# --- queue mode -------------------------------------------------------------

def _fake_queue(monkeypatch):
    """queue_manager.get() -> an in-memory PreviewQueue whose runner never runs
    Claude: an item starts "running" at once and a test ends it with _drive."""
    from bridge import queue_manager
    from bridge.queue_manager import PreviewQueue
    counter = {"n": 0}

    def run_fn(item):
        counter["n"] += 1
        return f"job{counter['n']}"
    q = PreviewQueue(run_fn=run_fn, persist_path=None)
    monkeypatch.setattr(queue_manager, "_instance", q)
    return q


def _drive(q, sid, outcomes):
    """End the running item once per outcome, in order: (status, result, error)."""
    for status, result, error in outcomes:
        for _ in range(500):
            run = next((it for it in q.snapshot(sid)["items"] if it["status"] == "running"), None)
            if run is not None:
                q.notify_job_done(sid, run["job_id"], status, result, None, 1, error=error)
                break
            time.sleep(0.01)
        else:
            raise AssertionError("no running item to finish")


def _wait_items(q, sid, n):
    for _ in range(500):
        if len(q.snapshot(sid)["items"]) == n:
            return
        time.sleep(0.01)
    raise AssertionError(f"expected {n} items in {sid}")


def _queue_claim(n=2):
    steps = [{"taskId": f"t{i}", "externalId": str(i), "name": f"Task {i}",
              "url": f"https://rv/t/{i}", "prompt": f"do task {i}"} for i in range(1, n + 1)]
    steps.append({"taskId": None, "externalId": None, "name": "Push and open the pull request",
                  "url": "https://rv/s/1", "prompt": "open the PR"})
    return {"requestId": "b1", "status": "IN_PROGRESS", "prompt": "whole batch",
            "repositoryFullName": "acme/app",
            "batch": {"id": "bb", "name": "Login fixes", "mode": "queue",
                      "branch": "batch/login-fixes", "url": "https://rv/s/1"},
            "steps": steps}


def _queue_worker(monkeypatch, claim, **inst):
    w = _worker(**inst)
    posted = []
    monkeypatch.setattr(rivendell, "_POLL_INTERVAL", 0.01)
    monkeypatch.setattr(w, "_claim", lambda kind_path, rid: claim)
    monkeypatch.setattr(w, "_find_checkout", lambda slug: "/repo")
    monkeypatch.setattr(w, "_new_session", lambda workdir: "sess-1")
    monkeypatch.setattr(w, "_start_run",
                        lambda prompt, workdir, hang_timeout=None: (_ for _ in ()).throw(AssertionError("queue mode starts no single turn")))
    monkeypatch.setattr(w, "_post_result",
                        lambda kind_path, rid, ok, text: posted.append((kind_path, rid, ok, text)))
    return w, posted


def _run_in_thread(w):
    t = threading.Thread(target=w._run_implementation, args=("b1", "acme/app"), daemon=True)
    t.start()
    return t


def test_queue_mode_enqueues_one_turn_per_step_and_posts_the_last_answer(monkeypatch):
    q = _fake_queue(monkeypatch)
    w, posted = _queue_worker(monkeypatch, _queue_claim(2))
    t = _run_in_thread(w)
    _wait_items(q, "sess-1", 3)
    items = q.snapshot("sess-1")["items"]
    assert [it["label"] for it in items] == ["Task 1 · 1/3", "Task 2 · 2/3", "Push and open the pull request · 3/3"]
    assert [it["link"] for it in items] == ["https://rv/t/1", "https://rv/t/2", "https://rv/s/1"]
    assert {it["ref"] for it in items} == {"t1:b1"}
    assert {it["surface"] for it in items} == {"rivendell"}
    assert [it["status"] for it in items] == ["running", "queued", "queued"]
    assert w.running_snapshot()[0]["session_id"] == "sess-1"
    assert w.running_snapshot()[0]["label"] == "Login fixes"
    _drive(q, "sess-1", [("done", "did 1", None), ("done", "did 2", None), ("done", "PR #7 opened", None)])
    t.join(5)
    assert posted == [("implementation-requests", "b1", True, "PR #7 opened")]
    assert w.running_snapshot() == []


def test_queue_mode_runs_the_turns_with_the_instance_model_and_no_permission_prompts(monkeypatch):
    q = _fake_queue(monkeypatch)
    w, _ = _queue_worker(monkeypatch, _queue_claim(1), model="sonnet")
    t = _run_in_thread(w)
    _wait_items(q, "sess-1", 2)
    it = q.snapshot("sess-1")["items"][0]
    assert it["model"] == "sonnet" and it["permission_mode"] == "bypassPermissions"
    w.stop()                               # end the waiter: nothing drives this batch
    t.join(5)


def test_queue_mode_failed_step_drops_the_rest_and_lands_failed(monkeypatch):
    q = _fake_queue(monkeypatch)
    w, posted = _queue_worker(monkeypatch, _queue_claim(2))
    t = _run_in_thread(w)
    _wait_items(q, "sess-1", 3)
    _drive(q, "sess-1", [("done", "did 1", None), ("error", None, "tests red")])
    t.join(5)
    assert posted == [("implementation-requests", "b1", False, "tests red")]
    # The closing step was removed before it could run.
    assert [it["status"] for it in q.snapshot("sess-1")["items"]] == ["done", "failed"]


def test_queue_mode_every_turn_removed_lands_failed(monkeypatch):
    q = _fake_queue(monkeypatch)
    q.pause("sess-1")                      # nothing starts, so everything can be removed
    w, posted = _queue_worker(monkeypatch, _queue_claim(1))
    t = _run_in_thread(w)
    _wait_items(q, "sess-1", 2)
    for it in q.snapshot("sess-1")["items"]:
        q.remove("sess-1", it["id"])
    t.join(5)
    assert posted == [("implementation-requests", "b1", False, "cancelled on the bridge")]


def test_queue_mode_paused_queue_keeps_waiting(monkeypatch):
    """Review focus 1: a paused queue posts nothing; the batch waits for the operator."""
    q = _fake_queue(monkeypatch)
    q.pause("sess-1")
    w, posted = _queue_worker(monkeypatch, _queue_claim(1))
    t = _run_in_thread(w)
    _wait_items(q, "sess-1", 2)
    time.sleep(0.2)
    assert posted == [] and t.is_alive()
    q.resume("sess-1")
    _drive(q, "sess-1", [("done", "did 1", None), ("done", "PR", None)])
    t.join(5)
    assert posted == [("implementation-requests", "b1", True, "PR")]


def test_queue_mode_times_out_and_drops_its_turns(monkeypatch):
    q = _fake_queue(monkeypatch)
    q.pause("sess-1")
    w, posted = _queue_worker(monkeypatch, _queue_claim(1), impl_timeout=0)
    w._run_implementation("b1", "acme/app")
    assert posted == [("implementation-requests", "b1", False, "run timed out after 0s")]
    assert q.snapshot("sess-1")["items"] == []


def _reattach_worker(monkeypatch, listing_row):
    w = _worker()
    posted = []
    monkeypatch.setattr(rivendell, "_POLL_INTERVAL", 0.01)
    monkeypatch.setattr(w, "_claim", lambda *a: (_ for _ in ()).throw(AssertionError("no claim on re-attach")))
    monkeypatch.setattr(w, "_post_result",
                        lambda kind_path, rid, ok, text: posted.append((kind_path, rid, ok, text)))
    monkeypatch.setattr(w, "_api", lambda path, payload=None:
                        [listing_row] if path == "/plugin/implementation-requests" else [])
    return w, posted


def _await_posted(posted):
    for _ in range(500):
        if posted:
            return
        time.sleep(0.01)
    raise AssertionError("nothing posted")


def _tagged(q, sid="sess-1", ref="t1:b1"):
    q.enqueue(sid, text="Task 1", prompt="p", images=[], model=None, effort=None,
              permission_mode="bypassPermissions", width=0, sel=[], surface="rivendell",
              chat_id=555, project="/repo", label="Task 1 · 1/1", link=None, ref=ref)


def test_catch_up_reattaches_a_batch_whose_turns_are_in_the_queue(monkeypatch):
    """After a restart the turns are back from disk (queued, nothing advancing):
    the worker resumes the bucket, waits on them and posts. No claim, no new run."""
    q = _fake_queue(monkeypatch)
    q.pause("sess-1")                      # what a loaded bucket looks like: nothing moving
    _tagged(q)
    w, posted = _reattach_worker(monkeypatch, {
        "id": "b1", "repositoryFullName": "acme/app",
        "batch": {"id": "bb", "name": "Login fixes", "mode": "queue", "url": "https://rv/s/1", "tasks": []}})
    assert w._catch_up() == 0
    assert w.queue_snapshot() == []                       # not held: it runs again
    [row] = w.running_snapshot()
    assert row["session_id"] == "sess-1" and row["label"] == "Login fixes" and row["link"] == "https://rv/s/1"
    for _ in range(500):
        if q.snapshot("sess-1")["paused"] is False:
            break
        time.sleep(0.01)
    assert q.snapshot("sess-1")["paused"] is False        # resumed by the worker
    _drive(q, "sess-1", [("done", "PR", None)])
    _await_posted(posted)
    assert posted == [("implementation-requests", "b1", True, "PR")]
    for _ in range(500):
        if not w.running_snapshot() and w._active_runs == 0:
            break
        time.sleep(0.01)
    assert w.running_snapshot() == [] and w._active_runs == 0


def test_catch_up_reattaches_even_when_every_turn_had_finished(monkeypatch):
    """Review focus 2: the result post is what may have been lost; never run again."""
    q = _fake_queue(monkeypatch)
    _tagged(q)
    running = q.snapshot("sess-1")["items"][0]
    q.notify_job_done("sess-1", running["job_id"], "done", "PR #9", None, 1)
    w, posted = _reattach_worker(monkeypatch, {"id": "b1", "repositoryFullName": "acme/app"})
    w._catch_up()
    _await_posted(posted)
    assert posted == [("implementation-requests", "b1", True, "PR #9")]


def test_catch_up_ignores_the_queue_for_a_request_it_never_queued(monkeypatch):
    q = _fake_queue(monkeypatch)
    _tagged(q, ref="t1:other")
    w, posted = _reattach_worker(monkeypatch, {"id": "b1", "repositoryFullName": "acme/app"})
    monkeypatch.setattr(w, "_apply_policy", lambda key: None)
    assert w._catch_up() == 1                             # held as usual
    assert [r["request_id"] for r in w.queue_snapshot()] == ["b1"]


def test_queue_mode_reconnect_does_not_reattach_a_batch_running_here(monkeypatch):
    """Catch-up lists IN_PROGRESS requests too, so a reconnect lists the batch
    this process is waiting on: a second waiter would post its result twice."""
    q = _fake_queue(monkeypatch)
    w, posted = _queue_worker(monkeypatch, _queue_claim(1))
    monkeypatch.setattr(w, "_api", lambda path, payload=None:
                        [{"id": "b1", "repositoryFullName": "acme/app"}]
                        if path == "/plugin/implementation-requests" else [])
    w.accept(w._enqueue("impl", "b1", "acme/app"))
    _wait_items(q, "sess-1", 2)
    assert w._catch_up() == 0
    assert len(w.running_snapshot()) == 1 and w._active_runs == 1
    _drive(q, "sess-1", [("done", "did 1", None), ("done", "PR", None)])
    for _ in range(500):
        if w._active_runs == 0:
            break
        time.sleep(0.01)
    assert posted == [("implementation-requests", "b1", True, "PR")] and w._active_runs == 0


def test_queue_mode_stopping_worker_leaves_the_turns_and_posts_nothing(monkeypatch):
    """A bridge restart stops the worker mid-batch: the turns stay exactly as they
    are in the persisted queue, for _reattach after the restart, and nothing is
    posted, so the request stays IN_PROGRESS."""
    q = _fake_queue(monkeypatch)
    w, posted = _queue_worker(monkeypatch, _queue_claim(2))
    t = _run_in_thread(w)
    _wait_items(q, "sess-1", 3)
    w.stop()
    t.join(5)
    assert not t.is_alive() and posted == [] and w.running_snapshot() == []
    assert [it["status"] for it in q.snapshot("sess-1")["items"]] == ["running", "queued", "queued"]


def test_queue_mode_stopping_worker_leaves_a_reattached_batch_too(monkeypatch):
    q = _fake_queue(monkeypatch)
    _tagged(q)                             # running
    w, posted = _reattach_worker(monkeypatch, {"id": "b1", "repositoryFullName": "acme/app"})
    w._catch_up()
    w.stop()
    for _ in range(500):
        if w._active_runs == 0:
            break
        time.sleep(0.01)
    assert posted == [] and w._active_runs == 0 and w.running_snapshot() == []
    assert [it["status"] for it in q.snapshot("sess-1")["items"]] == ["running"]


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))


# --- the tab's peek, NEXT UP, and IMPLEMENT's note -----------------------------

def _mcp_answer(payload, is_error=False):
    """Rivendell's /mcp envelope around one tool's answer (JSON in a text block)."""
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return {"jsonrpc": "2.0", "id": 1,
            "result": {"isError": is_error, "content": [{"type": "text", "text": text}]}}


def _tool_call(name, args):
    return ("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                     "params": {"name": name, "arguments": args}})


def test_task_detail_reads_get_task_and_follows_its_spec_link(workers, monkeypatch):
    from bridge import github
    calls, seen = [], []
    w = _worker(id="a")
    w._api = _answering(_mcp_answer({
        "id": "t26", "name": "T26 — Moneybird OAuth",
        "description": "From GitHub: [#43](https://github.com/o/r/issues/43).",
        "tasklistName": "Phase 2 backlog", "createdBy": {"id": "1", "name": "Erfan Besharat"},
        "createdAt": "2026-10-06T12:23:34Z", "estimateMinutes": 240,
        "tags": [{"id": "x", "name": "Review", "color": "#4ecd97"}]}), calls)
    workers["a"] = w
    monkeypatch.setattr(github, "issue_spec", lambda text: seen.append(text) or {"number": 43})

    out = rivendell.task_detail("a", "t26")

    assert calls == [_tool_call("get_task", {"taskId": "t26"})]
    assert seen == ["From GitHub: [#43](https://github.com/o/r/issues/43)."]
    assert out == {"description": "From GitHub: [#43](https://github.com/o/r/issues/43).",
                   "tasklist": "Phase 2 backlog", "createdBy": "Erfan Besharat",
                   "createdAt": "2026-10-06T12:23:34Z", "estimateMinutes": 240,
                   "tags": [{"name": "Review", "color": "#4ecd97"}], "spec": {"number": 43}}


def test_task_detail_says_what_rivendell_said_when_it_cant(workers):
    w = _worker(id="a")
    w._api = _answering(_mcp_answer("Task not found.", is_error=True))
    workers["a"] = w
    with pytest.raises(rivendell.TasksError) as e:
        rivendell.task_detail("a", "gone")
    assert (e.value.code, str(e.value)) == ("refused", "Task not found.")


def test_task_detail_on_a_rivendell_without_mcp_is_not_deployed(workers):
    w = _worker(id="a")
    w._api = _raise_http(404)
    workers["a"] = w
    with pytest.raises(rivendell.TasksError) as e:
        rivendell.task_detail("a", "t26")
    assert e.value.code == "not_deployed"


def test_task_detail_on_an_unknown_instance_is_an_error(workers):
    with pytest.raises(rivendell.TasksError) as e:
        rivendell.task_detail("nope", "t1")
    assert e.value.code == "no_instance"


_TODO = {
    "generatedAt": "2026-09-27T20:55:29.611Z", "progress": {"total": 3, "done": 1},
    "items": [
        {"id": "i1", "position": 0, "section": "High priority", "priority": "high",
         "title": "Build the PR webhook", "done": False,
         "links": [{"type": "TASK", "id": "t14", "label": "Create webhook", "url": "https://tw/t14",
                    "taskProjectId": "p", "done": False}]},
        {"id": "i2", "position": 1, "section": "High priority", "priority": "high",
         "title": "Merge PR #21", "done": True, "links": []},
        {"id": "i3", "position": 2, "section": "Medium priority", "priority": "medium",
         "title": "Fix the hydration error", "done": False,
         "links": [{"type": "SENTRY_ISSUE", "id": "org:1", "label": "FRONTEND-1 Hydration Error",
                    "url": "https://sentry/1", "sentryOrg": "org", "done": None}]},
    ],
}


def test_todolist_is_the_open_items_in_order_with_their_links(workers):
    calls = []
    w = _worker(id="a")
    w._api = _answering(_mcp_answer(_TODO), calls)
    workers["a"] = w

    out = rivendell.todolist("a", "p1")

    assert calls == [_tool_call("get_todolist", {"projectId": "p1"})]
    assert out == {
        "generatedAt": "2026-09-27T20:55:29.611Z", "progress": {"total": 3, "done": 1},
        "items": [
            {"id": "i1", "title": "Build the PR webhook", "priority": "high",
             "links": [{"type": "TASK", "id": "t14", "label": "Create webhook", "url": "https://tw/t14"}]},
            {"id": "i3", "title": "Fix the hydration error", "priority": "medium",
             "links": [{"type": "SENTRY_ISSUE", "id": "org:1", "label": "FRONTEND-1 Hydration Error",
                        "url": "https://sentry/1"}]},
        ]}


def test_todolist_of_a_project_without_one_is_none(workers):
    w = _worker(id="a")
    w._api = _answering(_mcp_answer("null"))
    workers["a"] = w
    assert rivendell.todolist("a", "p1") is None


def test_implement_files_the_note_under_the_new_request(workers):
    calls = []
    w = _worker(id="a")
    w._api = _answering({"id": "r7", "status": "PENDING"}, calls)
    workers["a"] = w
    assert rivendell.implement("a", "t1", "  Copy the TeamLeader module.  ") == {"id": "r7", "status": "PENDING"}
    # Rivendell's own customPrompt would REPLACE its managed template, so the
    # note never goes to Rivendell; this bridge adds it when the job arrives.
    assert calls == [("/plugin/implementation-requests", {"taskId": "t1"})]
    assert w._notes == {"r7": "Copy the TeamLeader module."}


def test_implement_without_a_note_files_nothing(workers):
    w = _worker(id="a")
    w._api = _answering({"id": "r7", "status": "PENDING"})
    workers["a"] = w
    rivendell.implement("a", "t1", "   ")
    assert w._notes == {}


def test_run_implementation_appends_the_operators_note(monkeypatch):
    w = _worker()
    w._notes["r1"] = "Copy the TeamLeader module."
    started = []
    monkeypatch.setattr(w, "_fetch_prompt", lambda kind_path, rid:
                        {"prompt": "Implement T26.", "repositoryFullName": "acme/app"})
    monkeypatch.setattr(w, "_find_checkout", lambda slug: "/tmp")
    monkeypatch.setattr(w, "_post_result", lambda *a: None)
    monkeypatch.setattr(w, "_start_run", lambda prompt, *a, **k: started.append(prompt))
    w._run_implementation("r1", "acme/app")
    assert len(started) == 1
    assert started[0].startswith("Implement T26.")
    assert started[0].endswith("Copy the TeamLeader module.")
    assert "operator" in started[0]
    assert w._notes == {}, "a note is used once"


def test_run_implementation_without_a_note_runs_rivendells_prompt_as_is(monkeypatch):
    w = _worker()
    started = []
    monkeypatch.setattr(w, "_fetch_prompt", lambda kind_path, rid:
                        {"prompt": "Implement T26.", "repositoryFullName": "acme/app"})
    monkeypatch.setattr(w, "_find_checkout", lambda slug: "/tmp")
    monkeypatch.setattr(w, "_post_result", lambda *a: None)
    monkeypatch.setattr(w, "_start_run", lambda prompt, *a, **k: started.append(prompt))
    w._run_implementation("r1", "acme/app")
    assert started == ["Implement T26."]
