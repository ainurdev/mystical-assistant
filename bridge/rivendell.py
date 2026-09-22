"""Rivendell plugin: a websocket client into a rivendell-api instance.

The bridge side of Rivendell's "Request review" and "Implement using AI"
buttons. A background listener holds a persistent WebSocket to rivendell-api's
/agent endpoint (bearer token minted in Rivendell under Profile -> Tokens with
the LLM capability), and a single worker turns each request event into an
autonomous Claude run:

    pr-review-request          -> GET  /plugin/review-requests/<id>/prompt
    task-implementation-request-> GET  /plugin/implementation-requests/<id>/prompt
          (either GET claims the request: PENDING -> IN_PROGRESS)
          -> runner.start_streaming_job(...)            (bypassPermissions,
                                                         RIVENDELL_MODEL)
          -> POST /plugin/<kind>-requests/<id>/result   (COMPLETED | FAILED)

Runs go through the normal runner (not a bare subprocess) on purpose: each
run gets its own store session (origin "rivendell"), so it shows up in the
dashboard with a full transcript, inherits the watchdog, journaling and
auto-resume machinery, and never contends with other sessions' run slots.

Each request names its repository (owner/repo); _find_checkout maps that to a
local checkout under BASE_PATH by matching git origin remotes. Reviews fall
back to RIVENDELL_WORKDIR/BASE_PATH when no checkout matches (the prompt
carries the PR reference, so a generic dir degrades gracefully);
implementations FAIL instead — an autonomous code-writing run must never
land in the wrong directory.

Requests are processed one at a time: two autonomous runs may share a
checkout (same repo, or the shared fallback workdir) and would race each
other's working tree. The websocket is reconnect-forever with capped backoff;
missed events are recovered on each (re)connect via the PENDING catch-up
endpoints.

A bridge restart mid-run loses this module's waiter for the running job
(recovery.recover still resumes the Claude turn, but its result is never
POSTed). The catch-up endpoints therefore return IN_PROGRESS requests too, so
the restarted worker re-claims and redoes them — an interrupted run costs a
re-run, never a request stuck IN_PROGRESS forever. In-process duplicates are
prevented by the _seen set (keys "review:<id>" / "impl:<id>", since the two
request kinds have separate id spaces).
"""

import base64
import json
import os
import queue
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit

from bridge import config, wsutil

_BACKOFF_MIN = 1.0        # first reconnect delay (doubles per failure)
_BACKOFF_MAX = 60.0
_PING_INTERVAL = 30.0     # client ping cadence (also the socket read timeout)
_MAX_MISSED_PONGS = 2     # this many silent intervals -> assume dead, reconnect
_HTTP_TIMEOUT = 30        # prompt fetch / result post
_RESULT_RETRIES = (2, 10, 30)   # a finished run is expensive; retry the POST
_POLL_INTERVAL = 2.0      # job status poll cadence
_CHECKOUT_CACHE_TTL = 300.0   # seconds before the slug->path map is rescanned

_listen_thread: threading.Thread | None = None
_worker_thread: threading.Thread | None = None
_stop = threading.Event()
_queue: queue.Queue = queue.Queue()  # (kind, request_id, slug|None) tuples
_sock: socket.socket | None = None   # current WS, so stop() can unblock reads
_seen_lock = threading.Lock()
_seen: set = set()                   # "<kind>:<id>" queued or already handled

_checkout_lock = threading.Lock()
_checkout_cache: dict = {}           # lowercased "owner/repo" -> abs path
_checkout_cache_at = 0.0             # monotonic time of the last rescan


# --- HTTP to rivendell-api ----------------------------------------------------

def _api(path: str, payload: dict | None = None) -> dict | list:
    """One JSON call against RIVENDELL_API_URL (GET, or POST with payload)."""
    req = urllib.request.Request(
        config.RIVENDELL_API_URL + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Authorization": f"Bearer {config.RIVENDELL_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode() or "{}")


def _fetch_prompt(kind_path: str, request_id: str) -> dict:
    """Claim the request (PENDING -> IN_PROGRESS) and return the response
    (prompt, plus repositoryFullName for implementation requests)."""
    return _api(f"/plugin/{kind_path}/{request_id}/prompt")


def _post_result(kind_path: str, request_id: str, ok: bool, text: str) -> None:
    """Report the outcome, retrying — the run was expensive."""
    payload = {
        "status": "COMPLETED" if ok else "FAILED",
        ("result" if ok else "error"): text,
        "model": config.RIVENDELL_MODEL,
    }
    for i, delay in enumerate((0,) + _RESULT_RETRIES):
        if delay:
            time.sleep(delay)
        try:
            _api(f"/plugin/{kind_path}/{request_id}/result", payload)
            return
        except Exception as e:  # noqa: BLE001 — retried; loud on final failure
            if i == len(_RESULT_RETRIES):
                print(f"rivendell: result POST failed for {request_id}: {e} "
                      "(transcript still in dashboard)")


# --- WebSocket client ---------------------------------------------------------

def _ws_url() -> str:
    """The websocket address: the explicit override, else derived from the API
    URL (http->ws, path /agent). Read per connection attempt so both can be
    changed live from the dashboard's PLUGINS settings."""
    if config.RIVENDELL_WS_URL:
        return config.RIVENDELL_WS_URL
    return (config.RIVENDELL_API_URL.replace("https://", "wss://", 1)
                                    .replace("http://", "ws://", 1) + "/agent")


def _connect() -> tuple:
    """Open the websocket and complete the RFC 6455 client handshake.

    Returns (sock, rfile). Raises on any failure — the caller owns backoff.
    """
    parts = urlsplit(_ws_url())
    secure = parts.scheme == "wss"
    port = parts.port or (443 if secure else 80)
    sock = socket.create_connection((parts.hostname, port), timeout=10)
    if secure:
        sock = ssl.create_default_context().wrap_socket(
            sock, server_hostname=parts.hostname)

    key = base64.b64encode(os.urandom(16)).decode()
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    sock.sendall((
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {parts.hostname}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Authorization: Bearer {config.RIVENDELL_TOKEN}\r\n"
        "\r\n"
    ).encode())

    rfile = sock.makefile("rb")
    status = rfile.readline().decode(errors="replace")
    if "101" not in status:
        raise ConnectionError(f"handshake rejected: {status.strip()}")
    accept = None
    while True:
        line = rfile.readline().decode(errors="replace").strip()
        if not line:
            break
        name, _, value = line.partition(":")
        if name.strip().lower() == "sec-websocket-accept":
            accept = value.strip()
    if accept != wsutil.accept_key(key):
        raise ConnectionError("handshake Sec-WebSocket-Accept mismatch")
    return sock, rfile


def _send(sock: socket.socket, payload: bytes, opcode: int) -> None:
    sock.sendall(wsutil.encode_frame(payload, opcode, masked=True))


def _catch_up() -> None:
    """Queue PENDING requests missed while disconnected. Each kind is fetched
    independently: an older rivendell-api without the implementation endpoint
    must not break review catch-up."""
    try:
        for item in _api("/plugin/review-requests"):
            _enqueue("review", item["id"], item.get("repositoryFullName"))
    except Exception as e:  # noqa: BLE001 — catch-up is best-effort
        print(f"rivendell: review catch-up failed: {e}")
    try:
        for item in _api("/plugin/implementation-requests"):
            _enqueue("impl", item["id"], item.get("repositoryFullName"))
    except Exception as e:  # noqa: BLE001 — catch-up is best-effort
        print(f"rivendell: implementation catch-up failed: {e}")


def _enqueue(kind: str, request_id: str, slug: str | None = None) -> None:
    with _seen_lock:
        key = f"{kind}:{request_id}"
        if key in _seen:
            return
        _seen.add(key)
    _queue.put((kind, request_id, slug))


def _handle_message(raw: bytes) -> None:
    try:
        obj = json.loads(raw.decode())
    except (UnicodeDecodeError, json.JSONDecodeError):
        return
    if obj.get("type") == "pr-review-request" and obj.get("requestId"):
        pr = obj.get("pullRequest") or {}
        print(f"rivendell: review requested for "
              f"{pr.get('repositoryFullName', '?')}#{pr.get('number', '?')}")
        _enqueue("review", obj["requestId"], pr.get("repositoryFullName"))
    elif (obj.get("type") == "task-implementation-request"
          and obj.get("requestId")):
        task = obj.get("task") or {}
        repo = obj.get("repository") or {}
        print(f"rivendell: implementation requested in "
              f"{repo.get('fullName', '?')}: {task.get('name', '?')}")
        _enqueue("impl", obj["requestId"], repo.get("fullName"))


def _listen() -> None:
    """Connection loop: connect, catch up, pump frames; reconnect on any error."""
    global _sock
    backoff = _BACKOFF_MIN
    while not _stop.is_set():
        try:
            sock, rfile = _connect()
        except Exception as e:  # noqa: BLE001 — reconnect-forever by design
            if not _stop.is_set():
                print(f"rivendell: connect failed ({e}); retrying in {backoff:.0f}s")
                _stop.wait(backoff)
                backoff = min(backoff * 2, _BACKOFF_MAX)
            continue

        _sock = sock
        backoff = _BACKOFF_MIN
        print(f"rivendell: connected to {_ws_url()}")
        _catch_up()
        missed = 0
        sock.settimeout(_PING_INTERVAL)
        try:
            while not _stop.is_set():
                try:
                    frame = wsutil.decode_frame(rfile)
                except (socket.timeout, TimeoutError):
                    # Quiet interval: ping. Too many without ANY frame -> dead.
                    missed += 1
                    if missed > _MAX_MISSED_PONGS:
                        raise ConnectionError("peer stopped answering pings")
                    _send(sock, b"", wsutil.OP_PING)
                    continue
                if frame is None:
                    raise ConnectionError("connection closed by peer")
                missed = 0
                opcode, payload = frame
                if opcode == wsutil.OP_PING:
                    _send(sock, payload, wsutil.OP_PONG)
                elif opcode == wsutil.OP_TEXT:
                    _handle_message(payload)
                elif opcode == wsutil.OP_CLOSE:
                    raise ConnectionError("close frame received")
                elif opcode == wsutil.OP_CONT:
                    # Fragmentation is unsupported (see wsutil) — resync.
                    raise ConnectionError("unexpected continuation frame")
                # OP_PONG / anything else: frame arrival already reset `missed`.
        except Exception as e:  # noqa: BLE001 — reconnect-forever by design
            if not _stop.is_set():
                print(f"rivendell: connection lost ({e}); reconnecting")
        finally:
            _sock = None
            try:
                sock.close()
            except OSError:
                pass


# --- Repo discovery -----------------------------------------------------------

def _rescan_checkouts() -> dict:
    """Map every repo under BASE_PATH to its origin slug (lowercased).
    First match wins on duplicate slugs, so the shallowest/earliest checkout
    is the stable pick."""
    from bridge import github                 # local import: subprocess-heavy
    from bridge.browser import list_projects  # local import: pulls telegram

    found: dict = {}
    for repo_rel in list_projects():
        path = os.path.join(config.BASE_PATH, repo_rel.lstrip("/"))
        slug = github.remote_slug(path)
        if slug:
            found.setdefault(slug.lower(), path)
    return found


def _find_checkout(slug: str | None) -> str | None:
    """The local checkout whose git origin matches `slug` (case-insensitive),
    or None. RIVENDELL_WORKDIR wins when it matches — it is the operator's
    dedicated checkout. The scan result is cached (remote_slug shells out per
    repo); a miss on a fresh cache forces one rescan so a just-cloned repo is
    still found."""
    if not slug:
        return None
    from bridge import github                 # local import: subprocess-heavy

    wanted = slug.lower()
    if config.RIVENDELL_WORKDIR:
        workdir_slug = github.remote_slug(config.RIVENDELL_WORKDIR)
        if workdir_slug and workdir_slug.lower() == wanted:
            return config.RIVENDELL_WORKDIR

    global _checkout_cache, _checkout_cache_at
    with _checkout_lock:
        stale = time.monotonic() - _checkout_cache_at > _CHECKOUT_CACHE_TTL
        if stale or wanted not in _checkout_cache:
            _checkout_cache = _rescan_checkouts()
            _checkout_cache_at = time.monotonic()
        return _checkout_cache.get(wanted)


# --- Request runs -------------------------------------------------------------

def _workdir() -> str:
    return config.RIVENDELL_WORKDIR or config.BASE_PATH


def _wait_job(job, timeout: float) -> tuple[bool, str]:
    """Block until the job leaves "running" (or times out). -> (ok, text)."""
    deadline = time.time() + timeout
    while job.status == "running" and time.time() < deadline:
        if _stop.wait(_POLL_INTERVAL):
            break
    if job.status == "running":
        job.interrupt()
        return False, f"run timed out after {timeout}s"
    if job.status == "done":
        text = job.result or "".join(job.texts)
        if text.strip():
            return True, text
        return False, "run finished without producing any result text"
    return False, job.error_msg or job.result or "run errored"


def _start_run(prompt: str, workdir: str):
    """One autonomous Claude run in `workdir` through the normal runner.
    Returns the job, or None if a run could not be started."""
    from bridge import runner, store          # local import: heavy modules
    from bridge.browser import rel

    # Pre-create the session: ensure_session with an unknown id would silently
    # fall back to the project's LATEST session and resume the previous run.
    session = store.create_session(
        config.DASH_CHAT_ID, rel(workdir), session_id=uuid.uuid4().hex,
        origin="rivendell", cwd=workdir, permission_mode="bypassPermissions")
    return runner.start_streaming_job(
        config.DASH_CHAT_ID, prompt, [], project=workdir,
        model=config.RIVENDELL_MODEL, permission_mode="bypassPermissions",
        session_id=session["id"], origin="rivendell")


def _run_review(request_id: str, slug: str | None) -> None:
    try:
        prompt = _fetch_prompt("review-requests", request_id)["prompt"]
    except Exception as e:  # noqa: BLE001 — report instead of crashing the worker
        print(f"rivendell: prompt fetch failed for {request_id}: {e}")
        _post_result("review-requests", request_id, False,
                     f"prompt fetch failed: {e}")
        return

    # Reviews degrade gracefully outside the repo (the prompt names the PR),
    # so an unknown slug falls back to the configured workdir.
    workdir = _find_checkout(slug) or _workdir()
    print(f"rivendell: review {request_id} running in {workdir}")
    job = _start_run(prompt, workdir)
    if job is None:  # can't happen for a fresh session, but never hang the queue
        _post_result("review-requests", request_id, False,
                     "could not start a Claude run (session busy)")
        return

    ok, text = _wait_job(job, config.RIVENDELL_REVIEW_TIMEOUT)
    print(f"rivendell: review {request_id} {'completed' if ok else 'failed'}")
    _post_result("review-requests", request_id, ok, text)


def _run_implementation(request_id: str, slug: str | None) -> None:
    try:
        resp = _fetch_prompt("implementation-requests", request_id)
    except Exception as e:  # noqa: BLE001 — report instead of crashing the worker
        print(f"rivendell: prompt fetch failed for {request_id}: {e}")
        _post_result("implementation-requests", request_id, False,
                     f"prompt fetch failed: {e}")
        return
    prompt = resp["prompt"]
    slug = resp.get("repositoryFullName") or slug

    # No fallback here, unlike reviews: an autonomous bypassPermissions run
    # that WRITES code must never land in an unrelated directory. The claim
    # already happened, so failing lands the request FAILED, not stuck.
    workdir = _find_checkout(slug)
    if workdir is None:
        print(f"rivendell: implementation {request_id}: no checkout for {slug!r}")
        _post_result("implementation-requests", request_id, False,
                     f"no local checkout for {slug!r} under {config.BASE_PATH}")
        return

    print(f"rivendell: implementation {request_id} running in {workdir}")
    job = _start_run(prompt, workdir)
    if job is None:  # can't happen for a fresh session, but never hang the queue
        _post_result("implementation-requests", request_id, False,
                     "could not start a Claude run (session busy)")
        return

    ok, text = _wait_job(job, config.RIVENDELL_IMPL_TIMEOUT)
    print(f"rivendell: implementation {request_id} "
          f"{'completed' if ok else 'failed'}")
    _post_result("implementation-requests", request_id, ok, text)


def _worker() -> None:
    """Single consumer: one run at a time (runs may share a checkout — see
    the module docstring)."""
    while not _stop.is_set():
        try:
            kind, request_id, slug = _queue.get(timeout=1)
        except queue.Empty:
            continue
        kind_path = ("implementation-requests" if kind == "impl"
                     else "review-requests")
        try:
            if kind == "impl":
                _run_implementation(request_id, slug)
            else:
                _run_review(request_id, slug)
        except Exception as e:  # noqa: BLE001 — worker must outlive any run
            print(f"rivendell: {kind} {request_id} crashed: {e}")
            _post_result(kind_path, request_id, False, f"bridge error: {e}")


# --- Lifecycle ----------------------------------------------------------------

def start() -> None:
    """Launch the listener + worker (idempotent). No-op when unconfigured.

    The threads are pure loops driven by ``_stop`` and read config per
    iteration, so "start" after a recent stop() may simply revive the still-
    alive threads by clearing the flag; each is only respawned once dead.
    """
    global _listen_thread, _worker_thread
    if not (config.RIVENDELL_API_URL and config.RIVENDELL_TOKEN):
        print("rivendell: RIVENDELL_API_URL/RIVENDELL_TOKEN unset — not starting")
        return
    _stop.clear()
    if _listen_thread is None or not _listen_thread.is_alive():
        _listen_thread = threading.Thread(target=_listen, name="rivendell-ws",
                                          daemon=True)
        _listen_thread.start()
    if _worker_thread is None or not _worker_thread.is_alive():
        _worker_thread = threading.Thread(target=_worker, name="rivendell-worker",
                                          daemon=True)
        _worker_thread.start()


def stop() -> None:
    _stop.set()
    _drop_connection()


def reconfigure() -> None:
    """React to a live settings change (the dashboard's PLUGINS section).

    Disabled -> stop. Enabled -> (re)start if needed and drop the current
    connection so the listener reconnects with the new URL/token immediately;
    an in-flight review finishes under the settings it started with. Called by
    envsettings._side_effects after every RIVENDELL_* save.
    """
    if not config.RIVENDELL_ENABLE:
        stop()
        return
    start()
    _drop_connection()


def _drop_connection() -> None:
    sock = _sock
    if sock is not None:
        try:
            sock.close()   # unblocks the listener's decode_frame
        except OSError:
            pass
