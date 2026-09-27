"""Rivendell plugin: websocket clients into one or more rivendell-api instances.

The bridge side of Rivendell's "Request review" and "Implement using AI"
buttons. One bridge can serve several Rivendells at once — a production
dashboard, a local one you develop against, a staging one later — so the plugin
runs one independent ``Worker`` per enabled instance (see
``bridge/rivendell_instances.py`` for the config store). Each worker holds a
persistent WebSocket to its instance's /agent endpoint (bearer token minted in
that Rivendell under Profile -> Tokens with the LLM capability). Request events
are held in a per-worker PENDING queue, surfaced in the dashboard's PLUGINS tab,
behind an operator ACCEPT/DISMISS gate — with one convenience: a request that
arrives into an *idle* queue (nothing pending, nothing running) is auto-accepted
immediately, so a lone request never waits on a click. The gate still matters the
moment work stacks up: anything that lands while a run is in flight (or other
requests are already pending) is held for a decision AND pushed to Telegram with
Approve/Dismiss buttons, so it can be decided from the phone. The auto-accepted
first request needs no ping — it is already running. REJECT declines a request
(there is no reject endpoint, so it claims the request and POSTs FAILED, which is
what makes the decision stick):

    pr-review-request           held PENDING in the worker's queue
    task-implementation-request        |  (the first into an idle queue is
    project-todolist-request           |   auto-accepted; the rest ping Telegram)
    task-description-request           v  ACCEPT (dashboard PLUGINS tab / Telegram)
    changelog-request           -> GET  /plugin/<kind>-requests/<id>/prompt
          (the GET claims the request: PENDING -> IN_PROGRESS)
          -> runner.start_streaming_job(...)            (bypassPermissions,
                                                         the instance's model)
          -> POST /plugin/<kind>-requests/<id>/result   (COMPLETED | FAILED)

          DISMISS/REJECT -> claim + POST FAILED ("declined by operator")

A project todolist comes in two steps on the same event and endpoints, told
apart by the event's ``kind``: RECOMMENDATIONS (the agent proposes Teamwork tasks
to create or change, answering in JSON) and TODOLIST (the prioritized checklist,
in markdown). The bridge runs both the same way and posts the answer verbatim —
rivendell-api parses it by the request's kind — and only uses the step to label
the request in the log, the Telegram ping and the dashboard queue.

Reviews and implementations need a local checkout of the named repository;
todolists, task descriptions and changelogs need none — the whole project/task
context (for a changelog: the tasks, pull requests and commits the user picked) is
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

Accepted runs are concurrent: the request prompts instruct each run to work in
its own git worktree, so runs no longer race a shared checkout the way the old
single serial consumer had to guard against. Each accept spawns its own run
thread; distinct instances were already concurrent (separate queues) and still
are. The websocket is reconnect-forever with capped backoff; missed events are
recovered on each (re)connect via the PENDING catch-up endpoints, which
re-populate the queue.

A request stays PENDING server-side until it is accepted, so nothing is lost
across a bridge restart: the queue is rebuilt from the catch-up endpoints. Those
also return IN_PROGRESS requests, so a run interrupted mid-flight by a restart
comes back into the queue for a fresh accept rather than sticking IN_PROGRESS
forever. In-process duplicates are prevented by each worker's _seen set (keys
"review:<id>" / "impl:<id>" / "todolist:<id>" / "taskdesc:<id>" / "changelog:<id>",
since the request
kinds have separate id spaces); a rejected request is claimed+FAILED, so catch-up
never resurrects it.

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
    """A single rivendell-api connection: its listener, its PENDING request queue
    behind the operator accept/reject gate, and the config it reads per iteration
    (so a live edit lands on the next reconnect/review without a restart)."""

    def __init__(self, inst: dict):
        self.inst = inst                     # config dict; swapped, never mutated
        self._stop = threading.Event()
        # Requests awaiting the operator's decision: key "<kind>:<id>" -> a plain
        # dict the dashboard renders. Ordered by insertion (created-at order),
        # which is how the PLUGINS tab shows them.
        self._pending: "dict[str, dict]" = {}
        # How many accepted requests are running right now (auto- or operator-
        # accepted). Guarded by _q_lock alongside _pending: together they answer
        # "is the queue idle?" — the condition for auto-accepting a lone request.
        self._active_runs = 0
        self._q_lock = threading.Lock()      # guards _pending and _active_runs
        self._seen_lock = threading.Lock()
        self._seen: set = set()              # "<kind>:<id>" queued or handled
        self._sock: socket.socket | None = None    # so stop() can unblock reads
        self._listen_thread: threading.Thread | None = None
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
        with self._q_lock:
            before = len(self._pending)
        try:
            for item in self._api("/plugin/review-requests"):
                self._apply_policy(self._enqueue("review", item["id"], item.get("repositoryFullName")))
        except Exception as e:  # noqa: BLE001 — catch-up is best-effort
            print(f"rivendell[{self.name}]: review catch-up failed: {e}")
        try:
            for item in self._api("/plugin/implementation-requests"):
                self._apply_policy(self._enqueue("impl", item["id"], item.get("repositoryFullName")))
        except Exception as e:  # noqa: BLE001 — catch-up is best-effort
            print(f"rivendell[{self.name}]: implementation catch-up failed: {e}")
        try:
            for item in self._api("/plugin/todolist-requests"):
                self._apply_policy(self._enqueue(
                    "todolist", item["id"], item.get("projectName"),
                    step=_todolist_step(item.get("kind"))))
        except Exception as e:  # noqa: BLE001 — catch-up is best-effort
            print(f"rivendell[{self.name}]: todolist catch-up failed: {e}")
        try:
            for item in self._api("/plugin/task-description-requests"):
                self._apply_policy(self._enqueue("taskdesc", item["id"], item.get("taskName")))
        except Exception as e:  # noqa: BLE001 — catch-up is best-effort
            print(f"rivendell[{self.name}]: task-description catch-up failed: {e}")
        try:
            for item in self._api("/plugin/changelog-requests"):
                self._apply_policy(self._enqueue("changelog", item["id"], item.get("projectName")))
        except Exception as e:  # noqa: BLE001 — catch-up is best-effort
            print(f"rivendell[{self.name}]: changelog catch-up failed: {e}")
        with self._q_lock:
            return len(self._pending) - before

    def _enqueue(self, kind: str, request_id: str, slug: "str | None" = None,
                 step: "str | None" = None) -> "str | None":
        """Hold a request PENDING for the operator, deduped per _seen. Pure: it
        adds the row and nothing more — running (or auto-accepting, or pinging
        Telegram) is _apply_policy's job, kept separate so the dedup/parse tests
        stay hermetic. Returns the new key, or None if it was a duplicate.
        `step` tells a todolist's two steps apart ("recommendations" /
        "todolist"); None when the sender did not say (an older rivendell-api)."""
        key = f"{kind}:{request_id}"
        with self._seen_lock:
            if key in self._seen:
                return None
            self._seen.add(key)
        now = time.time()
        self.last_event_at = now
        with self._q_lock:
            self._pending[key] = {
                "key": key, "kind": kind, "request_id": request_id,
                "slug": slug, "step": step, "created_at": now,
            }
        return key

    def _apply_policy(self, key: "str | None") -> None:
        """Decide what happens to a just-queued request. The first request into an
        idle queue (nothing else pending, nothing running) is auto-accepted so a
        lone request never waits on a click; anything behind running or pending
        work is left for the operator and pushed to Telegram with Approve/Dismiss
        buttons. A no-op on None (a duplicate _enqueue dropped)."""
        if key is None:
            return
        with self._q_lock:
            idle = len(self._pending) == 1 and self._active_runs == 0
        if idle:
            self.accept(key)            # auto-accept: run it now, no Telegram ping
        else:
            self._notify_queued(key)    # held for a decision — ping Telegram

    def _handle_message(self, raw: bytes) -> "str | None":
        """Parse and route one websocket frame into the queue (pure enqueue —
        _listen applies the accept/notify policy to the key returned). Returns the
        newly queued key, or None if the frame was noise or a duplicate."""
        try:
            obj = json.loads(raw.decode())
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if obj.get("type") == "pr-review-request" and obj.get("requestId"):
            pr = obj.get("pullRequest") or {}
            print(f"rivendell[{self.name}]: review requested for "
                  f"{pr.get('repositoryFullName', '?')}#{pr.get('number', '?')}")
            return self._enqueue("review", obj["requestId"], pr.get("repositoryFullName"))
        if (obj.get("type") == "task-implementation-request"
                and obj.get("requestId")):
            task = obj.get("task") or {}
            repo = obj.get("repository") or {}
            print(f"rivendell[{self.name}]: implementation requested in "
                  f"{repo.get('fullName', '?')}: {task.get('name', '?')}")
            return self._enqueue("impl", obj["requestId"], repo.get("fullName"))
        if (obj.get("type") == "project-todolist-request"
                and obj.get("requestId")):
            project = obj.get("project") or {}
            step = _todolist_step(obj.get("kind"))
            print(f"rivendell[{self.name}]: "
                  f"{'task recommendations' if step == 'recommendations' else 'todolist'} "
                  f"requested for project {project.get('name', '?')}")
            return self._enqueue("todolist", obj["requestId"], project.get("name"),
                                 step=step)
        if (obj.get("type") == "task-description-request"
                and obj.get("requestId")):
            task = obj.get("task") or {}
            print(f"rivendell[{self.name}]: task description requested for "
                  f"{task.get('name', '?')}")
            return self._enqueue("taskdesc", obj["requestId"], task.get("name"))
        if obj.get("type") == "changelog-request" and obj.get("requestId"):
            project = obj.get("project") or {}
            print(f"rivendell[{self.name}]: changelog requested for project "
                  f"{project.get('name', '?')}")
            return self._enqueue("changelog", obj["requestId"], project.get("name"))
        return None

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
                        self._apply_policy(self._handle_message(payload))
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

    def _run_todolist(self, request_id: str, project: "str | None",
                      step: "str | None" = None) -> None:
        """One step of a project todolist — task recommendations (JSON) or the
        prioritized todolist (markdown). No checkout (see _run_in_workdir); the
        answer posts back verbatim and rivendell-api parses it by step."""
        what = "task recommendations" if step == "recommendations" else "todolist"
        self._run_in_workdir(what, "todolist-requests", request_id, project)

    def _run_taskdesc(self, request_id: str, task: "str | None") -> None:
        """An AI task-description generation — no checkout (see _run_in_workdir).
        rivendell-api writes the generated text back onto the Teamwork task
        itself; the bridge only returns it."""
        self._run_in_workdir("task description", "task-description-requests",
                             request_id, task)

    def _run_changelog(self, request_id: str, project: "str | None") -> None:
        """A changelog generation from the sources the user picked — no checkout
        (see _run_in_workdir). The markdown returned IS the changelog; rivendell
        keeps it as the generator's history."""
        self._run_in_workdir("changelog", "changelog-requests", request_id, project)

    def _run_in_workdir(self, what: str, kind_path: str, request_id: str,
                        name: "str | None") -> None:
        """Run a request that needs NO checkout: its whole context is rendered
        into the prompt server-side, so it always runs in the worker's workdir
        (never a repo match), read-only in spirit. Reviews' timeout governs it.
        `what` names it in the log, `name` is the project/task it is about."""
        try:
            prompt = self._fetch_prompt(kind_path, request_id)["prompt"]
        except Exception as e:  # noqa: BLE001 — report, don't crash the worker
            print(f"rivendell[{self.name}]: prompt fetch failed for "
                  f"{request_id}: {e}")
            self._post_result(kind_path, request_id, False,
                              f"prompt fetch failed: {e}")
            return

        workdir = self._workdir()
        print(f"rivendell[{self.name}]: {what} {request_id} "
              f"({name or '?'}) running in {workdir}")
        job = self._start_run(prompt, workdir)
        if job is None:  # can't happen for a fresh session; never hang the queue
            self._post_result(kind_path, request_id, False,
                              "could not start a Claude run (session busy)")
            return

        ok, text = self._wait_job(job, self.inst.get("review_timeout", 3600))
        print(f"rivendell[{self.name}]: {what} {request_id} "
              f"{'completed' if ok else 'failed'}")
        self._post_result(kind_path, request_id, ok, text)

    _KIND_PATH = {
        "impl": "implementation-requests",
        "review": "review-requests",
        "todolist": "todolist-requests",
        "taskdesc": "task-description-requests",
        "changelog": "changelog-requests",
    }

    # -- Telegram ping for queued (non-auto-accepted) requests --
    _KIND_LABEL = {
        "review": "PR review",
        "impl": "implementation",
        "todolist": "todolist",
        "taskdesc": "task description",
        "changelog": "changelog",
    }

    def _label(self, item: dict) -> str:
        """What to call a queued request: its kind, except that a todolist's
        first step reads as the task recommendations it is."""
        if item["kind"] == "todolist" and item.get("step") == "recommendations":
            return "task recommendations"
        return self._KIND_LABEL.get(item["kind"], item["kind"])

    def _queued_message(self, item: dict, token: str) -> tuple:
        """The Telegram text + Approve/Dismiss keyboard for one queued request.
        Pure (no I/O), so the wording and callback wiring are unit-testable. The
        buttons carry a short token (callback_data is capped at 64 bytes, and a
        request id can be a full UUID) that resolve_token maps back to this
        worker + key."""
        what = self._label(item)
        target = item.get("slug") or "?"
        text = (f"🧩 Rivendell {what} queued — {target}\n"
                f"Instance: {self.name}\n"
                "Something is already running. Approve to run it too, or dismiss.")
        kb = {"inline_keyboard": [[
            {"text": "✅ Approve", "callback_data": f"rv:a:{token}"},
            {"text": "🚫 Dismiss", "callback_data": f"rv:d:{token}"},
        ]]}
        return text, kb

    def _notify_queued(self, key: str) -> None:
        """Ping Telegram that a request is waiting behind running work, with
        Approve/Dismiss buttons so it can be decided from the phone. Best-effort
        and off-thread — a slow Telegram call must never stall the listener."""
        with self._q_lock:
            item = self._pending.get(key)
        if item is None:                      # decided already (a fast click)
            return
        token = _register_token(self.id, key)
        text, kb = self._queued_message(item, token)
        threading.Thread(target=self._deliver_telegram, args=(text, kb),
                         name=f"rivendell-tg-{self.id}", daemon=True).start()

    def _deliver_telegram(self, text: str, kb: dict) -> None:
        """Send one queued-request ping to the operator's chat. Silent when
        Telegram is not configured ("if available"): the request still shows in
        the dashboard's PLUGINS queue regardless."""
        if not config.NOTIFY_ENABLE or not config.TOKEN or not config.DASH_CHAT_ID:
            return
        try:
            from bridge import telegram   # local import: telegram pulls state/config
            telegram.send(config.DASH_CHAT_ID, text, kb)
        except Exception as e:  # noqa: BLE001 — a ping failure must never crash a worker
            print(f"rivendell[{self.name}]: queue Telegram ping failed: {e}")

    # -- accept/reject gate --
    def queue_snapshot(self) -> list:
        """The PENDING requests awaiting a decision, oldest first — the rows the
        dashboard's PLUGINS queue renders."""
        with self._q_lock:
            items = sorted(self._pending.values(), key=lambda r: r["created_at"])
        return [dict(r) for r in items]

    def accept(self, key: str) -> bool:
        """Claim and run one pending request, concurrently with any others (its
        prompt isolates it in its own worktree). Returns False if the key is not
        pending (already accepted/rejected, or a stale click)."""
        with self._q_lock:
            item = self._pending.pop(key, None)
            if item is None:
                return False
            # Count it running before the thread starts, so a request that lands
            # between now and the run finishing sees a busy queue (and pings)
            # rather than racing in as another "lone" auto-accept.
            self._active_runs += 1
        threading.Thread(
            target=self._run_accepted, args=(dict(item),),
            name=f"rivendell-run-{self.id}", daemon=True).start()
        return True

    def reject(self, key: str) -> bool:
        """Decline one pending request. There is no reject endpoint, so this
        claims it (PENDING -> IN_PROGRESS) and POSTs FAILED — that is what makes
        the decision stick server-side and keeps catch-up from resurrecting it.
        Runs off-thread so a slow POST never blocks the HTTP handler."""
        with self._q_lock:
            item = self._pending.pop(key, None)
        if item is None:
            return False
        threading.Thread(
            target=self._do_reject, args=(dict(item),),
            name=f"rivendell-reject-{self.id}", daemon=True).start()
        return True

    def _run_accepted(self, item: dict) -> None:
        """Dispatch one accepted request to its runner; a crash lands it FAILED so
        the request never sticks IN_PROGRESS. The worker outlives any run."""
        kind, request_id, slug = item["kind"], item["request_id"], item["slug"]
        kind_path = self._KIND_PATH.get(kind, "review-requests")
        try:
            if kind == "impl":
                self._run_implementation(request_id, slug)
            elif kind == "todolist":
                self._run_todolist(request_id, slug, item.get("step"))
            elif kind == "taskdesc":
                self._run_taskdesc(request_id, slug)
            elif kind == "changelog":
                self._run_changelog(request_id, slug)
            else:
                self._run_review(request_id, slug)
        except Exception as e:  # noqa: BLE001 — worker must outlive any run
            print(f"rivendell[{self.name}]: {kind} {request_id} crashed: {e}")
            self._post_result(kind_path, request_id, False, f"bridge error: {e}")
        finally:
            # Release the run slot so the queue reads idle again once nothing is in
            # flight (clamped: a direct _run_accepted with no matching accept()
            # increment must not drive the count negative).
            with self._q_lock:
                self._active_runs = max(0, self._active_runs - 1)

    def _do_reject(self, item: dict) -> None:
        kind_path = self._KIND_PATH.get(item["kind"], "review-requests")
        request_id = item["request_id"]
        # Claim first: the result endpoint expects a claimed (IN_PROGRESS) request.
        # A claim failure (already gone, older API) is fine — still try to FAIL it.
        try:
            self._fetch_prompt(kind_path, request_id)
        except Exception as e:  # noqa: BLE001 — best-effort claim
            print(f"rivendell[{self.name}]: reject claim failed for "
                  f"{request_id}: {e}")
        print(f"rivendell[{self.name}]: {item['kind']} {request_id} "
              "rejected by operator")
        self._post_result(kind_path, request_id, False, "declined by operator")

    # -- lifecycle --
    def start(self) -> None:
        """Launch the listener (idempotent). The listener is a pure loop driven by
        ``self._stop`` that reads config per iteration, so a start after a recent
        stop may simply revive a still-alive thread by clearing the flag; it is
        only respawned once dead. Accepted runs get their own threads on demand —
        there is no standing consumer to launch."""
        self._stop.clear()
        if self._listen_thread is None or not self._listen_thread.is_alive():
            self._listen_thread = threading.Thread(
                target=self._listen, name=f"rivendell-ws-{self.id}", daemon=True)
            self._listen_thread.start()

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


def queue() -> dict:
    """PENDING requests per instance id, for the dashboard's PLUGINS queue.
    Disabled/removed instances have no worker and are simply absent."""
    with _manager_lock:
        return {wid: w.queue_snapshot() for wid, w in _workers.items()}


# --- Telegram callback tokens -------------------------------------------------
# A queued-request ping's Approve/Dismiss buttons can't carry (instance_id, key)
# directly: callback_data is capped at 64 bytes and a request id can be a full
# UUID. Each ping mints a short token here mapping back to (instance_id, key);
# the dispatch callback resolves it once (one-shot: a second click on a handled
# ping finds nothing and is reported "already handled").
_tg_tokens: "dict[str, tuple[str, str]]" = {}
_tg_tokens_lock = threading.Lock()


def _todolist_step(kind: "str | None") -> "str | None":
    """A todolist request's step from rivendell-api's ``kind`` (RECOMMENDATIONS
    / TODOLIST); None when it sent none (an API from before the two steps)."""
    if kind == "RECOMMENDATIONS":
        return "recommendations"
    if kind == "TODOLIST":
        return "todolist"
    return None


def _register_token(instance_id: str, key: str) -> str:
    token = uuid.uuid4().hex[:10]
    with _tg_tokens_lock:
        _tg_tokens[token] = (instance_id, key)
    return token


def resolve_token(token: str) -> "tuple[str, str] | None":
    """Map a Telegram button token back to (instance_id, key), consuming it so a
    repeated click is a no-op. None if unknown (already used, or a stale ping)."""
    with _tg_tokens_lock:
        return _tg_tokens.pop(token, None)


def accept(instance_id: str, key: str) -> bool:
    """Accept one pending request on the named instance. False if the instance
    has no running worker or the key is no longer pending."""
    with _manager_lock:
        w = _workers.get(instance_id)
    return bool(w and w.accept(key))


def reject(instance_id: str, key: str) -> bool:
    """Reject one pending request on the named instance. False if the instance
    has no running worker or the key is no longer pending."""
    with _manager_lock:
        w = _workers.get(instance_id)
    return bool(w and w.reject(key))


# Boot entry point (claude_telegram_bridge.py) and the settings save hook both
# call this; reconfigure is the whole mechanism, so start is just its name at
# boot.
start = reconfigure


def stop() -> None:
    with _manager_lock:
        for w in _workers.values():
            w.stop()
        _workers.clear()
