"""The run API: another program on this machine hands Mystical a prompt.

A reading app has books to look up, a cron job has a report to write: both want
"run this prompt in that repo and tell me how it went" without owning a Claude
login, a retry policy or a transcript. The bridge already owns all three, so a
run is nothing new: a session row made the way POST /local/sessions makes one,
and a turn started through runner.start_streaming_job, the call the dashboard's
composer makes. What that buys, and why this never spawns `claude` itself: the
session shows in the dashboard like any other (titled "<client>: <title>",
origin "api:<client>"), you can answer its questions, steer it or stop it
there, a usage limit parks it and the fallback ladder moves it to another login
(bridge/limits.py, bridge/ladder.py), a crash is resumed, and a bridge restart
picks the turn back up (bridge/recovery.py).

A run is that session from the prompt until it goes quiet, not one turn. A
turn that dies and is resumed, a limit park, a wait on another session and a
prompt you queue behind it are all still the run; it ends when the session
holds no run slot and nothing has it coming back for SETTLE_S. So this module
watches the session (state.is_running, limits.parked, waits) and never trusts
one Job's ending. The answer is the last turn's result text.

States: queued, running, waiting_for_input (a question or an approval card is
up, or the ladder offered another login and waits for your pick), done, failed,
cancelled. The last three are final: what you send in that session afterwards
is yours and doesn't reopen the run. A turn you stop in the dashboard ends the
run as cancelled, the same as `mystical run-cancel`.

Safety, in the order a request meets it:
  - Loopback only: the routes live on the dashboard server (127.0.0.1, Host
    allow-list), under /local/runs.
  - Its own token, X-Run-Token, on every route, reads too. It is not the
    dashboard token: a program holding it can start, read and cancel runs, and
    cannot answer cards, read other sessions or change settings. It lives with
    the server address in <state dir>/run-api.json (mode 600), which is all the
    CLI reads. The token is kept across restarts, so a client waiting through a
    bridge reload carries on.
  - Directories: a run's cwd must be inside BASE_PATH (or a folder outside it you
    allowed, bridge/roots.py), where every surface can
    show it, and inside a git checkout there (the repos the project browser
    knows). With RUN_API_DIRS set, only those folders and what is under them.
  - A cap: RUN_API_CONCURRENCY runs at once (default 2); the rest wait their
    turn, oldest first, QUEUE_MAX of them at most. A run waiting on you or
    parked on a limit keeps its place: it is still using a login.
  - Permission mode: exactly a dashboard-started session's. The row is created
    with the project's default profile, else NEW_SESSION_PERMISSION_MODE, and
    the caller cannot name a mode or an account.

Model: the one thing about how a run runs that its caller may pick, because the
caller is who knows whether its prompt is a one-line lookup or an afternoon of
work. "model" is an alias (config.MINIAPP_MODELS) or an id the Models API
lists; anything else is refused at submit, not found out when the child dies.
"effort" is one of config.MINIAPP_EFFORTS. A run that names no model gets
RUN_API_MODEL, the lowest by default (config.MODELS_LOW_TO_HIGH[0]); empty
there means the bridge's normal default, the profile's model or the CLI's own.
A named or default model wins over the project profile's. Both are settled at
submit and kept on the run, so a queued run starts with what it was accepted
with; and both are written to the session row, not only passed to the first
turn, so a turn resumed after a crash, a limit or a restart (recovery starts it
with the session's own model) stays on that model. Changing the model in the
dashboard afterwards works as for any session.

Continuing: "session_id" names the session of an earlier run, and the new
run is the next turn in it instead of a fresh session, so a program holding a
conversation (Atlas's book chat) shows in the dashboard as one chat, and
Claude keeps what it read and said. Only a session a run of the same client
made (origin "api:<client>"), in the same cwd, may be continued: the token
must not open your own sessions. One the session is busy with (a live turn,
or another run on it not yet over) is refused with 409, never queued behind.
The Run says "continues": that session id, or null; a caller can read the key
being there at all as "this bridge knows how to continue".

Not built: images, a mode per request, a dashboard panel of runs (the
sessions list already shows them). The prompt gets one line appended saying who sent it and
that nobody may be watching, as an automation's does.

ponytail: runs are JSON beside the database, like automations: KEEP of them,
written on each change of state. A table when someone wants history past that.
ponytail: one polling thread per live run (POLL_S). Fine at a cap of 2; hang
the watch on the runner's turn end if the cap ever grows large.

Stdlib only.
"""

import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import uuid

from bridge import config, state, store

TERMINAL = ("done", "failed", "cancelled")
POLL_S = 1.0  # how often a live run's session is looked at
SETTLE_S = (
    3.0  # quiet this long = over (a resume or a queued prompt starts well inside it)
)
WAIT_MAX = 30.0  # one long poll; a client that wants longer asks again
KEEP = 200  # finished runs remembered
QUEUE_MAX = 50  # runs that may wait for a slot
PROMPT_MAX = 200_000
TEXT_MAX = 200_000  # of a stored answer or error
_CLIENT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,31}$")

_lock = threading.RLock()
_changed = threading.Condition(_lock)
_runs: "dict[str, dict] | None" = None  # id -> run, oldest first
_watching: set = set()
_token: "str | None" = None


class Refused(ValueError):
    """A sentence for the caller, with the HTTP status it goes out under."""

    def __init__(self, msg: str, code: int = 400):
        super().__init__(msg)
        self.code = code


# --- files -------------------------------------------------------------------


def _dir() -> str:
    return os.path.dirname(config.BRIDGE_DB)


def conn_path() -> str:
    return os.path.join(_dir(), "run-api.json")


def _runs_path() -> str:
    return os.path.join(_dir(), "run-api-runs.json")


def _write_private(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def token() -> str:
    """The run token, made on first use and kept across restarts."""
    global _token
    with _lock:
        if _token is None:
            try:
                with open(conn_path(), encoding="utf-8") as f:
                    _token = str(json.load(f).get("token") or "") or None
            except (OSError, ValueError, AttributeError):
                _token = None
            if _token is None:
                _token = secrets.token_urlsafe(32)
                write_conn()
        return _token


def write_conn() -> None:
    """Where the CLI finds this bridge: its address and the token."""
    with _lock:
        _write_private(
            conn_path(),
            {"url": f"http://127.0.0.1:{config.DASH_PORT}", "token": _token or token()},
        )


def authorized(tok: "str | None") -> bool:
    return bool(tok) and hmac.compare_digest(str(tok).encode(), token().encode())


def _load_locked() -> dict:
    global _runs
    if _runs is None:
        try:
            with open(_runs_path(), encoding="utf-8") as f:
                rows = json.load(f)
            _runs = {r["id"]: r for r in rows if isinstance(r, dict) and r.get("id")}
        except (OSError, ValueError, TypeError):
            _runs = {}
    return _runs


def _save_locked() -> None:
    runs = _load_locked()
    over = [r["id"] for r in runs.values() if r["status"] in TERMINAL]
    for rid in over[: max(0, len(over) - KEEP)]:
        del runs[rid]
    try:
        _write_private(_runs_path(), list(runs.values()))
    except OSError as e:
        print(f"[run-api] could not save runs: {e}", file=sys.stderr)


# --- what a caller may ask for -------------------------------------------------


def _roots() -> list:
    raw = str(getattr(config, "RUN_API_DIRS", "") or "")
    return [
        os.path.realpath(os.path.expanduser(p.strip()))
        for p in re.split(r"[,:\n]", raw)
        if p.strip()
    ]


def _in_checkout(real: str) -> bool:
    """Inside a git checkout under BASE_PATH (a `.git` file counts: a worktree)."""
    from bridge import browser
    p = real
    while p != config.BASE_PATH and browser.within_base(p):
        if os.path.exists(os.path.join(p, ".git")):
            return True
        p = os.path.dirname(p)
    return False


def allowed_dir(cwd) -> str:
    """The real path a run may start in, or Refused."""
    if not isinstance(cwd, str) or not os.path.isabs(os.path.expanduser(cwd.strip())):
        raise Refused("cwd must be an absolute path")
    real = os.path.realpath(os.path.expanduser(cwd.strip()))
    if not os.path.isdir(real):
        raise Refused(f"cwd is not a folder: {real}")
    from bridge import browser
    inside = real != config.BASE_PATH and browser.within_base(real)
    roots = _roots()
    if roots:
        ok = inside and any(real == r or real.startswith(r + os.sep) for r in roots)
        why = "it is not under a folder listed in RUN_API_DIRS"
    else:
        ok = inside and _in_checkout(real)
        why = f"it is not inside a git repository under {config.BASE_PATH}"
    if not ok:
        raise Refused(f"runs may not start in {real}: {why}", 403)
    return real


def _known_model(m: str) -> bool:
    """An alias, or an id on the account's live list. While that list hasn't
    loaded (models.py serves the aliases until it has) a full id can't be
    checked, so a claude-* one passes, as it does for the chat pickers."""
    from bridge import models

    if m in config.MINIAPP_MODELS:
        return True
    ids = models.model_ids()
    return m in ids or (m.startswith("claude-") and ids <= set(config.MINIAPP_MODELS))


def _model_effort(body: dict) -> "tuple[str | None, str | None]":
    """The model and effort a run starts with, or Refused. None = unset."""
    model, effort = body.get("model"), body.get("effort")
    if model in (None, ""):
        model = str(getattr(config, "RUN_API_MODEL", "") or "").strip() or None
    elif not isinstance(model, str) or not _known_model(model.strip()):
        raise Refused(
            f"unknown model {str(model)[:80]!r}: use one of "
            f"{', '.join(config.MODELS_LOW_TO_HIGH)}, or a full model id"
        )
    else:
        model = model.strip()
    if effort in (None, ""):
        effort = None
    elif effort not in config.MINIAPP_EFFORTS:
        raise Refused(
            f"unknown effort {str(effort)[:80]!r}: use one of "
            "low, medium, high, xhigh, max"
        )
    return model, effort


def _continuable(sid, client: str, cwd: str) -> "str | None":
    """The session a run continues, or None for a fresh one; Refused when it
    may not be continued (see the module docstring)."""
    if sid in (None, ""):
        return None
    if not isinstance(sid, str) or not re.match(r"^[A-Za-z0-9-]{1,64}$", sid):
        raise Refused("session_id must be the session_id of an earlier run")
    s = store.get_session(sid)
    if not s or s.get("origin") != f"api:{client}":
        raise Refused(f"no session {sid} made by a run of {client}", 404)
    if os.path.realpath(s.get("cwd") or "") != cwd:
        raise Refused(f"session {sid} runs in another folder, not {cwd}")
    if state.is_running(sid):
        raise Refused("that session is busy: a turn is still running in it", 409)
    return sid


def _cap() -> int:
    try:
        return max(1, int(getattr(config, "RUN_API_CONCURRENCY", 2)))
    except (TypeError, ValueError):
        return 2


def _one_line(v, limit: int) -> str:
    return " ".join(str(v or "").split())[:limit]


# --- the shape a caller sees ---------------------------------------------------


def public(run: dict) -> dict:
    """One run as the API and `--json` give it. Documented in the spec: add keys,
    never rename or drop one."""
    sid = run.get("session_id")
    with _lock:
        ahead = None
        if run["status"] == "queued":
            ahead = (
                sum(
                    1
                    for r in _load_locked().values()
                    if r["status"] == "queued" and r["created"] < run["created"]
                )
                + 1
            )
    return {
        "id": run["id"],
        "status": run["status"],
        "detail": run.get("detail") or "",
        "client": run["client"],
        "ref": run.get("ref") or "",
        "title": run["title"],
        "cwd": run["cwd"],
        "model": run.get("model"),
        "effort": run.get("effort"),
        "continues": run.get("continues"),
        "session_id": sid,
        "session_url": f"http://127.0.0.1:{config.DASH_PORT}/?s={sid}" if sid else None,
        "created": run["created"],
        "started": run.get("started"),
        "finished": run.get("finished"),
        "queue_position": ahead,
        "response": run.get("response"),
        "error": run.get("error"),
    }


def _get(rid: str) -> "dict | None":
    with _lock:
        r = _load_locked().get(rid)
        return dict(r) if r else None


def _set(rid: str, **fields) -> None:
    """Change a run that isn't over; a no-op once it is, or when nothing differs."""
    with _lock:
        r = _load_locked().get(rid)
        if (
            not r
            or r["status"] in TERMINAL
            or all(r.get(k) == v for k, v in fields.items())
        ):
            return
        r.update(fields)
        _save_locked()
        _changed.notify_all()


# --- submit, read, wait, cancel --------------------------------------------------


def submit(body: dict) -> dict:
    """Queue a run and start it if a slot is free. Returns it at once."""
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise Refused("prompt is empty")
    if len(prompt) > PROMPT_MAX:
        raise Refused(f"prompt is over {PROMPT_MAX} characters", 413)
    cwd = allowed_dir(body.get("cwd"))
    client = str(body.get("client") or "api").strip().lower()
    if not _CLIENT_RE.match(client):
        raise Refused("client must be 1-32 of a-z, 0-9, dot, dash, underscore")
    title = _one_line(body.get("title"), 60) or _one_line(
        prompt.strip().splitlines()[0], 60
    )
    model, effort = _model_effort(body)
    continues = _continuable(body.get("session_id"), client, cwd)
    run = {
        "id": uuid.uuid4().hex[:12],
        "status": "queued",
        "detail": "",
        "client": client,
        "ref": str(body.get("ref") or "")[:200],
        "title": title,
        "cwd": cwd,
        "model": model,
        "effort": effort,
        "prompt": prompt.strip(),
        "continues": continues,
        "session_id": None,
        "created": time.time(),
        "started": None,
        "finished": None,
        "response": None,
        "error": None,
        "cancel": False,
    }
    with _lock:
        runs = _load_locked()
        if sum(1 for r in runs.values() if r["status"] == "queued") >= QUEUE_MAX:
            raise Refused(f"{QUEUE_MAX} runs are already waiting", 429)
        if continues and any(
            r["status"] not in TERMINAL
            and continues in (r.get("session_id"), r.get("continues"))
            for r in runs.values()
        ):
            raise Refused("that session already has a run that is not over", 409)
        runs[run["id"]] = run
        _save_locked()
    _pump()
    return public(_get(run["id"]))


def get(rid: str, wait: float = 0.0) -> "dict | None":
    """One run; with `wait`, blocks up to that long (WAIT_MAX at most) for it to end."""
    deadline = time.monotonic() + max(0.0, min(float(wait or 0), WAIT_MAX))
    with _changed:
        while True:
            r = _load_locked().get(rid)
            left = deadline - time.monotonic()
            if not r or r["status"] in TERMINAL or left <= 0 or state.shutting_down:
                return public(dict(r)) if r else None
            _changed.wait(min(left, 1.0))


def listed(client: "str | None" = None, limit: int = 50) -> list:
    """Runs, newest first."""
    with _lock:
        rows = [
            dict(r)
            for r in _load_locked().values()
            if not client or r["client"] == client
        ]
    rows.sort(key=lambda r: r["created"], reverse=True)
    return [public(r) for r in rows[: max(1, min(int(limit or 50), KEEP))]]


def cancel(rid: str) -> "dict | None":
    """Stop a run. A queued one never starts; a live one has its turn interrupted
    and reads cancelled once the child is gone. Refused (409) when already over."""
    from bridge import limits, runner, waits

    with _lock:
        r = _load_locked().get(rid)
        if not r:
            return None
        if r["status"] in TERMINAL:
            raise Refused(f"the run is already {r['status']}", 409)
        if r["status"] == "queued":
            _finish_locked(r, "cancelled")
            return public(dict(r))
        r["cancel"] = True
        r["detail"] = "cancelling"
        _save_locked()
        sid = r["session_id"]
    # A park or a wait would bring the session back by itself: both go first.
    limits.cancel(sid)
    waits.drop(sid)
    job = runner.live_job(sid)
    if job is not None:
        job.interrupt()  # a child not up yet ignores this; the watcher asks again
    elif not state.is_running(sid):
        with _lock:
            r = _load_locked().get(rid)
            if r and r["status"] not in TERMINAL:
                _finish_locked(r, "cancelled")
    _pump()
    return public(_get(rid))


def _finish_locked(
    r: dict, status: str, *, response=None, error=None, detail: str = ""
) -> None:
    r.update(
        status=status,
        finished=time.time(),
        detail=detail,
        response=(response or "")[:TEXT_MAX] if status == "done" else None,
        error=(error or "")[:TEXT_MAX] or None if status != "done" else None,
    )
    r.pop("prompt", None)  # it is the session's first turn now; no second copy
    _save_locked()
    _changed.notify_all()


# --- starting --------------------------------------------------------------------


def _note(client: str) -> str:
    return (
        f'\n\n(Sent by the local program "{client}" through Mystical\'s run API. '
        "Nobody may be watching this chat as it runs; your final reply is what "
        "that program gets back.)"
    )


def _start(run: dict) -> "str | None":
    """Create the run's session and start its first turn, as the dashboard would,
    or (continuing) start the next turn in the earlier run's session.
    Returns the session id, or None when the bridge is going down."""
    from bridge import browser, profiles, runner

    origin = f"api:{run['client']}"
    if run.get("continues"):
        sid = run["continues"]
        for field in ("model", "effort"):
            if run.get(field):
                store.set_session_field(sid, field, run[field])
        job = runner.start_streaming_job(
            config.DASH_CHAT_ID,
            run["prompt"] + _note(run["client"]),
            [],
            run["cwd"],
            session_id=sid,
            origin=origin,
            model=run.get("model"),
            effort=run.get("effort"),
            sent_by="mystical:api",
            sent_why=f"{run['client']} continued it through the run API",
        )
        if job is None:
            if state.shutting_down:
                return None
            raise RuntimeError("the session is busy: a turn is running in it")
        return sid
    project = browser.rel(run["cwd"])
    # The dashboard's own rule (POST /local/sessions): the project's default
    # profile decides the mode, else the mode new sessions carry.
    pid = profiles.project_default(project)
    s = store.create_session(
        config.DASH_CHAT_ID,
        project,
        origin=origin,
        cwd=run["cwd"],
        permission_mode=None if pid else config.NEW_SESSION_PERMISSION_MODE,
        profile_id=pid,
    )
    store.rename(
        s["id"], f"{run['client']}: {run['title']}"
    )  # manual: the titler leaves it
    # On the row too: a resumed turn runs with the session's own model.
    for field in ("model", "effort"):
        if run.get(field):
            store.set_session_field(s["id"], field, run[field])
    job = runner.start_streaming_job(
        config.DASH_CHAT_ID,
        run["prompt"] + _note(run["client"]),
        [],
        run["cwd"],
        session_id=s["id"],
        origin=origin,
        model=run.get("model"),
        effort=run.get("effort"),
        sent_by="mystical:api",
        sent_why=f"{run['client']} started it through the run API",
    )
    if job is None:  # shutting down; a fresh session is never busy
        store.delete_session(s["id"])
        return None
    return s["id"]


def _pump() -> None:
    """Start queued runs, oldest first, while slots are free. The start happens
    under the lock, so a run never reads "running" without its session."""
    while not state.shutting_down:
        with _lock:
            runs = _load_locked()
            live = sum(1 for r in runs.values() if r["status"] not in TERMINAL + ("queued",))
            nxt = next((r for r in runs.values() if r["status"] == "queued"), None)
            if nxt is None or live >= _cap():
                return
            try:
                sid = _start(nxt)
            except Exception as e:  # noqa: BLE001 - one bad start must not hold the queue
                print(f"[run-api] {nxt['id']} could not start: {e!r}", file=sys.stderr)
                _finish_locked(nxt, "failed", error=f"could not start: {e}")
                continue
            if sid is None:
                return                      # going down: the next boot starts it
            nxt.update(status="running", started=time.time(), session_id=sid)
            _save_locked()
            _changed.notify_all()
            rid = nxt["id"]
        _watch_in_thread(rid)


# --- watching ----------------------------------------------------------------------


def _live(sid: str) -> "tuple[str, str] | None":
    """What a run's session is doing: (status, detail), or None when it is idle
    with nothing bringing it back."""
    from bridge import limits, runner, waits

    if state.is_running(sid):
        job = runner.live_job(sid)
        pending = list(getattr(job, "pending", None) or [])
        if pending:
            asked = any(p.get("kind") == "question" for p in pending)
            return (
                "waiting_for_input",
                "asked a question" if asked else "needs permission",
            )
        return "running", ""
    p = limits.parked().get(sid)
    if p:
        if p.get("offer"):
            return "waiting_for_input", (
                "hit the usage limit: pick another account in "
                "the dashboard, or it resumes at the reset"
            )
        if p.get("kind") == "limit":
            return (
                "running",
                f"paused on a usage limit until about {limits.when_str(p['at'])}",
            )
        return "running", "retrying after an API error"
    if waits.waiting(sid):
        return "running", "waiting on another session"
    return None


def _outcome(run: dict) -> dict:
    """How the session's last turn ended, as _finish_locked's arguments."""
    from bridge import runner

    sid = run["session_id"]
    job = runner._latest_jobs().get(sid)
    if job is not None:
        if run.get("cancel") or job.interrupted:
            return {
                "status": "cancelled",
                "detail": "" if run.get("cancel") else "stopped in the dashboard",
            }
        if job.timed_out:
            limit = int(job.hang_timeout or config.RUN_TIMEOUT)
            return {"status": "failed", "error": f"killed after {limit}s of silence"}
        if job.status == "done":
            return {
                "status": "done",
                "response": job.result or (job.texts[-1] if job.texts else ""),
            }
        return {
            "status": "failed",
            "error": job.error_msg or job.result or job.refusal or "the run failed",
        }
    # No job in memory: the bridge restarted since, or the job aged out.
    if run.get("cancel"):
        return {"status": "cancelled"}
    t = store.last_turn(sid)
    if t and t["status"] == "done":
        return {"status": "done", "response": t["result"]}
    return {
        "status": "failed",
        "error": (t and t["result"]) or "the run did not finish; open its session",
    }


def _watch(rid: str) -> None:
    """Follow one run's session until it goes quiet, then record how it ended."""
    from bridge import runner

    idle = None
    try:
        while not state.shutting_down:
            run = _get(rid)
            if not run or run["status"] in TERMINAL or not run.get("session_id"):
                return
            sid = run["session_id"]
            now = _live(sid)
            if now:
                idle = None
                if run.get("cancel"):
                    job = runner.live_job(sid)
                    if job is not None and not job.interrupted:
                        job.interrupt()
                else:
                    _set(rid, status=now[0], detail=now[1])
            else:
                idle = idle or time.monotonic()
                if time.monotonic() - idle >= SETTLE_S:
                    with _lock:
                        r = _load_locked().get(rid)
                        if r and r["status"] not in TERMINAL:
                            _finish_locked(r, **_outcome(dict(r)))
                    return
            time.sleep(POLL_S)
    except Exception as e:  # noqa: BLE001 - a watcher that dies would hold its slot forever
        print(f"[run-api] watching {rid} failed: {e!r}", file=sys.stderr)
        with _lock:
            r = _load_locked().get(rid)
            if r and r["status"] not in TERMINAL:
                _finish_locked(
                    r, "failed", error=f"the bridge lost track of this run: {e}"
                )
    finally:
        with _lock:
            _watching.discard(rid)
        _pump()


def _watch_in_thread(rid: str) -> None:
    with _lock:
        if rid in _watching:
            return
        _watching.add(rid)
    threading.Thread(
        target=_watch, args=(rid,), daemon=True, name=f"run-api-{rid}"
    ).start()


def boot() -> None:
    """After recovery and limits.boot: publish the address, pick up the runs a
    restart left live (their turns are already resumed or parked) and start what
    was queued."""
    token()
    write_conn()
    with _lock:
        live = []
        for r in _load_locked().values():
            if r["status"] in TERMINAL or r["status"] == "queued":
                continue
            live.append(r["id"])
    for rid in live:
        _watch_in_thread(rid)
    _pump()


# --- HTTP (bridge/dashboard/server.py hands /local/runs here) ----------------------


def _int(v, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def http(
    method: str, path: str, qs: dict, body: "dict | None", tok: "str | None"
) -> "tuple[dict, int]":
    """Every /local/runs route. -> (json, status)."""
    if not authorized(tok):
        return {
            "error": "unauthorized: send the token from run-api.json as X-Run-Token"
        }, 401
    rest = [p for p in path[len("/local/runs") :].split("/") if p]
    try:
        if method == "GET" and not rest:
            client = (qs.get("client") or [""])[0].strip().lower() or None
            return {"runs": listed(client, _int((qs.get("limit") or [50])[0], 50))}, 200
        if method == "GET" and len(rest) == 1:
            try:
                wait = float((qs.get("wait") or [0])[0])
            except ValueError:
                wait = 0.0
            run = get(rest[0], wait)
            return ({"run": run}, 200) if run else ({"error": "no such run"}, 404)
        if method == "POST" and not rest:
            if not isinstance(body, dict):
                return {"error": "bad json"}, 400
            return {"run": submit(body)}, 202
        if method == "POST" and len(rest) == 2 and rest[1] == "cancel":
            run = cancel(rest[0])
            return ({"run": run}, 200) if run else ({"error": "no such run"}, 404)
    except Refused as e:
        return {"error": str(e)}, e.code
    return {"error": "not found"}, 404
