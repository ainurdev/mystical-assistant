"""Rivendell plugin: websocket clients into one or more rivendell-api instances.

The bridge side of Rivendell's "Request review" and "Implement using AI"
buttons. One bridge can serve several Rivendells at once — a production
dashboard, a local one you develop against, a staging one later — so the plugin
runs one independent ``Worker`` per enabled instance (see
``bridge/rivendell_instances.py`` for the config store). Each worker holds a
persistent WebSocket to its instance's /agent endpoint (bearer token minted in
that Rivendell under Profile -> Tokens with the LLM capability), and a single
per-worker consumer turns each request event into an autonomous Claude run:

    pr-review-request          -> GET  /plugin/review-requests/<id>/prompt
    task-implementation-request-> GET  /plugin/implementation-requests/<id>/prompt
    project-todolist-request   -> GET  /plugin/todolist-requests/<id>/prompt
    task-description-request    -> GET  /plugin/task-description-requests/<id>/prompt
          (each GET claims the request: PENDING -> IN_PROGRESS)
          -> runner.start_streaming_job(...)            (bypassPermissions,
                                                         the instance's model)
          -> POST /plugin/<kind>-requests/<id>/result   (COMPLETED | FAILED)

Reviews and implementations need a local checkout of the named repository;
todolists and task descriptions need none — the whole project/task context is
rendered into the prompt server-side, so they run in the worker's workdir like a
generic read task (rivendell-api writes a task description back onto the Teamwork
task itself; the bridge only returns the generated text).

Runs go through the normal runner (not a bare subprocess) on purpose: each run
gets its own store session (origin "rivendell:<instance>"), so it shows up in
the dashboard with a full transcript — and tagged with which Rivendell it came
from — inherits the watchdog, journaling and auto-resume machinery, and never
contends with other sessions' run slots.

Each request names its repository (owner/repo); _find_checkout maps that to a
local checkout under BASE_PATH by matching git origin remotes (the scan is
BASE_PATH-wide, so it is shared across workers; each worker's own WORKDIR still
wins for its runs). Reviews fall back to the worker's WORKDIR/BASE_PATH when no
checkout matches (the prompt carries the PR reference, so a generic dir degrades
gracefully); implementations FAIL instead — an autonomous code-writing run must
never land in the wrong directory.

A worker processes its requests one at a time: two autonomous runs may share a
checkout (same repo, or the shared fallback workdir) and would race each other's
working tree. Distinct instances run concurrently — they are separate queues —
which is fine as long as their WORKDIRs differ. The websocket is
reconnect-forever with capped backoff; missed events are recovered on each
(re)connect via the PENDING catch-up endpoints.

A bridge restart mid-run loses a worker's waiter for the running job (recovery
still resumes the Claude turn, but its result is never POSTed). The catch-up
endpoints therefore return IN_PROGRESS requests too, so the restarted worker
re-claims and redoes them — an interrupted run costs a re-run, never a request
stuck IN_PROGRESS forever. In-process duplicates are prevented by each worker's
_seen set (keys "review:<id>" / "impl:<id>" / "todolist:<id>" / "taskdesc:<id>",
since the request kinds have separate id spaces).

A token/auth failure is treated apart from a transient network fault: the gateway
accepts the upgrade and then closes with 4401/4403 (or a proxy rejects the
handshake with 401/403). Re-dialing a rejected token only hammers the API to no
effect, so the worker stops dialing and idles on that token until it is changed —
reconfigure nudges the paused listener (self._wake) when the config, and thus
possibly the token, is edited. Every other error keeps the reconnect-forever
backoff.

The manager (reconfigure/start/stop) diffs the desired set of enabled instances
against the running workers on every save: it starts new ones, stops removed or
disabled ones, and for a changed one swaps the config live (the worker reads its
config per iteration, so a URL/token edit takes effect on the next reconnect
without interrupting an in-flight review).
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

# WebSocket close codes the gateway uses to reject a bad/insufficient token (see
# rivendell-api's AgentGateway: it accepts the upgrade, then closes).
_WS_AUTH_CLOSE_CODES = (4401, 4403)


class _AuthError(Exception):
    """The token was rejected (handshake 401/403, or a 4401/4403 close). Distinct
    from a transient fault: the worker must stop dialing until the token changes,
    not back off and retry the same doomed credential."""

# The BASE_PATH slug->checkout scan is instance-independent, so it is shared
# across every worker rather than rescanned per connection.
_checkout_lock = threading.Lock()
_checkout_cache: dict = {}           # lowercased "owner/repo" -> abs path
_checkout_cache_at = 0.0             # monotonic time of the last rescan


# --- Repo discovery (shared across workers) -----------------------------------

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


# --- One connection into one rivendell-api instance ---------------------------

class Worker:
    """A single rivendell-api connection: its listener, its one-at-a-time run
    consumer, and the config it reads per iteration (so a live edit lands on the
    next reconnect/review without a restart)."""

    def __init__(self, inst: dict):
        self.inst = inst                     # config dict; swapped, never mutated
        self._stop = threading.Event()
        self._queue: queue.Queue = queue.Queue()   # (kind, request_id, slug|None)
        self._seen_lock = threading.Lock()
        self._seen: set = set()              # "<kind>:<id>" queued or handled
        self._sock: socket.socket | None = None    # so stop() can unblock reads
        self._listen_thread: threading.Thread | None = None
        self._worker_thread: threading.Thread | None = None
        # A token that was rejected: while it is still the configured token the
        # listener idles instead of reconnecting. Cleared when the token changes.
        self._blocked_token: str | None = None
        # Nudges a listener parked on a rejected token — set by reconfigure (the
        # token may have changed) and by stop().
        self._wake = threading.Event()
        # Live connection status, read by the dashboard's PLUGINS panel so an
        # operator can see whether the socket is actually up. "off" until the
        # listener starts; "connecting" while dialing; "connected" once the
        # handshake and catch-up succeed; "error" between failed attempts (with
        # the reason in status_detail). connected_since dates the current
        # connection; last_event_at dates the last request seen on it.
        self.status = "off"
        self.status_detail = ""
        self.status_at = time.time()
        self.connected_since: float | None = None
        self.last_event_at: float | None = None

    def _set_status(self, state: str, detail: str = "") -> None:
        self.status = state
        self.status_detail = detail
        self.status_at = time.time()
        if state == "connected":
            self.connected_since = self.status_at
        elif state != "connected":
            self.connected_since = None

    def status_snapshot(self) -> dict:
        return {
            "state": self.status,
            "detail": self.status_detail,
            "since": self.status_at,
            "connected_since": self.connected_since,
            "last_event_at": self.last_event_at,
        }

    # -- config accessors (read live off self.inst) --
    @property
    def id(self) -> str:
        return self.inst["id"]

    @property
    def name(self) -> str:
        return self.inst.get("name") or self.inst["id"]

    @property
    def api_url(self) -> str:
        return (self.inst.get("api_url") or "").rstrip("/")

    @property
    def token(self) -> str:
        return self.inst.get("token") or ""

    @property
    def model(self) -> str:
        return self.inst.get("model") or "opus"

    @property
    def origin(self) -> str:
        from bridge import rivendell_instances
        return rivendell_instances.origin_for(self.inst)

    def _workdir(self) -> str:
        return self.inst.get("workdir") or config.BASE_PATH

    # -- HTTP to this rivendell-api --
    def _api(self, path: str, payload: "dict | None" = None):
        """One JSON call against this instance (GET, or POST with payload)."""
        req = urllib.request.Request(
            self.api_url + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            method="POST" if payload is not None else "GET",
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode() or "{}")

    def _fetch_prompt(self, kind_path: str, request_id: str) -> dict:
        """Claim the request (PENDING -> IN_PROGRESS) and return the response
        (prompt, plus repositoryFullName for implementation requests)."""
        return self._api(f"/plugin/{kind_path}/{request_id}/prompt")

    def _post_result(self, kind_path: str, request_id: str, ok: bool, text: str) -> None:
        """Report the outcome, retrying — the run was expensive."""
        payload = {
            "status": "COMPLETED" if ok else "FAILED",
            ("result" if ok else "error"): text,
            "model": self.model,
        }
        for i, delay in enumerate((0,) + _RESULT_RETRIES):
            if delay:
                time.sleep(delay)
            try:
                self._api(f"/plugin/{kind_path}/{request_id}/result", payload)
                return
            except Exception as e:  # noqa: BLE001 — retried; loud on final failure
                if i == len(_RESULT_RETRIES):
                    print(f"rivendell[{self.name}]: result POST failed for "
                          f"{request_id}: {e} (transcript still in dashboard)")

    # -- WebSocket client --
    def _ws_url(self) -> str:
        """The websocket address: the explicit override, else derived from the
        API URL (http->ws, path /agent). Read per connection attempt so both can
        be changed live from the dashboard's PLUGINS settings."""
        if self.inst.get("ws_url"):
            return self.inst["ws_url"]
        return (self.api_url.replace("https://", "wss://", 1)
                            .replace("http://", "ws://", 1) + "/agent")

    def _connect(self) -> tuple:
        """Open the websocket and complete the RFC 6455 client handshake.

        Returns (sock, rfile). Raises on any failure — the caller owns backoff.
        """
        parts = urlsplit(self._ws_url())
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
            f"Authorization: Bearer {self.token}\r\n"
            "\r\n"
        ).encode())

        rfile = sock.makefile("rb")
        status = rfile.readline().decode(errors="replace")
        if "101" not in status:
            # A proxy or the app rejecting the upgrade with 401/403 is a token
            # problem, not a transient fault. (The gateway itself accepts the
            # upgrade and closes with 4401/4403 instead — caught in _listen.)
            fields = status.split()
            if len(fields) > 1 and fields[1] in ("401", "403"):
                raise _AuthError(f"token rejected at handshake: {status.strip()}")
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

    def _send(self, sock: socket.socket, payload: bytes, opcode: int) -> None:
        sock.sendall(wsutil.encode_frame(payload, opcode, masked=True))

    def _catch_up(self) -> int:
        """Queue PENDING requests missed while disconnected, returning how many
        were newly queued. Each kind is fetched independently: an older
        rivendell-api without the implementation or todolist endpoint must not
        break review catch-up."""
        before = self._queue.qsize()
        try:
            for item in self._api("/plugin/review-requests"):
                self._enqueue("review", item["id"], item.get("repositoryFullName"))
        except Exception as e:  # noqa: BLE001 — catch-up is best-effort
            print(f"rivendell[{self.name}]: review catch-up failed: {e}")
        try:
            for item in self._api("/plugin/implementation-requests"):
                self._enqueue("impl", item["id"], item.get("repositoryFullName"))
        except Exception as e:  # noqa: BLE001 — catch-up is best-effort
            print(f"rivendell[{self.name}]: implementation catch-up failed: {e}")
        try:
            for item in self._api("/plugin/todolist-requests"):
                self._enqueue("todolist", item["id"], item.get("projectName"))
        except Exception as e:  # noqa: BLE001 — catch-up is best-effort
            print(f"rivendell[{self.name}]: todolist catch-up failed: {e}")
        try:
            for item in self._api("/plugin/task-description-requests"):
                self._enqueue("taskdesc", item["id"], item.get("taskName"))
        except Exception as e:  # noqa: BLE001 — catch-up is best-effort
            print(f"rivendell[{self.name}]: task-description catch-up failed: {e}")
        return self._queue.qsize() - before

    def _enqueue(self, kind: str, request_id: str, slug: "str | None" = None) -> None:
        with self._seen_lock:
            key = f"{kind}:{request_id}"
            if key in self._seen:
                return
            self._seen.add(key)
        self.last_event_at = time.time()
        self._queue.put((kind, request_id, slug))

    def _handle_message(self, raw: bytes) -> None:
        try:
            obj = json.loads(raw.decode())
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if obj.get("type") == "pr-review-request" and obj.get("requestId"):
            pr = obj.get("pullRequest") or {}
            print(f"rivendell[{self.name}]: review requested for "
                  f"{pr.get('repositoryFullName', '?')}#{pr.get('number', '?')}")
            self._enqueue("review", obj["requestId"], pr.get("repositoryFullName"))
        elif (obj.get("type") == "task-implementation-request"
              and obj.get("requestId")):
            task = obj.get("task") or {}
            repo = obj.get("repository") or {}
            print(f"rivendell[{self.name}]: implementation requested in "
                  f"{repo.get('fullName', '?')}: {task.get('name', '?')}")
            self._enqueue("impl", obj["requestId"], repo.get("fullName"))
        elif (obj.get("type") == "project-todolist-request"
              and obj.get("requestId")):
            project = obj.get("project") or {}
            print(f"rivendell[{self.name}]: todolist requested for project "
                  f"{project.get('name', '?')}")
            self._enqueue("todolist", obj["requestId"], project.get("name"))
        elif (obj.get("type") == "task-description-request"
              and obj.get("requestId")):
            task = obj.get("task") or {}
            print(f"rivendell[{self.name}]: task description requested for "
                  f"{task.get('name', '?')}")
            self._enqueue("taskdesc", obj["requestId"], task.get("name"))

    def _block_on_token(self, detail: str) -> None:
        """A token was rejected: pin the failing token and stop dialing it. The
        listener idles at the top of _listen until the token is changed."""
        self._blocked_token = self.token
        if not self._stop.is_set():
            self._set_status("auth_error", detail)
            print(f"rivendell[{self.name}]: {detail}; not retrying until the "
                  "token is changed")

    def _listen(self) -> None:
        """Connection loop: connect, catch up, pump frames; reconnect on error.
        A token rejection idles the loop (no backoff-retry) until the token
        changes — see the module docstring."""
        backoff = _BACKOFF_MIN
        while not self._stop.is_set():
            # A token rejected on the last attempt: idle until it is changed.
            # Re-dialing a known-bad credential would hammer the API forever.
            if self._blocked_token is not None:
                if self.token != self._blocked_token:
                    self._blocked_token = None          # token edited — try it
                    backoff = _BACKOFF_MIN
                else:
                    self._wake.wait()                   # reconfigure/stop wakes us
                    self._wake.clear()
                    continue

            url = self._ws_url()
            self._set_status("connecting", url)
            print(f"rivendell[{self.name}]: connecting to {url}")
            try:
                sock, rfile = self._connect()
            except _AuthError as e:
                self._block_on_token(str(e))
                continue
            except Exception as e:  # noqa: BLE001 — reconnect-forever by design
                if not self._stop.is_set():
                    self._set_status("error", str(e))
                    print(f"rivendell[{self.name}]: connect failed ({e}); "
                          f"retrying in {backoff:.0f}s")
                    self._stop.wait(backoff)
                    backoff = min(backoff * 2, _BACKOFF_MAX)
                continue

            self._sock = sock
            backoff = _BACKOFF_MIN
            self._set_status("connected", url)
            caught = self._catch_up()
            print(f"rivendell[{self.name}]: connected to {url}"
                  + (f" ({caught} pending request(s) caught up)" if caught else ""))
            missed = 0
            sock.settimeout(_PING_INTERVAL)
            try:
                while not self._stop.is_set():
                    try:
                        frame = wsutil.decode_frame(rfile)
                    except (socket.timeout, TimeoutError):
                        # Quiet interval: ping. Too many without ANY frame -> dead.
                        missed += 1
                        if missed > _MAX_MISSED_PONGS:
                            raise ConnectionError("peer stopped answering pings")
                        self._send(sock, b"", wsutil.OP_PING)
                        continue
                    if frame is None:
                        raise ConnectionError("connection closed by peer")
                    missed = 0
                    opcode, payload = frame
                    if opcode == wsutil.OP_PING:
                        self._send(sock, payload, wsutil.OP_PONG)
                    elif opcode == wsutil.OP_TEXT:
                        self._handle_message(payload)
                    elif opcode == wsutil.OP_CLOSE:
                        # The gateway accepts the upgrade, then closes with
                        # 4401/4403 for a bad/insufficient token — a token
                        # problem, not a transient drop.
                        code = (int.from_bytes(payload[:2], "big")
                                if len(payload) >= 2 else 0)
                        if code in _WS_AUTH_CLOSE_CODES:
                            reason = payload[2:].decode(errors="replace").strip()
                            raise _AuthError(
                                f"token rejected by gateway ({code}"
                                + (f" {reason}" if reason else "") + ")")
                        raise ConnectionError("close frame received")
                    elif opcode == wsutil.OP_CONT:
                        # Fragmentation is unsupported (see wsutil) — resync.
                        raise ConnectionError("unexpected continuation frame")
                    # OP_PONG / anything else: arrival already reset `missed`.
            except _AuthError as e:
                self._block_on_token(str(e))
            except Exception as e:  # noqa: BLE001 — reconnect-forever by design
                if not self._stop.is_set():
                    self._set_status("error", str(e))
                    print(f"rivendell[{self.name}]: connection lost ({e}); "
                          "reconnecting")
            finally:
                self._sock = None
                try:
                    sock.close()
                except OSError:
                    pass

    # -- repo discovery --
    def _find_checkout(self, slug: "str | None") -> "str | None":
        """The local checkout whose git origin matches `slug`
        (case-insensitive), or None. This worker's own WORKDIR wins when it
        matches — it is the operator's dedicated checkout. The BASE_PATH scan is
        shared and cached (remote_slug shells out per repo); a miss on a fresh
        cache forces one rescan so a just-cloned repo is still found."""
        if not slug:
            return None
        from bridge import github             # local import: subprocess-heavy

        wanted = slug.lower()
        workdir = self.inst.get("workdir")
        if workdir:
            workdir_slug = github.remote_slug(workdir)
            if workdir_slug and workdir_slug.lower() == wanted:
                return workdir

        global _checkout_cache, _checkout_cache_at
        with _checkout_lock:
            stale = time.monotonic() - _checkout_cache_at > _CHECKOUT_CACHE_TTL
            if stale or wanted not in _checkout_cache:
                _checkout_cache = _rescan_checkouts()
                _checkout_cache_at = time.monotonic()
            return _checkout_cache.get(wanted)

    # -- request runs --
    def _wait_job(self, job, timeout: float) -> tuple:
        """Block until the job leaves "running" (or times out). -> (ok, text)."""
        deadline = time.time() + timeout
        while job.status == "running" and time.time() < deadline:
            if self._stop.wait(_POLL_INTERVAL):
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

    def _start_run(self, prompt: str, workdir: str):
        """One autonomous Claude run in `workdir` through the normal runner.
        Returns the job, or None if a run could not be started."""
        from bridge import runner, store      # local import: heavy modules
        from bridge.browser import rel

        # Pre-create the session: ensure_session with an unknown id would
        # silently fall back to the project's LATEST session and resume the
        # previous run.
        session = store.create_session(
            config.DASH_CHAT_ID, rel(workdir), session_id=uuid.uuid4().hex,
            origin=self.origin, cwd=workdir, permission_mode="bypassPermissions")
        return runner.start_streaming_job(
            config.DASH_CHAT_ID, prompt, [], project=workdir,
            model=self.model, permission_mode="bypassPermissions",
            session_id=session["id"], origin=self.origin)

    def _run_review(self, request_id: str, slug: "str | None") -> None:
        try:
            prompt = self._fetch_prompt("review-requests", request_id)["prompt"]
        except Exception as e:  # noqa: BLE001 — report, don't crash the worker
            print(f"rivendell[{self.name}]: prompt fetch failed for "
                  f"{request_id}: {e}")
            self._post_result("review-requests", request_id, False,
                              f"prompt fetch failed: {e}")
            return

        # Reviews degrade gracefully outside the repo (the prompt names the PR),
        # so an unknown slug falls back to the configured workdir.
        workdir = self._find_checkout(slug) or self._workdir()
        print(f"rivendell[{self.name}]: review {request_id} running in {workdir}")
        job = self._start_run(prompt, workdir)
        if job is None:  # can't happen for a fresh session; never hang the queue
            self._post_result("review-requests", request_id, False,
                              "could not start a Claude run (session busy)")
            return

        ok, text = self._wait_job(job, self.inst.get("review_timeout", 3600))
        print(f"rivendell[{self.name}]: review {request_id} "
              f"{'completed' if ok else 'failed'}")
        self._post_result("review-requests", request_id, ok, text)

    def _run_implementation(self, request_id: str, slug: "str | None") -> None:
        try:
            resp = self._fetch_prompt("implementation-requests", request_id)
        except Exception as e:  # noqa: BLE001 — report, don't crash the worker
            print(f"rivendell[{self.name}]: prompt fetch failed for "
                  f"{request_id}: {e}")
            self._post_result("implementation-requests", request_id, False,
                              f"prompt fetch failed: {e}")
            return
        prompt = resp["prompt"]
        slug = resp.get("repositoryFullName") or slug

        # No fallback here, unlike reviews: an autonomous bypassPermissions run
        # that WRITES code must never land in an unrelated directory. The claim
        # already happened, so failing lands the request FAILED, not stuck.
        workdir = self._find_checkout(slug)
        if workdir is None:
            print(f"rivendell[{self.name}]: implementation {request_id}: "
                  f"no checkout for {slug!r}")
            self._post_result("implementation-requests", request_id, False,
                              f"no local checkout for {slug!r} under "
                              f"{config.BASE_PATH}")
            return

        print(f"rivendell[{self.name}]: implementation {request_id} "
              f"running in {workdir}")
        job = self._start_run(prompt, workdir)
        if job is None:  # can't happen for a fresh session; never hang the queue
            self._post_result("implementation-requests", request_id, False,
                              "could not start a Claude run (session busy)")
            return

        ok, text = self._wait_job(job, self.inst.get("impl_timeout", 10800))
        print(f"rivendell[{self.name}]: implementation {request_id} "
              f"{'completed' if ok else 'failed'}")
        self._post_result("implementation-requests", request_id, ok, text)

    def _run_todolist(self, request_id: str, project: "str | None") -> None:
        """A project todolist generation. Unlike a review or implementation this
        needs NO checkout — the whole project context is rendered into the
        prompt server-side — so it always runs in the worker's workdir (never a
        repo match), read-only in spirit. Reviews' timeout governs it."""
        try:
            prompt = self._fetch_prompt("todolist-requests", request_id)["prompt"]
        except Exception as e:  # noqa: BLE001 — report, don't crash the worker
            print(f"rivendell[{self.name}]: prompt fetch failed for "
                  f"{request_id}: {e}")
            self._post_result("todolist-requests", request_id, False,
                              f"prompt fetch failed: {e}")
            return

        workdir = self._workdir()
        print(f"rivendell[{self.name}]: todolist {request_id} "
              f"({project or '?'}) running in {workdir}")
        job = self._start_run(prompt, workdir)
        if job is None:  # can't happen for a fresh session; never hang the queue
            self._post_result("todolist-requests", request_id, False,
                              "could not start a Claude run (session busy)")
            return

        ok, text = self._wait_job(job, self.inst.get("review_timeout", 3600))
        print(f"rivendell[{self.name}]: todolist {request_id} "
              f"{'completed' if ok else 'failed'}")
        self._post_result("todolist-requests", request_id, ok, text)

    def _run_taskdesc(self, request_id: str, task: "str | None") -> None:
        """An AI task-description generation. Like a todolist it needs NO checkout
        — the task, its project and sibling context are rendered into the prompt
        server-side — so it always runs in the worker's workdir. rivendell-api
        writes the generated text back onto the Teamwork task itself; the bridge
        only returns it. Reviews' timeout governs it."""
        try:
            prompt = self._fetch_prompt(
                "task-description-requests", request_id)["prompt"]
        except Exception as e:  # noqa: BLE001 — report, don't crash the worker
            print(f"rivendell[{self.name}]: prompt fetch failed for "
                  f"{request_id}: {e}")
            self._post_result("task-description-requests", request_id, False,
                              f"prompt fetch failed: {e}")
            return

        workdir = self._workdir()
        print(f"rivendell[{self.name}]: task description {request_id} "
              f"({task or '?'}) running in {workdir}")
        job = self._start_run(prompt, workdir)
        if job is None:  # can't happen for a fresh session; never hang the queue
            self._post_result("task-description-requests", request_id, False,
                              "could not start a Claude run (session busy)")
            return

        ok, text = self._wait_job(job, self.inst.get("review_timeout", 3600))
        print(f"rivendell[{self.name}]: task description {request_id} "
              f"{'completed' if ok else 'failed'}")
        self._post_result("task-description-requests", request_id, ok, text)

    _KIND_PATH = {
        "impl": "implementation-requests",
        "review": "review-requests",
        "todolist": "todolist-requests",
        "taskdesc": "task-description-requests",
    }

    def _consume(self) -> None:
        """Single consumer: one run at a time (runs may share a checkout — see
        the module docstring)."""
        while not self._stop.is_set():
            try:
                kind, request_id, slug = self._queue.get(timeout=1)
            except queue.Empty:
                continue
            kind_path = self._KIND_PATH.get(kind, "review-requests")
            try:
                if kind == "impl":
                    self._run_implementation(request_id, slug)
                elif kind == "todolist":
                    self._run_todolist(request_id, slug)
                elif kind == "taskdesc":
                    self._run_taskdesc(request_id, slug)
                else:
                    self._run_review(request_id, slug)
            except Exception as e:  # noqa: BLE001 — worker must outlive any run
                print(f"rivendell[{self.name}]: {kind} {request_id} crashed: {e}")
                self._post_result(kind_path, request_id, False, f"bridge error: {e}")

    # -- lifecycle --
    def start(self) -> None:
        """Launch the listener + consumer (idempotent). Threads are pure loops
        driven by ``self._stop`` and read config per iteration, so a start after
        a recent stop may simply revive still-alive threads by clearing the
        flag; each is only respawned once dead."""
        self._stop.clear()
        if self._listen_thread is None or not self._listen_thread.is_alive():
            self._listen_thread = threading.Thread(
                target=self._listen, name=f"rivendell-ws-{self.id}", daemon=True)
            self._listen_thread.start()
        if self._worker_thread is None or not self._worker_thread.is_alive():
            self._worker_thread = threading.Thread(
                target=self._consume, name=f"rivendell-worker-{self.id}",
                daemon=True)
            self._worker_thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()            # release a listener parked on a bad token
        self._set_status("off", "stopped")
        self._drop_connection()

    def _drop_connection(self) -> None:
        sock = self._sock
        if sock is not None:
            try:
                sock.close()   # unblocks the listener's decode_frame
            except OSError:
                pass


# --- Manager: one worker per enabled instance ---------------------------------

_workers: "dict[str, Worker]" = {}
_manager_lock = threading.Lock()


def _desired() -> dict:
    """The enabled instances, id -> config dict. Missing store degrades to none
    so a plugin hiccup never crashes the manager."""
    try:
        from bridge import rivendell_instances
        return {i["id"]: i for i in rivendell_instances.raw_instances()
                if i.get("enable") and i.get("api_url") and i.get("token")}
    except Exception as e:  # noqa: BLE001
        print(f"rivendell: could not read instances: {e}")
        return {}


def reconfigure() -> None:
    """Diff the enabled instances against the running workers, and reconcile.

    New/enabled -> start. Removed/disabled -> stop. Changed -> swap the config
    onto the live worker and drop its connection so the new URL/token is used on
    the next reconnect (an in-flight review finishes under the config it started
    with, matching the old singleton's behaviour). Called at boot and after any
    save from the dashboard's PLUGINS panel."""
    desired = _desired()
    with _manager_lock:
        for wid in list(_workers):
            if wid not in desired:
                w = _workers.pop(wid)
                print(f"rivendell[{w.name}]: disabled — stopping")
                w.stop()
        for wid, inst in desired.items():
            w = _workers.get(wid)
            if w is None:
                w = _workers[wid] = Worker(inst)
                print(f"rivendell[{w.name}]: enabled — starting")
                w.start()
            elif w.inst != inst:
                print(f"rivendell[{w.name}]: config changed — reconnecting")
                w.inst = inst              # atomic ref swap; threads read it live
                w.start()                  # revive any dead thread
                w._wake.set()              # release a listener parked on a bad token
                w._drop_connection()       # reconnect now with the new config


def status() -> dict:
    """Live connection status per instance id, for the dashboard's PLUGINS
    panel. Instances with no running worker (disabled/removed) are simply
    absent — the panel shows them "off"."""
    with _manager_lock:
        return {wid: w.status_snapshot() for wid, w in _workers.items()}


# Boot entry point (claude_telegram_bridge.py) and the settings save hook both
# call this; reconfigure is the whole mechanism, so start is just its name at
# boot.
start = reconfigure


def stop() -> None:
    with _manager_lock:
        for w in _workers.values():
            w.stop()
        _workers.clear()
