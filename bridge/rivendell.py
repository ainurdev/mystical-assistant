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
Approve/Dismiss buttons, so it can be decided from the phone — and if nobody
decides, the oldest held request starts on its own once nothing is running
(_drain), so a request never waits on a click forever. The auto-accepted
first request needs no ping — it is already running. REJECT declines a request
by refusing it (below):

    pr-review-request           held PENDING in the worker's queue
    task-implementation-request        |  -> POST .../<id>/ack  received | queued
    project-todolist-request           |  (the first into an idle queue is
    task-description-request           |   auto-accepted; the rest ping Telegram)
    changelog-request                  v  ACCEPT (dashboard PLUGINS tab / Telegram)
          -> GET  /plugin/<kind>-requests/<id>/prompt
          (the GET claims the request: PENDING -> IN_PROGRESS)
          -> runner.start_streaming_job(...)            (bypassPermissions,
                                                         the instance's model)
          -> POST /plugin/<kind>-requests/<id>/result   (COMPLETED | FAILED)

          DISMISS/REJECT, or an implementation with no local checkout
          -> POST /plugin/<kind>-requests/<id>/refuse   (dismissed | no-checkout)

The ack/refuse handshake: Rivendell re-sends a job's event to its requester's
bridge every ~20s until that bridge acks or refuses it (for up to two minutes),
so a job lost in a reconnect gap is not silently stranded. Every newly queued
job is acked — "received" when auto-accepted, "queued" when held for the
operator — and a duplicate event for a job still held here is re-acked
"queued" (the first ack was lost). Acks are best-effort and off-thread. A
refusal does not hand the job to some other bridge behind the requester's back:
Rivendell asks the requester whether another bridge may run it, to keep
waiting, or to cancel. On "keep waiting" it clears the refusal and re-sends
once, so a refused key is forgotten from _seen and that re-send goes through
the policy afresh. Older rivendell-apis 404 the new endpoints: acks are just
logged, a no-checkout refusal falls back to /pass, and a dismissal falls back
to claim + POST FAILED ("declined by operator").

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
task itself; the bridge only returns the generated text). The exception is a
claim that names the project's repositories (todolists and changelogs, from a
rivendell-api that sends them): it runs in the folder holding this machine's
checkouts of those repos, matched on any git remote (_project_dir), so its
session lands under that project rather than BASE_PATH's root.

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
gracefully); implementations never do — an autonomous code-writing run must
never land in the wrong directory. A bridge with no checkout doesn't take the
request at all but refuses it (_apply_policy), leaving it PENDING for the
requester to offer elsewhere; the FAIL in _run_implementation is only the
backstop.

Which bridge gets a request is rivendell-api's call: it runs on its requester's
own bridge (the one holding their token). While that bridge is online only it
hears about the request, and catch-up and claims follow the same rule; the
first claim is exclusive. Only the requester agreeing after a refusal offers it
to other bridges — catch-up never lists another user's jobs otherwise, nor the
ones this bridge refused while the requester is deciding. A claim refused with
409 (another bridge's, or waiting for its requester's) is simply not ours:
nothing runs and nothing is posted.

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
forever — except a queue-mode batch, which re-attaches to its persisted turns
instead (below). In-process duplicates are prevented by each worker's _seen set (keys
"review:<id>" / "impl:<id>" / "todolist:<id>" / "taskdesc:<id>" / "changelog:<id>",
since the request kinds have separate id spaces). A refused request leaves
_seen (catch-up no longer lists it, so that costs no rescan per reconnect);
on an older API a dismissed one is claimed+FAILED, so catch-up never
resurrects it.

Queue mode: an implementation claim that carries `steps` (a start-work batch)
runs as queued turns, not one run. Each step becomes one turn in a single fresh
session's queue (bridge/queue_manager.py), in order, tagged `ref`
"<instance id>:<request id>" with the step's label and Rivendell link, so the
QUEUE tab shows them and the operator can pause or drop them. The worker waits
on its tagged turns and posts one result at the end: the last turn's answer, or
the first failed turn's error. The turns persist with the queue: after a
restart the steps still to run wait in a paused bucket, and catch-up re-attaches
to the turns (_reattach: no new claim; it resumes the bucket and waits again)
instead of starting the batch over.

The listener reads with a socket timeout so a quiet interval can ping. A
timed-out read leaves Python's socket file unusable, so the listener rebuilds
it over the same socket rather than dropping a healthy connection (see _listen).

A token/auth failure is treated apart from a transient network fault: the gateway
accepts the upgrade and then closes with 4401/4403 (or a proxy rejects the
handshake with 401/403). Re-dialing a rejected token only hammers the API to no
effect, so the worker stops dialing and idles on that token until it is changed —
reconfigure nudges the paused listener (self._wake) when the config, and thus
possibly the token, is edited. Every other error keeps the reconnect-forever
backoff.

The contract beyond jobs is negotiated: on each connection Rivendell may send
{"type": "hello", "features": [...]} first, and the bridge sends something new —
progress, result details, test jobs — only for a feature named there (features
reset per connection). The deployed Rivendell sends no hello and 400s unknown
result fields (forbidNonWhitelisted), so it keeps getting exactly today's
traffic. Frames from Rivendell this bridge doesn't know are ignored, as ever.

A broken link is a *break*: it opens at the first failure, ends only when the
link proves itself (a frame arrives, or a quiet interval passes with no close —
_recovered), and is flagged once: one Telegram message, plus alert_at on the
status for the dashboard's rail dot and bell. Flagged at once on the move to
auth_error, after _LINK_GRACE of anything else; an instance switched off never
pings.

The manager (reconfigure/start/stop) diffs the desired set of enabled instances
against the running workers on every save: it starts new ones, stops removed or
disabled ones, and for a changed one swaps the config live (the worker reads its
config per iteration, so a URL/token edit takes effect on the next reconnect
without interrupting an in-flight review).

The dashboard's RIVENDELL tab goes through here as well (tasks / implement, at
the bottom). It lists a repo's open tasks, and IMPLEMENT only asks Rivendell to
create the request. The run itself comes back over the socket like any other.
Every run is filed under its request (store sessions.ref, written by _track),
so a card still opens the session of a run that has ended, after a restart
too. A card's run view (live_view / _result_view) is read off the live job
and the store; nothing asks Rivendell. A Rivendell run's question pings
Telegram with its options as buttons (ping_question); a tap or a text reply
answers the live run. The channel around it — link state, run views, NEEDS
YOU — is docs/superpowers/specs/rivendell-channel.md.
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
from urllib.parse import quote, urlsplit

from bridge import config, wsutil

_BACKOFF_MIN = 1.0        # first reconnect delay (doubles per failure)
_BACKOFF_MAX = 60.0
_PING_INTERVAL = 30.0     # client ping cadence (also the socket read timeout)
_MAX_MISSED_PONGS = 2     # this many silent intervals -> assume dead, reconnect
_HTTP_TIMEOUT = 30        # prompt fetch / result post
_RESULT_RETRIES = (2, 10, 30)   # a finished run is expensive; retry the POST
_ERROR_MAX = 5000         # Rivendell's MaxLength on a result's error: longer is a 400
_POLL_INTERVAL = 2.0      # job status poll cadence
_HELD_MAX = 24 * 3600.0   # a run may wait on a person this long in all; then it fails
_CHECKOUT_CACHE_TTL = 300.0   # seconds before the slug->path map is rescanned
_CHECKS_TTL = 120.0       # seconds a PR's checks state is reused across tab polls
_LINK_GRACE = 300.0       # an outage this long is a break worth one Telegram message
_TEST_TIMEOUT = 5.0       # seconds TEST LINK waits for its pong
_PROGRESS_EVERY = 10.0    # at most one progress post per run this often (spec: ~10 s)
_ACTIVITY = {"tool": "action", "thinking": "thought", "text": "response", "error": "error"}
_checks_cache: "dict[str, tuple[float, str | None]]" = {}
_checks_busy: "set[str]" = set()          # PR urls whose checks are being refreshed
_checks_lock = threading.Lock()

# WebSocket close codes the gateway uses to reject a bad/insufficient token (see
# rivendell-api's AgentGateway: it accepts the upgrade, then closes).
_WS_AUTH_CLOSE_CODES = (4401, 4403)


class _AuthError(Exception):
    """The token was rejected (handshake 401/403, or a 4401/4403 close). Distinct
    from a transient fault: the worker must stop dialing until the token changes,
    not back off and retry the same doomed credential."""


def _refused(e: Exception) -> bool:
    """rivendell-api refused a claim with 409: the request is another bridge's
    (claimed, or waiting for its requester's own bridge) or already finished."""
    return isinstance(e, urllib.error.HTTPError) and e.code == 409

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


def _project_dir(repos) -> "str | None":
    """Where a project-level job runs: the folder holding this machine's
    checkouts of the project's repos — its repo for a one-repo project, the
    shared parent for several (NR's under ~/projects/ainurhq/nationale-
    rijschool) — so the session files under that project, not BASE_PATH. A
    checkout matches on ANY git remote, not just origin: a fork cloned from
    the mirror still tracks the linked repo under another name. None when the
    claim named no repos (an older rivendell-api), none is cloned here, or the
    matches share nothing below BASE_PATH."""
    wanted = {r.lower() for r in repos or () if r}
    if not wanted:
        return None
    from bridge import github                 # local import: subprocess-heavy
    from bridge.browser import list_projects  # local import: pulls telegram

    # ponytail: uncached, one `git remote -v` per repo per job — project-level
    # jobs come a few a day; share _checkout_cache's TTL if they get frequent.
    paths = [path for path in (os.path.join(config.BASE_PATH, r.lstrip("/"))
                               for r in list_projects())
             if wanted & {s.lower() for s in github.remote_slugs(path)}]
    if not paths:
        return None
    common = os.path.commonpath(paths)
    return common if common != config.BASE_PATH else None


def _held(sid: str) -> bool:
    """Is session `sid`'s live turn held on a question or an approval? A batch's
    clock pauses while it is (Worker._wait_queue; see Worker._wait_job)."""
    from bridge import runner                    # local import: heavy module
    job = runner.live_job(sid)
    return bool(job and job.pending)


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
        self._q_lock = threading.Lock()      # guards _pending, _active_runs and _running
        self._seen_lock = threading.Lock()
        self._seen: set = set()              # "<kind>:<id>" queued or handled
        # Request id -> the run in flight: the store session running it (the
        # RIVENDELL tab's OPEN SESSION, the QUEUE tab's RUNNING rows) and what to
        # call it. Memory only: a restart ends a one-turn run anyway, and a
        # queue-mode batch is found again through its queue items (_reattach).
        self._running: "dict[str, dict]" = {}
        self._sock: socket.socket | None = None    # so stop() can unblock reads
        self._listen_thread: threading.Thread | None = None
        self._progress_thread: threading.Thread | None = None
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
        # The current break (see _set_status): when it began, and when it was
        # flagged — once per break, cleared when the link proves itself
        # (_recovered). attempt/retry_at drive the tab's "RETRY n · 20s" chip.
        self.down_since: float | None = None
        self.alert_at: float | None = None
        self.attempt = 0
        self.retry_at: float | None = None
        # The last good /plugin/tasks answer per repo slug: an instance that
        # fails still shows its cards, dimmed as "last known" (tasks()). One
        # entry per repo the tab has shown.
        self._last_tasks: "dict[str, dict]" = {}
        # TEST LINK: nonce -> the event its pong sets; the last outcome (Settings
        # ▸ PLUGINS shows it). The send lock keeps TEST LINK's ping (an HTTP
        # thread) from interleaving with the listener's own frames.
        self._pongs: "dict[bytes, threading.Event]" = {}
        self._send_lock = threading.Lock()
        self.last_test: "dict | None" = None
        # What this connection's Rivendell said it understands, in its hello
        # (docs/superpowers/specs/rivendell-channel.md, Contract). Empty until it
        # does; the deployed API sends no hello, so it stays empty and gets
        # exactly today's traffic.
        self.features: frozenset = frozenset()

    def _set_status(self, state: str, detail: str = "") -> None:
        self.status = state
        self.status_detail = detail
        self.status_at = time.time()
        if state == "connected":
            self.connected_since = self.status_at
            self.attempt, self.retry_at = 0, None
        elif state != "connected":
            self.connected_since = None
        # The break behind the rail dot, the bell and the one Telegram message
        # (docs/superpowers/specs/rivendell-channel.md §B). It opens at the first
        # failure and closes only when the link proves itself (_recovered):
        # "connected" is just the 101, and the gateway closes a bad token after
        # it. Switching off closes it silently: an instance you turned off never
        # pings.
        if state == "off":
            self.down_since = self.alert_at = None
        elif state in ("error", "auth_error") and self.down_since is None:
            self.down_since = self.status_at
        if (self.alert_at is None and self.down_since is not None and state != "connected"
                and (state == "auth_error" or self.status_at - self.down_since >= _LINK_GRACE)):
            # ponytail: the grace is checked on status changes, which come at least
            # every backoff + dial timeout (≤ 70 s) while the link is down, so the
            # alert lands up to that late. A timer, if minutes must be exact.
            self.alert_at = self.status_at
            self._alert_broken()

    def status_snapshot(self) -> dict:
        return {
            "state": self.status,
            "detail": self.status_detail,
            "since": self.status_at,
            "connected_since": self.connected_since,
            "last_event_at": self.last_event_at,
            "down_since": self.down_since,      # when the current break began
            "alert_at": self.alert_at,          # when it was flagged: dot, bell, Telegram
            "attempt": self.attempt,            # failed dials in a row
            "retry_at": self.retry_at,          # when the next dial starts
            "last_test": self.last_test,
            "features": sorted(self.features),
        }

    def _recovered(self) -> None:
        """The link has proven itself: a frame arrived on it, or a whole quiet
        interval passed without the gateway closing it. Only now is a break
        over. The gateway closes a bad token AFTER the upgrade, so the 101 alone
        (status "connected") can't clear the alert, or every re-dial of a dead
        token would end one break and open the next."""
        self.down_since = self.alert_at = None

    def test_link(self, timeout: float = _TEST_TIMEOUT) -> dict:
        """TEST LINK: one WebSocket ping/pong round trip on the live socket. The
        gateway's `ws` (8.x, autoPong) answers every ping with a pong carrying
        the same payload, so a nonce proves the link end to end with no
        Rivendell change. Parked on a rejected token it re-dials once with that
        same token instead: Rivendell closes 4401 for ANY failure of its token
        check, a database hiccup included, and a parked worker never retries on
        its own. Anything else is reported as it stands — the listener is
        already retrying. Kept as `last_test`."""
        sock = self._sock
        if self.status == "auth_error":
            self._blocked_token = None
            self._wake.set()
            res = {"ok": None, "rtt_ms": None, "detail": "re-dialing with the saved token"}
        elif self.status != "connected" or sock is None:
            res = {"ok": False, "rtt_ms": None, "detail": self.status_detail or self.status}
        else:
            nonce, got = os.urandom(8), threading.Event()
            self._pongs[nonce] = got
            t0 = time.monotonic()
            try:
                self._send(sock, nonce, wsutil.OP_PING)
                ok = got.wait(timeout)
                res = {"ok": ok, "rtt_ms": round((time.monotonic() - t0) * 1000) if ok else None,
                       "detail": "" if ok else f"no pong in {timeout:g}s"}
            except OSError as e:
                res = {"ok": False, "rtt_ms": None, "detail": str(e)}
            finally:
                self._pongs.pop(nonce, None)
        self.last_test = {**res, "at": time.time()}
        return self.last_test

    def _post_pong(self, request_id: str) -> None:
        try:
            self._api(f"/plugin/ping-requests/{request_id}/result", {})
        except Exception as e:  # noqa: BLE001 — Rivendell then reads the test as failed
            print(f"rivendell[{self.name}]: ping answer failed for {request_id}: {e}")

    def test_job(self) -> dict:
        """SEND TEST JOB: Rivendell files a `ping`, sends it down the socket, and
        this bridge answers it without Claude (_post_pong). That is HTTP in, the
        socket out, HTTP back: the whole path a real job takes. Rivendell holds
        the first POST open until the answer lands. Offered once its hello names
        "ping", and kept as `last_test` like TEST LINK."""
        t0 = time.monotonic()
        try:
            ok = bool(self._api("/plugin/ping-requests", {}).get("ok"))
            res = {"ok": ok, "rtt_ms": round((time.monotonic() - t0) * 1000) if ok else None,
                   "detail": "" if ok else "the job never came back over the socket"}
        except Exception as e:  # noqa: BLE001 — one line for the row
            res = {"ok": False, "rtt_ms": None, "detail": str(_explain(e))}
        self.last_test = {**res, "via": "job", "at": time.time()}
        return self.last_test

    def _alert_broken(self) -> None:
        """The break's one Telegram message (the dashboard's rail dot and bell
        read alert_at off the status). Off-thread: _set_status runs on the
        listener. No settings button: the dashboard is localhost-only and the
        Mini App has no Rivendell settings, so the text says where to go."""
        at = time.strftime("%H:%M", time.localtime(self.down_since or time.time()))
        if self.status == "auth_error":
            text = (f"✕ Rivendell link broken — {self.name}\n"
                    f"Rivendell refused this bridge's token at {at} ({self.status_detail}). "
                    "Jobs are paused until you replace it: mint a new LLM token in "
                    "Rivendell ▸ Profile ▸ API tokens, then paste it in the dashboard "
                    "under Settings ▸ PLUGINS.")
        else:
            text = (f"✕ Rivendell link broken — {self.name}\n"
                    f"Can't reach Rivendell since {at} ({self.status_detail}). "
                    "The bridge keeps retrying; jobs wait until it's back.")
        threading.Thread(target=self._deliver_telegram, args=(text, None),
                         name=f"rivendell-tg-{self.id}", daemon=True).start()

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

    def _claim(self, kind_path: str, request_id: str) -> "dict | None":
        """_fetch_prompt for a run: the claim response, or None when this bridge
        must not run it. A refused claim (409) is someone else's request, so
        nothing is posted; any other error lands it FAILED."""
        try:
            return self._fetch_prompt(kind_path, request_id)
        except Exception as e:  # noqa: BLE001 — report, don't crash the worker
            if _refused(e):
                print(f"rivendell[{self.name}]: {request_id} is not ours "
                      f"to run: {e}")
                return None
            print(f"rivendell[{self.name}]: prompt fetch failed for "
                  f"{request_id}: {e}")
            self._post_result(kind_path, request_id, False,
                              f"prompt fetch failed: {e}")
            return None

    def _post_result(self, kind_path: str, request_id: str, ok: bool, text: str) -> None:
        """Report the outcome. The run was expensive, so a network or server
        failure is retried with backoff; a 4xx is Rivendell refusing this very
        body, which waiting can't change, so it isn't. A Rivendell whose hello
        said "result-details" also gets `details` (_result_details); if it
        refuses them (400), the plain result goes again at once without them —
        the result is what counts, and the deployed API 400s any field it
        doesn't know. `error` is cut to Rivendell's _ERROR_MAX. Only a result
        that landed gets the "job done" ping."""
        payload = {
            "status": "COMPLETED" if ok else "FAILED",
            ("result" if ok else "error"): text if ok else text[:_ERROR_MAX],
            "model": self.model,
        }
        if "result-details" in self.features:
            try:
                if (details := self._result_details(request_id)):
                    payload["details"] = details
            except Exception as e:  # noqa: BLE001 — the plain result still goes
                print(f"rivendell[{self.name}]: result details failed for {request_id}: {e}")
        delays = iter(_RESULT_RETRIES)
        while True:
            try:
                self._api(f"/plugin/{kind_path}/{request_id}/result", payload)
                break
            except Exception as e:  # noqa: BLE001 — retried; loud on final failure
                code = e.code if isinstance(e, urllib.error.HTTPError) else None
                if code == 400 and payload.pop("details", None) is not None:
                    print(f"rivendell[{self.name}]: details refused for {request_id} "
                          f"({e}); resending the result without them")
                    continue
                refused = code is not None and 400 <= code < 500 and code not in (408, 429)
                delay = None if refused else next(delays, None)
                if delay is None:
                    print(f"rivendell[{self.name}]: result POST failed for "
                          f"{request_id}: {e} (transcript still in dashboard)")
                    return
                time.sleep(delay)
        self._ping_done(request_id, ok, text)

    def _progress_loop(self) -> None:
        """Rivendell's live feed for every run in flight here (_progress_tick on
        each poll beat). Its own thread, so no run path changes shape."""
        last: dict = {}
        while not self._stop.wait(_POLL_INTERVAL):
            try:
                self._progress_tick(last, time.monotonic())
            except Exception as e:  # noqa: BLE001 — the feed outlives any beat
                print(f"rivendell[{self.name}]: progress beat failed: {e}")

    def _progress_tick(self, last: dict, now: float) -> None:
        """One beat: each run in flight posts its progress_body when it changed —
        at most every _PROGRESS_EVERY s, but at once when it starts or stops
        waiting on a person. Silent unless this Rivendell's hello said
        "progress". `last` is request id -> (body, when posted), recorded only
        once a beat is settled (_post_progress): a run held on a question
        doesn't change its body, so a beat lost to the network must go again.
        Runs that ended are forgotten."""
        if "progress" not in self.features:
            return
        from bridge import runner                    # local import: heavy module
        with self._q_lock:
            rows = list(self._running.values())
        for r in rows:
            job = runner.live_job(r["session_id"])
            if job is None:
                continue
            body = progress_body(job)
            prev = last.get(r["request_id"])
            if prev and (prev[0] == body or (prev[0]["state"] == body["state"]
                                              and now - prev[1] < _PROGRESS_EVERY)):
                continue
            if self._post_progress(self._KIND_PATH.get(r["kind"], "review-requests"),
                                   r["request_id"], body):
                last[r["request_id"]] = (body, now)
        for gone in set(last) - {r["request_id"] for r in rows}:
            last.pop(gone)

    def _post_progress(self, kind_path: str, request_id: str, body: dict) -> bool:
        """POST one beat. True once it is settled: Rivendell has it, or refused
        this very body (a 4xx — resending it can't help). False when it should
        go again on the next beat (the network, a 5xx)."""
        try:
            self._api(f"/plugin/{kind_path}/{request_id}/progress", body)
            return True
        except Exception as e:  # noqa: BLE001 — the next beat resends it
            print(f"rivendell[{self.name}]: progress post failed for {request_id}: {e}")
            return (isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500
                    and e.code not in (408, 429))

    def _rivendell_answer(self, obj: dict) -> None:
        """A NEEDS YOU answer given in Rivendell. Only the bridge's owner may
        give one, and Rivendell checks that (claimedById). It answers the question
        its run is held on, matched by the question's id, so an answer to a
        question already answered here, or to an earlier one, is dropped, never
        misapplied. Same path as the session's QuestionCard (Job.respond), so the
        same run continues."""
        from bridge import runner                    # local import: heavy module
        with self._q_lock:
            row = self._running.get(obj.get("requestId") or "")
        job = runner.live_job(row["session_id"]) if row else None
        qid = obj.get("questionId") or ""
        entry = (next((p for p in list(job.pending) if p.get("request_id") == qid), None)
                 if job else None)
        if entry is None:
            print(f"rivendell[{self.name}]: answer for {obj.get('requestId')} dropped: "
                  "its question no longer waits")
            return
        a = obj.get("answer") or {}
        q = (entry.get("questions") or [{}])[0]
        ans = {"header": q.get("header") or q.get("question") or "",
               "labels": [str(x) for x in a.get("labels") or []]}
        if str(a.get("notes") or "").strip():
            ans["notes"] = str(a["notes"]).strip()
        job.respond(qid, answers=[ans])

    def _result_details(self, request_id: str) -> "dict | None":
        """The structured half of a result (spec: Contract → Result), read off
        the session that ran it: the outcome the transcript shows, the PR with
        its checks, wall and active time (active = wall minus waiting on a
        person), tokens, and where to open it on this bridge. Wire names are
        camelCase, as Rivendell's DTOs are. None when no run happened here."""
        from bridge import attribution, store        # local import: heavy modules
        ref = f"{self.id}:{request_id}"
        sid = store.sessions_for_refs([ref]).get(ref)
        if sid is None:
            return None
        res = _result_view(sid) or {}
        b = attribution.breakdown(sid)
        return {"outcome": res.get("outcome"), "pr": res.get("pr"), "sessionId": sid,
                "dashboardUrl": f"http://localhost:{config.DASH_PORT}/?s={sid}",
                "wallSeconds": round(b["wall"]),
                "activeSeconds": round(max(0.0, b["wall"] - b["waiting_s"])),
                "tokens": res.get("tokens")}

    def _ping_done(self, request_id: str, ok: bool, text: str) -> None:
        """The job's one Telegram message once its result is posted: done or
        failed, its PR and time, with OPEN PR and OPEN SESSION. Only for a job
        that ran here (a session is filed under it); checks are left out — they
        have only just started. Best-effort: a lost ping never fails a result."""
        try:
            from bridge import store                 # local import: heavy module
            ref = f"{self.id}:{request_id}"
            sid = store.sessions_for_refs([ref]).get(ref)
            if sid is None:
                return
            sess = store.get_session(sid) or {"id": sid}
            msg, kb = _done_message(sess, ok, text, _result_view(sid, checks=False) or {})
            self._deliver_telegram(msg, kb)
        except Exception as e:  # noqa: BLE001
            print(f"rivendell[{self.name}]: done ping failed for {request_id}: {e}")

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
        with self._send_lock:    # TEST LINK sends from an HTTP thread
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
                if self._reattach(item):
                    continue
                self._apply_policy(self._enqueue("impl", item["id"], item.get("repositoryFullName"),
                                                 batch=_batch_of(item.get("batch"))))
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
                 step: "str | None" = None, batch: "dict | None" = None) -> "str | None":
        """Hold a request PENDING for the operator, deduped per _seen. It adds
        the row and nothing more — running (or auto-accepting, or pinging
        Telegram, or acking) is _apply_policy's job, kept separate so the
        dedup/parse tests stay hermetic; the one exception is re-acking a
        duplicate that is still pending (see below). Returns the new key, or
        None if it was a duplicate.
        `step` tells a todolist's two steps apart ("recommendations" /
        "todolist"); None when the sender did not say (an older rivendell-api).
        `batch` is the start-work batch this request belongs to (_batch_of),
        None for a task on its own."""
        key = f"{kind}:{request_id}"
        with self._seen_lock:
            dup = key in self._seen
            self._seen.add(key)
        if dup:
            # Rivendell re-sends a job until it hears an ack, so a duplicate
            # of one still waiting here means our ack was lost: say it again.
            # A duplicate of a running/finished one is just noise.
            with self._q_lock:
                waiting = key in self._pending
            if waiting:
                self._ack(key, "queued")
            return None
        now = time.time()
        self.last_event_at = now
        with self._q_lock:
            self._pending[key] = {
                "key": key, "kind": kind, "request_id": request_id,
                "slug": slug, "step": step, "batch": batch, "created_at": now,
            }
        return key

    def _apply_policy(self, key: "str | None") -> None:
        """Decide what happens to a just-queued request. The first request into an
        idle queue (nothing else pending, nothing running) is auto-accepted so a
        lone request never waits on a click; anything behind running or pending
        work is left for the operator and pushed to Telegram with Approve/Dismiss
        buttons. Either way Rivendell is told (ack "received" / "queued"), which
        stops its re-sends. A no-op on None (a duplicate _enqueue dropped).

        An implementation for a repo with no local checkout is dropped instead,
        and refused ("no-checkout"): rivendell-api then asks the requester
        whether another bridge may run it, rather than it being claimed here
        only to FAIL. The refusal forgets the key, so the re-send after a "keep
        waiting" goes through this policy again (and finds a repo cloned since)."""
        if key is None:
            return
        with self._q_lock:
            item = self._pending.get(key, {})
        if item.get("kind") == "impl" and self._find_checkout(item["slug"]) is None:
            with self._q_lock:
                self._pending.pop(key, None)
            rid = item["request_id"]
            print(f"rivendell[{self.name}]: implementation {rid} refused: no "
                  f"local checkout for {item['slug']!r} under {config.BASE_PATH}")
            if not self._refuse("impl", rid, "no-checkout"):
                # An older rivendell-api (no refuse): pass it on the old way.
                # ponytail: the key stays in _seen on this path, so a repo
                # cloned later is only picked up after a bridge restart; the
                # old API's catch-up keeps listing passed jobs, and forgetting
                # would rescan BASE_PATH for them on every reconnect.
                try:
                    self._api(f"/plugin/implementation-requests/{rid}/pass", {})
                except Exception as e:  # noqa: BLE001 — an even older API has no pass
                    print(f"rivendell[{self.name}]: pass failed for {rid}: {e}")
            return
        with self._q_lock:
            idle = len(self._pending) == 1 and self._active_runs == 0
        if idle:
            self._ack(key, "received")
            self.accept(key)            # auto-accept: run it now, no Telegram ping
        else:
            self._ack(key, "queued")
            self._notify_queued(key)    # held for a decision — ping Telegram

    def _ack(self, key: str, state: str) -> None:
        """Tell Rivendell a job arrived: "received" (about to start) or "queued"
        (held for the operator). Rivendell re-sends the event until it hears
        one. Best-effort and off-thread — the listener must not stall on HTTP,
        and an older rivendell-api 404s it (only logged)."""
        kind, _, request_id = key.partition(":")
        path = f"/plugin/{self._KIND_PATH.get(kind, 'review-requests')}/{request_id}/ack"
        threading.Thread(target=self._post_ack, args=(path, state),
                         name=f"rivendell-ack-{self.id}", daemon=True).start()

    def _post_ack(self, path: str, state: str) -> None:
        try:
            self._api(path, {"state": state})
        except Exception as e:  # noqa: BLE001 — an ack is best-effort
            print(f"rivendell[{self.name}]: ack {state} failed ({path}): {e}")

    def _refuse(self, kind: str, request_id: str, reason: str) -> bool:
        """Refuse a job ("no-checkout" / "dismissed"): Rivendell then asks its
        requester whether another bridge may run it, keep waiting, or cancel.
        Returns False only when the endpoint is missing (404: an older
        rivendell-api) so the caller falls back to the old path; any other
        failure is logged and counts as done (a 409 is a job not ours, or
        finished). The key is forgotten from _seen either way, so the re-send
        after "keep waiting" — or a catch-up still listing a refusal that
        didn't land — is handled as a new job."""
        path = f"/plugin/{self._KIND_PATH.get(kind, 'review-requests')}/{request_id}/refuse"
        try:
            self._api(path, {"reason": reason})
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            print(f"rivendell[{self.name}]: refuse failed for {request_id}: {e}")
        except Exception as e:  # noqa: BLE001 — best-effort, see docstring
            print(f"rivendell[{self.name}]: refuse failed for {request_id}: {e}")
        with self._seen_lock:
            self._seen.discard(f"{kind}:{request_id}")
        return True

    def _handle_message(self, raw: bytes) -> "str | None":
        """Parse and route one websocket frame into the queue (pure enqueue —
        _listen applies the accept/notify policy to the key returned). Returns the
        newly queued key, or None if the frame was noise or a duplicate."""
        try:
            obj = json.loads(raw.decode())
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if obj.get("type") == "hello":
            self.features = frozenset(str(f) for f in obj.get("features") or () if f)
            print(f"rivendell[{self.name}]: speaks {sorted(self.features) or 'nothing new'}")
            return None
        if obj.get("type") == "job-answer" and obj.get("requestId"):
            self._rivendell_answer(obj)
            return None
        if obj.get("type") == "ping-request" and obj.get("requestId"):
            # SEND TEST JOB's echo: answered here, no Claude, off the listener.
            threading.Thread(target=self._post_pong, args=(obj["requestId"],),
                             name=f"rivendell-pong-{self.id}", daemon=True).start()
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
            return self._enqueue("impl", obj["requestId"], repo.get("fullName"),
                                 batch=_batch_of(obj.get("batch")))
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
                    self.attempt += 1
                    self.retry_at = time.time() + backoff
                    self._set_status("error", str(e))
                    print(f"rivendell[{self.name}]: connect failed ({e}); "
                          f"retrying in {backoff:.0f}s")
                    self._stop.wait(backoff)
                    backoff = min(backoff * 2, _BACKOFF_MAX)
                continue

            self._sock = sock
            backoff = _BACKOFF_MIN
            self.features = frozenset()     # this connection hasn't said hello yet
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
                        # A timed-out read poisons the SocketIO under rfile for
                        # good (every later read: "cannot read from timed out
                        # object"), which used to drop this healthy connection
                        # and redial every quiet interval. So read on through a
                        # fresh file over the same socket. Safe at a frame
                        # boundary: the buffered reader only goes to the socket
                        # once its buffer is drained, so the timeout hit the
                        # wait for a new frame and nothing buffered is lost.
                        # ponytail: a peer stalling a whole interval MID-frame
                        # loses the partial frame's bytes and desyncs the
                        # stream; garbage frames then don't reset `missed`, so
                        # the dead-peer check redials within a few intervals —
                        # a reconnect, not a wedge. Tracking partial reads
                        # would need an unbuffered reader; not worth it.
                        rfile.close()
                        rfile = sock.makefile("rb")
                        missed += 1
                        if missed > _MAX_MISSED_PONGS:
                            raise ConnectionError("peer stopped answering pings")
                        # A whole quiet interval with no close: the gateway took
                        # the token, so the link has proven itself.
                        self._recovered()
                        self._send(sock, b"", wsutil.OP_PING)
                        continue
                    if frame is None:
                        raise ConnectionError("connection closed by peer")
                    missed = 0
                    opcode, payload = frame
                    if opcode != wsutil.OP_CLOSE:
                        self._recovered()       # anything but a close proves the link
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
                    elif opcode == wsutil.OP_PONG:
                        waiter = self._pongs.get(payload)    # TEST LINK's nonce
                        if waiter is not None:
                            waiter.set()
                    # Anything else: arrival already reset `missed`.
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
        """Block until the run is over (or the wait times out). -> (ok, text).
        Over means the child has exited: the first `result` event is not the end,
        because claude -p keeps the process alive while a background subagent
        finishes and then wakes the model again (runner.py, the assistant branch).
        The runner's finally sets `job.exited` once the slot is free; a job
        without that flag (a stub) is waited on by status, as before.
        Time the run spends held on a question (or an approval) doesn't count: a
        person is deciding, and their time is not the run's — the rule the hang
        watchdog already applies (runner._watchdog), here for the kind's wall
        clock, which would otherwise fail a run while you were answering it.
        ponytail: the pause is capped at _HELD_MAX (24 h) summed over the run's
        questions. Past it the run is interrupted and fails ("nobody answered
        in 24h"), so an abandoned ask can't hold this instance's queue
        (_active_runs) forever. One cap for every kind; per kind if 24 h is
        ever wrong for one."""
        deadline = time.time() + timeout
        held = 0.0                    # time spent waiting on a person, all questions
        exited = getattr(job, "exited", None)

        def over() -> bool:
            return exited.is_set() if exited is not None else job.status != "running"

        while not over() and time.time() < deadline:
            t0 = time.time()
            if self._stop.wait(_POLL_INTERVAL):
                break
            if getattr(job, "pending", None):
                waited = time.time() - t0
                held += waited
                deadline += waited
                if held > _HELD_MAX:
                    job.interrupt()
                    return False, f"nobody answered in {_HELD_MAX / 3600:g}h"
        if not over():
            job.interrupt()
            return False, f"run timed out after {timeout}s"
        if getattr(job, "timed_out", False):
            # The watchdog killed it as hung. An interim result may have made
            # it read "done"; that text is not the run's answer.
            limit = getattr(job, "hang_timeout", None) or config.RUN_TIMEOUT
            return False, f"run killed after {limit}s of silence"
        if job.status == "done":
            text = job.result or "".join(job.texts)
            if text.strip():
                return True, text
            return False, "run finished without producing any result text"
        return False, job.error_msg or job.result or "run errored"

    def _new_session(self, workdir: str) -> str:
        """A fresh store session in `workdir` for one autonomous run. Pre-created:
        ensure_session with an unknown id would silently fall back to the
        project's LATEST session and resume the previous run."""
        from bridge import store                 # local import: heavy module
        from bridge.browser import rel
        session = store.create_session(
            config.DASH_CHAT_ID, rel(workdir), session_id=uuid.uuid4().hex,
            origin=self.origin, cwd=workdir, permission_mode="bypassPermissions")
        return session["id"]

    def _start_run(self, prompt: str, workdir: str, hang_timeout: "float | None" = None):
        """One autonomous Claude run in `workdir` through the normal runner.
        `hang_timeout` is the silence the watchdog allows it (the kind's own
        timeout for a review or an implementation). Returns the job, or None if
        a run could not be started."""
        from bridge import runner                # local import: heavy module
        return runner.start_streaming_job(
            config.DASH_CHAT_ID, prompt, [], project=workdir,
            model=self.model, permission_mode="bypassPermissions",
            session_id=self._new_session(workdir), origin=self.origin,
            hang_timeout=hang_timeout)

    def _run_review(self, request_id: str, slug: "str | None") -> None:
        resp = self._claim("review-requests", request_id)
        if resp is None:
            return
        prompt = resp["prompt"]

        # Reviews degrade gracefully outside the repo (the prompt names the PR),
        # so an unknown slug falls back to the configured workdir.
        workdir = self._find_checkout(slug) or self._workdir()
        print(f"rivendell[{self.name}]: review {request_id} running in {workdir}")
        job = self._start_run(prompt, workdir, hang_timeout=self.inst.get("review_timeout", 3600))
        if job is None:  # can't happen for a fresh session; never hang the queue
            self._post_result("review-requests", request_id, False,
                              "could not start a Claude run (session busy)")
            return

        self._track(request_id, "review", slug, job.store_session_id, label=None, link=None)
        try:
            ok, text = self._wait_job(job, self.inst.get("review_timeout", 3600))
        finally:
            self._untrack(request_id)
        print(f"rivendell[{self.name}]: review {request_id} "
              f"{'completed' if ok else 'failed'}")
        self._post_result("review-requests", request_id, ok, text)

    def _run_implementation(self, request_id: str, slug: "str | None") -> None:
        resp = self._claim("implementation-requests", request_id)
        if resp is None:
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

        steps = resp.get("steps") or []
        if steps:
            self._run_batch_queue(request_id, resp, steps, workdir)
            return

        print(f"rivendell[{self.name}]: implementation {request_id} "
              f"running in {workdir}")
        job = self._start_run(prompt, workdir, hang_timeout=self.inst.get("impl_timeout", 10800))
        if job is None:  # can't happen for a fresh session; never hang the queue
            self._post_result("implementation-requests", request_id, False,
                              "could not start a Claude run (session busy)")
            return

        batch = resp.get("batch") or {}
        self._track(request_id, "impl", slug, job.store_session_id,
                    label=batch.get("name"), link=batch.get("url"))
        try:
            ok, text = self._wait_job(job, self.inst.get("impl_timeout", 10800))
        finally:
            self._untrack(request_id)
        print(f"rivendell[{self.name}]: implementation {request_id} "
              f"{'completed' if ok else 'failed'}")
        self._post_result("implementation-requests", request_id, ok, text)

    def _run_batch_queue(self, request_id: str, resp: dict, steps: list, workdir: str) -> None:
        """Queue mode: one queued turn per step in a fresh session, in order, and
        one result at the end. The steps are the composer queue's own rows —
        pausable, reorderable, persisted — tagged `ref` so this worker finds them
        again after a restart (_reattach). COMPLETED carries the last turn's
        answer, the closing step's summary; a failed turn drops the rest and
        lands FAILED."""
        from bridge import queue_manager
        batch = resp.get("batch") or {}
        ref = f"{self.id}:{request_id}"
        sid = self._new_session(workdir)
        q = queue_manager.get()
        # Listed before its turns exist: no queue row without its run.
        self._track(request_id, "impl", resp.get("repositoryFullName"), sid,
                    label=batch.get("name"), link=batch.get("url"))
        try:
            for i, step in enumerate(steps):
                name = step.get("name") or f"step {i + 1}"
                q.enqueue(sid, text=name, prompt=step["prompt"], images=[], model=self.model,
                          effort=None, permission_mode="bypassPermissions", width=0, sel=[],
                          surface="rivendell", chat_id=config.DASH_CHAT_ID, project=workdir,
                          label=f"{name} · {i + 1}/{len(steps)}", link=step.get("url"), ref=ref)
            print(f"rivendell[{self.name}]: implementation {request_id} queued as "
                  f"{len(steps)} turns in session {sid}")
            ok, text = self._wait_queue(sid, ref, self.inst.get("impl_timeout", 10800))
        finally:
            self._untrack(request_id)
        if ok is None:
            print(f"rivendell[{self.name}]: implementation {request_id}: {text}, "
                  f"its turns stay in session {sid}")
            return
        print(f"rivendell[{self.name}]: implementation {request_id} "
              f"{'completed' if ok else 'failed'}")
        self._post_result("implementation-requests", request_id, ok, text)

    def _wait_queue(self, sid: str, ref: str, timeout: float) -> tuple:
        """Block until every turn tagged `ref` in session `sid` is over (or the
        wait times out). -> (ok, text): the last turn's answer when all are done;
        the first failed turn's error, with the turns still queued removed; or
        "cancelled on the bridge" when the operator removed them all. A paused
        queue just waits — the operator paused it — until the timeout, which
        cancels the running turn and drops the rest. A stopping worker (a bridge
        restart) gets (None, "bridge stopping") and leaves every turn as it is:
        they persist, the request stays IN_PROGRESS, and _reattach takes the
        batch up again after the restart. Time a turn spends held on a question
        doesn't count, up to _HELD_MAX over the batch (see _wait_job)."""
        from bridge import queue_manager
        q = queue_manager.get()
        deadline = time.time() + timeout
        held = 0.0
        why = f"run timed out after {timeout}s"
        mine = lambda: [it for it in q.snapshot(sid)["items"] if it.get("ref") == ref]  # noqa: E731
        while time.time() < deadline:
            items = mine()
            if not items:
                return False, "cancelled on the bridge"
            failed = next((it for it in items if it["status"] == "failed"), None)
            if failed is not None:
                for it in items:
                    if it["status"] == "queued":
                        q.remove(sid, it["id"])
                return False, failed.get("error") or "a turn failed"
            if all(it["status"] == "done" for it in items):
                text = items[-1].get("result") or ""
                if text.strip():
                    return True, text
                return False, "run finished without producing any result text"
            t0 = time.time()
            if self._stop.wait(_POLL_INTERVAL):
                return None, "bridge stopping"
            if _held(sid):                       # a turn waits on a person (see _wait_job)
                waited = time.time() - t0
                held += waited
                deadline += waited
                if held > _HELD_MAX:
                    why = f"nobody answered in {_HELD_MAX / 3600:g}h"
                    break
        for it in mine():
            if it["status"] == "running":
                q.cancel(sid, it["id"])
            elif it["status"] == "queued":
                q.remove(sid, it["id"])
        return False, why

    def _reattach(self, item: dict) -> bool:
        """A queue-mode batch this bridge was running when it last stopped: its
        turns are still in the queue store (a loaded bucket re-queues what was
        running and advances nothing by itself), so wait on them instead of
        claiming and starting the batch over. Even turns that had all finished
        are re-attached: the result post is what a restart may have cut off."""
        from bridge import queue_manager
        request_id = item["id"]
        ref = f"{self.id}:{request_id}"
        sid = queue_manager.get().find_ref(ref)
        if sid is None:
            return False
        with self._seen_lock:
            # Catch-up lists IN_PROGRESS requests too, so every reconnect lists
            # the batch this process already waits on: _enqueue dedups that.
            if f"impl:{request_id}" in self._seen:
                return False
            self._seen.add(f"impl:{request_id}")
        with self._q_lock:
            self._active_runs += 1
        batch = item.get("batch") or {}
        self._track(request_id, "impl", item.get("repositoryFullName"), sid,
                    label=batch.get("name"), link=batch.get("url"))
        print(f"rivendell[{self.name}]: implementation {request_id} resumes its "
              f"queued turns in session {sid}")
        threading.Thread(target=self._resume_batch_queue, args=(request_id, sid, ref),
                         name=f"rivendell-run-{self.id}", daemon=True).start()
        return True

    def _resume_batch_queue(self, request_id: str, sid: str, ref: str) -> None:
        from bridge import queue_manager
        try:
            # ponytail: resume() also unpauses a queue the operator had paused
            # before the restart; the restart already lost that intent.
            queue_manager.get().resume(sid)
            ok, text = self._wait_queue(sid, ref, self.inst.get("impl_timeout", 10800))
            if ok is None:
                print(f"rivendell[{self.name}]: implementation {request_id}: {text}, "
                      f"its turns stay in session {sid}")
                return
            print(f"rivendell[{self.name}]: implementation {request_id} "
                  f"{'completed' if ok else 'failed'}")
            self._post_result("implementation-requests", request_id, ok, text)
        except Exception as e:  # noqa: BLE001 — worker must outlive any run
            print(f"rivendell[{self.name}]: impl {request_id} crashed: {e}")
            self._post_result("implementation-requests", request_id, False, f"bridge error: {e}")
        finally:
            self._untrack(request_id)
            with self._q_lock:
                self._active_runs = max(0, self._active_runs - 1)
            self._drain()

    def _run_todolist(self, request_id: str, project: "str | None",
                      step: "str | None" = None) -> None:
        """One step of a project todolist — task recommendations (JSON) or the
        prioritized todolist (markdown). No checkout (see _run_in_workdir); the
        answer posts back verbatim and rivendell-api parses it by step."""
        what = "task recommendations" if step == "recommendations" else "todolist"
        self._run_in_workdir(what, "todolist", request_id, project)

    def _run_taskdesc(self, request_id: str, task: "str | None") -> None:
        """An AI task-description generation — no checkout (see _run_in_workdir).
        rivendell-api writes the generated text back onto the Teamwork task
        itself; the bridge only returns it."""
        self._run_in_workdir("task description", "taskdesc", request_id, task)

    def _run_changelog(self, request_id: str, project: "str | None") -> None:
        """A changelog generation from the sources the user picked — no checkout
        (see _run_in_workdir). The markdown returned IS the changelog; rivendell
        keeps it as the generator's history."""
        self._run_in_workdir("changelog", "changelog", request_id, project)

    def _run_in_workdir(self, what: str, kind: str, request_id: str,
                        name: "str | None") -> None:
        """Run a request that needs NO checkout: its whole context is rendered
        into the prompt server-side, read-only in spirit. A claim that names
        the project's repositories runs beside this machine's checkouts of them
        (_project_dir) so it files under that project; anything else runs in
        the worker's workdir. Reviews' timeout governs it. `what` names it in
        the log, `name` is the project/task it is about."""
        kind_path = self._KIND_PATH[kind]
        resp = self._claim(kind_path, request_id)
        if resp is None:
            return
        prompt = resp["prompt"]

        workdir = _project_dir(resp.get("repositories")) or self._workdir()
        print(f"rivendell[{self.name}]: {what} {request_id} "
              f"({name or '?'}) running in {workdir}")
        job = self._start_run(prompt, workdir)
        if job is None:  # can't happen for a fresh session; never hang the queue
            self._post_result(kind_path, request_id, False,
                              "could not start a Claude run (session busy)")
            return

        self._track(request_id, kind, name, job.store_session_id, label=None, link=None)
        try:
            ok, text = self._wait_job(job, self.inst.get("review_timeout", 3600))
        finally:
            self._untrack(request_id)
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
        what = "batch" if item.get("batch") else self._label(item)
        target = (item.get("batch") or {}).get("name") or item.get("slug") or "?"
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
        """Send one ping (a held request, a broken link, a finished job) to the
        bridge owner's chat. Silent when
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
        dashboard's PLUGINS queue renders. Each gains `label` (the batch's name,
        else the request's slug), `link` (the batch's Rivendell page, else None)
        and `mode` (the batch's `queue`/`subagents`, else None) from its batch,
        if any."""
        with self._q_lock:
            items = sorted(self._pending.values(), key=lambda r: r["created_at"])
        out = []
        for r in items:
            batch = r.get("batch") or {}
            out.append({**r, "label": batch.get("name") or r.get("slug"),
                        "link": batch.get("url"), "mode": batch.get("mode")})
        return out

    def _track(self, request_id: str, kind: str, slug: "str | None", session_id: str,
               label: "str | None", link: "str | None") -> None:
        with self._q_lock:
            self._running[request_id] = {
                "instance_id": self.id, "key": f"{kind}:{request_id}", "kind": kind,
                "request_id": request_id, "slug": slug, "label": label or slug,
                "link": link, "session_id": session_id, "created_at": time.time(),
            }
        # Filed for good, not only while it runs: a DONE card opens (and reads its
        # result line from) the session that did the work, after the run and after
        # a restart. Best-effort — a card without its session beats a run that
        # fails over bookkeeping.
        try:
            from bridge import store                 # local import: heavy module
            store.set_ref(session_id, f"{self.id}:{request_id}")
        except Exception as e:  # noqa: BLE001
            print(f"rivendell[{self.name}]: could not file {request_id} "
                  f"under {session_id}: {e}")

    def _untrack(self, request_id: str) -> None:
        with self._q_lock:
            self._running.pop(request_id, None)

    def running_snapshot(self) -> list:
        """The runs in flight, oldest first — the dashboard's RUNNING rows."""
        with self._q_lock:
            rows = sorted(self._running.values(), key=lambda r: r["created_at"])
        return [dict(r) for r in rows]

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
        """Decline one pending request: refuse it ("dismissed"), which hands the
        decision back to its requester (see _do_reject for the older-API
        fallback). Runs off-thread so a slow POST never blocks the HTTP
        handler."""
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
            self._drain()

    def _drain(self) -> None:
        """A run just finished: with nothing else running, start the oldest held
        request. A stale one (another bridge's by now) is refused at claim and
        simply drains on to the next."""
        with self._q_lock:
            if self._active_runs or not self._pending:
                return
            key = next(iter(self._pending))
        self.accept(key)

    def _do_reject(self, item: dict) -> None:
        kind_path = self._KIND_PATH.get(item["kind"], "review-requests")
        request_id = item["request_id"]
        # Refuse, don't fail: the requester decides whether another bridge runs
        # it. Nothing is claimed, so it stays PENDING server-side meanwhile.
        if self._refuse(item["kind"], request_id, "dismissed"):
            print(f"rivendell[{self.name}]: {item['kind']} {request_id} "
                  "dismissed by operator (refused)")
            return
        # An older rivendell-api (no refuse endpoint): there is no reject either,
        # so claim it and POST FAILED — what makes the decision stick there.
        # Claim first: the result endpoint expects a claimed (IN_PROGRESS) request.
        # A refused claim (409) is someone else's request, or finished — leave it.
        # Any other claim failure (older API) is fine — still try to FAIL it.
        try:
            self._fetch_prompt(kind_path, request_id)
        except Exception as e:  # noqa: BLE001 — best-effort claim
            if _refused(e):
                print(f"rivendell[{self.name}]: {request_id} is not ours "
                      f"to reject: {e}")
                return
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
        if self._progress_thread is None or not self._progress_thread.is_alive():
            self._progress_thread = threading.Thread(
                target=self._progress_loop, name=f"rivendell-progress-{self.id}", daemon=True)
            self._progress_thread.start()

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


def running() -> list:
    """The runs in flight across instances, oldest first, for the dashboard's
    QUEUE tab: every accepted run, of every kind, while it runs."""
    with _manager_lock:
        workers = list(_workers.values())
    return [row for w in workers for row in w.running_snapshot()]


def test_link(instance_id: str, job: bool = False) -> "dict | None":
    """TEST LINK (Worker.test_link), or with `job` SEND TEST JOB (Worker.test_job).
    None when the instance has no running worker (switched off or removed)."""
    with _manager_lock:
        w = _workers.get(instance_id)
    if w is None:
        return None
    return w.test_job() if job else w.test_link()


# --- Telegram callback tokens -------------------------------------------------
# A queued-request ping's Approve/Dismiss buttons can't carry (instance_id, key)
# directly: callback_data is capped at 64 bytes and a request id can be a full
# UUID. Each ping mints a short token here mapping back to (instance_id, key);
# the dispatch callback resolves it once (one-shot: a second click on a handled
# ping finds nothing and is reported "already handled").
_tg_tokens: "dict[str, tuple[str, str]]" = {}
_tg_tokens_lock = threading.Lock()


def _batch_of(obj) -> "dict | None":
    """The batch an implementation event or catch-up row carries (rivendell-api
    sends it for a start-work batch; an older one sends nothing): its name,
    mode, Rivendell page and tasks. None for a task on its own."""
    if not isinstance(obj, dict) or not obj.get("name"):
        return None
    return {"id": obj.get("id"), "name": obj["name"], "mode": obj.get("mode"),
            "url": obj.get("url"), "tasks": list(obj.get("tasks") or [])}


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


# --- The dashboard's RIVENDELL tab ---------------------------------------------
# A repo's open tasks, and IMPLEMENT on one. The button is Rivendell's own
# "Implement using AI" pressed from here: the request is created as this token's
# owner, Rivendell sends it back to this bridge over the socket, and
# _apply_policy takes it like any other — auto-run when idle, else held in the
# queue. Nothing here runs anything. Design: docs/superpowers/specs/
# rivendell-tasks-tab.md.

class TasksError(Exception):
    """One line for the RIVENDELL tab, with a `code` the tab turns into a state:
    token_rejected | not_deployed | refused | unreachable | no_instance."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code


def _explain(e: Exception) -> TasksError:
    """What a failed plugin call means to the tab. A 404 is ambiguous: Nest says
    "Cannot GET /…" for a route this rivendell-api doesn't have yet, anything
    else (a task not found) is Rivendell's own words — as is every other 4xx,
    e.g. create()'s "No repository is linked to this task's project."."""
    if not isinstance(e, urllib.error.HTTPError):
        return TasksError("unreachable", f"unreachable: {getattr(e, 'reason', e)}")
    if e.code in (401, 403):
        return TasksError("token_rejected", "Rivendell refused the token")
    try:
        msg = json.loads(e.read().decode() or "{}").get("message")
    except (ValueError, OSError, AttributeError):
        msg = None
    if isinstance(msg, list):            # class-validator answers with a list
        msg = "; ".join(map(str, msg))
    if e.code == 404 and (not msg or str(msg).startswith("Cannot ")):
        return TasksError("not_deployed", "this Rivendell has no task routes yet")
    return TasksError("refused", str(msg or f"HTTP {e.code}"))


def _ask(w: Worker, path: str, payload: "dict | None" = None):
    try:
        return w._api(path, payload)
    except Exception as e:  # noqa: BLE001 — every failure becomes one line
        raise _explain(e) from None


def live_view(job) -> dict:
    """A live run, read off its job (pure: no I/O). `live` is what it is doing
    now — the jobs monitor's own label (Job.activity) —, its todo progress and
    how many steps (tool calls) it has taken; `ask` is the question it is held
    on, or None. Todo progress counts the task tools (claude 2.1.280's -p mode
    has no TodoWrite) and falls back to a TodoWrite list. `ask.simple` marks one
    single-choice question, the only kind whose options can be buttons; a
    richer one is answered in the session's own card."""
    act = job.activity()
    plan = [s for s in list(job.task_status.values()) if s != "deleted"] or [
        t.get("status") for t in job.todos if isinstance(t, dict)]
    ask = None
    for p in list(job.pending):
        qs = p.get("questions") or []
        if p.get("kind") == "question" and qs:
            q = qs[0]
            ask = {"job_id": job.id, "request_id": p["request_id"], "at": p.get("at"),
                   "question": q.get("question") or "",
                   "header": q.get("header") or q.get("question") or "",
                   "options": [o["label"] for o in q.get("options") or []
                               if isinstance(o, dict) and o.get("label")],
                   "simple": len(qs) == 1 and not q.get("multiSelect")}
            break
    return {"live": {"line": act["label"], "steps": act["tools"],
                     "todos": ({"done": plan.count("completed"), "total": len(plan)}
                               if plan else None)},
            "ask": ask}


def _activity(job) -> dict:
    """The run's latest move as the contract names it — action | thought |
    question | response | error — with a short text: what Rivendell's task page
    shows as "now"."""
    if any(p.get("kind") == "question" for p in list(job.pending)):
        return {"kind": "question", "text": "waiting for an answer"}
    for ev in reversed(list(job.events)):
        kind = _ACTIVITY.get(ev.get("type"))
        if kind == "action":
            text = f"{ev.get('name')}: {ev['summary']}" if ev.get("summary") else ev.get("name") or ""
        elif kind == "thought":
            text = "thinking"
        elif kind:
            text = ev.get("text") or ev.get("message") or ""
        else:
            continue
        return {"kind": kind, "text": str(text)[:200]}
    return {"kind": "action", "text": "starting"}


def progress_body(job) -> dict:
    """One run's progress event (spec: Contract → Progress): its state, latest
    activity, todo progress and step count — plus, while it waits on a person,
    the question, with the id an answer must quote (Worker._rivendell_answer)
    and whether its options can be one-tap buttons."""
    v = live_view(job)
    body = {"state": "awaiting_input" if v["ask"] else "running", "activity": _activity(job),
            "todos": v["live"]["todos"], "step": v["live"]["steps"]}
    if v["ask"]:
        a = v["ask"]
        # Clipped to Rivendell's bounds on a progress question: anything longer
        # is a 400 for the whole beat.
        body["question"] = {"id": a["request_id"], "text": a["question"][:2000],
                            "header": a["header"][:2000],
                            "options": [o[:500] for o in a["options"][:10]],
                            "buttons": a["simple"]}
    return body


def _checks(url: str) -> "str | None":
    """A PR's checks word (github.pr_checks) from the cache, never from `gh` on
    the caller's thread: a tab poll or a result post must not wait on the
    network. A missing or stale entry (_CHECKS_TTL) is refreshed on a thread
    of its own, so the first read of a PR says None and a later poll has it.
    ponytail: a plain dict keyed by PR url, never pruned — a few entries per
    DONE card ever shown; an LRU if a bridge lives through months of PRs."""
    with _checks_lock:
        hit = _checks_cache.get(url)
        stale = hit is None or time.monotonic() - hit[0] >= _CHECKS_TTL
        if stale and url not in _checks_busy:
            _checks_busy.add(url)
            threading.Thread(target=_refresh_checks, args=(url,),
                             name="rivendell-checks", daemon=True).start()
    return hit[1] if hit else None


def _refresh_checks(url: str) -> None:
    from bridge import github                    # local import: subprocess-heavy
    try:
        state = github.pr_checks(url)
    except Exception as e:  # noqa: BLE001 — unknown until the next refresh
        print(f"rivendell: checks for {url} failed: {e}")
        state = None
    with _checks_lock:
        _checks_cache[url] = (time.monotonic(), state)
        _checks_busy.discard(url)


def _result_view(sid: str, checks: bool = True) -> "dict | None":
    """What a finished run came to, read off its session: wall time and token
    spend over its turns (tokens in counts cache reads and writes, as SPEND
    does), the PR its closing summary names (Rivendell's prompts ask for the
    link) with its checks (unless `checks` is False: they have only just
    started when a job ends), and — when its last turn failed — the outcome the
    transcript shows (bridge/outcomes.py). None for a session with no turns."""
    from bridge import github, store             # local import: heavy modules
    last = store.last_turn(sid)
    if last is None:
        return None
    rows = store.turn_metrics(sid)
    tin = sum((r.get("tok_in") or 0) + (r.get("tok_cache_w") or 0) + (r.get("tok_cache_r") or 0)
              for r in rows)
    tout = sum(r.get("tok_out") or 0 for r in rows)
    pr = github.pr_ref(last["result"])
    if pr and checks:
        pr["checks"] = _checks(pr["url"])
    return {"wall_s": sum(r.get("elapsed") or 0 for r in rows),
            "tokens": {"in": tin, "out": tout} if tin or tout else None,
            "pr": pr, "outcome": last["outcome"]}


def _run_view(sid: str) -> dict:
    """What this bridge knows about the run in session `sid`, for its card:
    while it runs, `live` and `ask` (live_view); once over, `result`. Read off
    the live job and the store — nothing here asks Rivendell. Best-effort: a
    card without its extra line beats a tab that fails to list."""
    from bridge import runner                    # local import: heavy module
    try:
        job = runner.live_job(sid)
        return live_view(job) if job is not None else {"result": _result_view(sid)}
    except Exception as e:  # noqa: BLE001
        print(f"rivendell: run view for {sid} failed: {e}")
        return {}


def tasks(slug: str) -> dict:
    """Open tasks of the Rivendell projects that link the repo `slug`, from
    every running instance, merged, plus `links` — each instance's connection
    state, for the tab's chip and banner. Each project and task is tagged with
    its instance (IMPLEMENT goes back to the same one). A task whose request
    ran here carries the session that ran it (filed by _track, so it outlives
    the run and a restart) and `run`, what this bridge knows about that run
    (_run_view). A failing instance is one entry in `errors`, never an
    exception — the rest still list — and its last good answer comes back
    marked `stale`, which the tab dims to "last known". A worker parked on a
    rejected token isn't asked: the tab polls, and re-sending a dead token
    every few seconds is exactly the hammering _listen avoids. Nor is one whose
    link is down (error, retrying): its API most likely is too, and a dead host
    would hold every poll for the HTTP timeout."""
    with _manager_lock:
        running = list(_workers.values())
    out: dict = {"instances": len(running), "projects": [], "tasks": [], "errors": [],
                 "links": [{"instance_id": w.id, "instance": w.name, **w.status_snapshot()}
                           for w in running]}
    for w in running:
        stale = False
        try:
            if w.status == "auth_error":
                raise TasksError("token_rejected", w.status_detail or "token rejected")
            if w.status == "error":
                raise TasksError("unreachable", f"unreachable: {w.status_detail or 'link down'}")
            got = w._last_tasks[slug] = _ask(
                w, "/plugin/tasks?repository=" + quote(slug, safe="/"))
        except TasksError as e:
            out["errors"].append({"instance_id": w.id, "instance": w.name,
                                  "error": e.code, "detail": str(e)})
            got, stale = w._last_tasks.get(slug), True
            if got is None:
                continue
        out["projects"] += [{**p, "instance_id": w.id} for p in got.get("projects") or []]
        rows = got.get("tasks") or []
        try:   # the session each request ran in here, finished or not (Worker._track)
            from bridge import store                 # local import: heavy module
            refs = store.sessions_for_refs([f"{w.id}:{t['implementation']['id']}" for t in rows
                                            if (t.get("implementation") or {}).get("id")])
        except Exception as e:  # noqa: BLE001 — the list must still come back
            print(f"rivendell[{w.name}]: session lookup failed: {e}")
            refs = {}
        for t in rows:
            rid = (t.get("implementation") or {}).get("id")
            sid = (w._running.get(rid) or {}).get("session_id") or refs.get(f"{w.id}:{rid}")
            out["tasks"].append({**t, "instance_id": w.id, "session_id": sid, "stale": stale,
                                 "run": _run_view(sid) if sid else None})
    return out


def implement(instance_id: str, task_id: str) -> dict:
    """Ask the instance to implement `task_id` as this bridge's token owner.
    Returns the new request ({id, status, …}); raises TasksError."""
    with _manager_lock:
        w = _workers.get(instance_id)
    if w is None:
        raise TasksError("no_instance", "that Rivendell connection is off")
    return _ask(w, "/plugin/implementation-requests", {"taskId": task_id})


# Boot entry point (claude_telegram_bridge.py) and the settings save hook both
# call this; reconfigure is the whole mechanism, so start is just its name at
# boot.
# --- NEEDS YOU over Telegram ----------------------------------------------------
# A Rivendell run held on an AskUserQuestion pings the bridge's owner with the
# question's options as buttons; a tap, or a text reply to the ping, answers the
# live run (Job.respond — exactly what the session's QuestionCard sends) and the
# ping is edited to record it (bridge/dispatch.py). A short token stands for
# (session, control request) in callback_data, capped at 64 bytes; the ping's
# message id maps a reply back to the same token. Memory only: a restart ends
# the held run anyway, and its buttons then just say "already answered".
_asks: "dict[str, dict]" = {}            # token -> {sid, rid, header, options}
_ask_msgs: "dict[int, str]" = {}         # ping message id -> token
_asks_lock = threading.Lock()


def ping_question(job, request_id: str, questions: list) -> bool:
    """runner._handle_control_request's hook. A Rivendell run's question — every
    Rivendell job on this bridge, whoever requested it; the bridge's owner is
    the one who answers — pings with its options as buttons instead of the
    generic "Claude needs a question". False, sending nothing, for any other
    session, which keeps the generic ping. Never raises into the run."""
    try:
        from bridge import store                 # local import: heavy module
        sess = store.get_session(job.store_session_id) if job.store_session_id else None
        if not sess or not config.is_plugin_origin(sess.get("origin")):
            return False
        threading.Thread(target=_send_question, args=(job, request_id, questions, sess),
                         name="rivendell-ask", daemon=True).start()
        return True
    except Exception as e:  # noqa: BLE001
        print(f"rivendell: NEEDS YOU ping skipped: {e}")
        return False


def _send_question(job, request_id: str, questions: list, sess: dict) -> None:
    """The NEEDS YOU ping, off the run's stdout thread (Telegram is slow)."""
    if not config.NOTIFY_ENABLE or not config.TOKEN or not config.DASH_CHAT_ID:
        return
    from bridge import telegram                  # local import: telegram pulls state
    q = questions[0] if questions else {}
    simple = len(questions) == 1 and not q.get("multiSelect")
    opts = [o["label"] for o in q.get("options") or []
            if isinstance(o, dict) and o.get("label")] if simple else []
    token = uuid.uuid4().hex[:10]
    with _asks_lock:
        _asks[token] = {"sid": sess["id"], "rid": request_id, "options": opts,
                        "header": q.get("header") or q.get("question") or ""}
    text, kb = _question_message(sess, time.time() - job.started, q, token, opts)
    try:
        sent = telegram.send(config.DASH_CHAT_ID, text, kb)
    except Exception as e:  # noqa: BLE001 — the question still waits in the session
        print(f"rivendell: NEEDS YOU ping failed: {e}")
        return
    if sent and sent.get("message_id"):
        with _asks_lock:
            _ask_msgs[sent["message_id"]] = token


def _question_message(sess: dict, age_s: float, q: dict, token: str, opts: list) -> tuple:
    """The NEEDS YOU ping: what is asking and for how long, the question, and
    its options as buttons (two a row) above OPEN SESSION — the Mini App at that
    session, where any question can be answered. Pure but for panel_kb."""
    from bridge.telegram import panel_kb         # local import: telegram pulls state
    text = (f"◆ Rivendell job needs you\n{sess.get('title') or 'Rivendell job'}\n"
            f"{(sess.get('origin') or 'rivendell').replace(':', ' · ')} · "
            f"running {int(age_s // 60)}m · paused for you\n\n{q.get('question') or ''}")
    rows = [[{"text": o[:60], "callback_data": f"rq:{token}:{i}"}
             for i, o in enumerate(opts) if k <= i < k + 2] for k in range(0, len(opts), 2)]
    rows += (panel_kb(config.DASH_CHAT_ID, sess["id"], sess.get("project"),
                      "Open session ↗") or {}).get("inline_keyboard", [])
    return text, ({"inline_keyboard": rows} if rows else None)


def _done_message(sess: dict, ok: bool, text: str, res: dict) -> tuple:
    """A finished job's ping: done or failed, its title, and one line — where it
    came from, its PR, why it failed, how long it took — over OPEN PR and OPEN
    SESSION. Pure but for panel_kb."""
    from bridge.telegram import panel_kb         # local import: telegram pulls state
    pr = res.get("pr")
    why = None if ok else ((res.get("outcome") or {}).get("label")
                           or (text.strip().splitlines() or ["failed"])[0][:80])
    mins = round((res.get("wall_s") or 0) / 60)
    line = " · ".join(b for b in ((sess.get("origin") or "rivendell").replace(":", " · "),
                                  f"PR #{pr['number']}" if pr else "", why or "",
                                  f"{mins}m" if mins else "") if b)
    head = "✓ Rivendell job done" if ok else "✕ Rivendell job failed"
    row = [{"text": "Open PR ↗", "url": pr["url"]}] if pr else []
    row += [b for r in (panel_kb(config.DASH_CHAT_ID, sess.get("id"), sess.get("project"),
                                 "Open session ↗") or {}).get("inline_keyboard", []) for b in r]
    return (f"{head}\n{sess.get('title') or 'Rivendell job'}\n{line}",
            {"inline_keyboard": [row]} if row else None)


def _answer(token: str, labels: list, notes: str = "") -> "str | None":
    """Answer the held question behind `token` on its live run. What was
    answered, or None when it no longer waits — answered elsewhere, or the run
    ended — so a stale tap can never answer the run's next question."""
    with _asks_lock:
        a = _asks.pop(token, None)
    if a is None:
        return None
    from bridge import runner                    # local import: heavy module
    job = runner.live_job(a["sid"])
    ans = {"header": a["header"], "labels": labels, **({"notes": notes} if notes else {})}
    if job is None or not job.respond(a["rid"], answers=[ans]):
        return None
    return ", ".join(labels) or notes


def answer_option(token: str, i: int) -> "str | None":
    """A tap on the ping's i-th option button (bridge/dispatch.py)."""
    with _asks_lock:
        opts = (_asks.get(token) or {}).get("options") or []
    return _answer(token, [opts[i]]) if 0 <= i < len(opts) else None


def answer_reply(message_id: int, text: str) -> "str | bool | None":
    """A text reply to a NEEDS YOU ping: a free answer to its question, for when
    no option fits or there were none. None when `message_id` isn't one of
    those pings (the reply is an ordinary prompt); False when its question no
    longer waits."""
    with _asks_lock:
        token = _ask_msgs.get(message_id)
    if token is None:
        return None
    return _answer(token, [], notes=text) or False


start = reconfigure


def stop() -> None:
    with _manager_lock:
        for w in _workers.values():
            w.stop()
        _workers.clear()
