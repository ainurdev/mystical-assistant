"""One stdlib ACP (Agent Client Protocol v1) client. It runs one turn of a
non-Claude agent and maps it onto the bridge's own transcript events.

Why hand-rolled: the official Python SDK needs pydantic and asyncio, and the
bridge is stdlib and threads. The subset a bridge needs is small: cc-connect's
Go transport is 236 lines (research: .mystical/docs/research_notes/
Multi-provider support/agent-runtimes.md, Q2).

Deliberately not done:
- fs or terminal client capabilities: the agent uses its own tools.
- elicitation, terminal auth, session/fork, v2.
It pins protocolVersion 1 and ignores update kinds it doesn't know, because
the schema ships a minor version every week or two.

One process per turn, like `claude -p`: spawn, initialize, new/resume/load,
prompt, close. ponytail: a cold start costs 2-13 s per turn and session/load
replays history. Keep one process per session alive if that ever hurts.

Every agent→client request gets an answer, unknown ones -32601, or the turn
hangs (Cursor's blocking cursor/ask_question). Permission requests are the one
kind answered later: each becomes the same pending card a Claude turn shows,
and answer() replies with the option id the agent itself offered.

Frames are split on b"\\n" only (never str.splitlines(): U+2028 inside JSON
broke two other products). Non-JSON stdout lines are skipped.
"""

import difflib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from itertools import count

from bridge import acp_agents, config

DEFER = object()    # on_request's "answered later" (a permission card)
_UNSET = object()   # a request slot the agent never answered
_INIT = {"protocolVersion": 1,
         "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False},
                                "terminal": False},
         "clientInfo": {"name": "mystical-assistant", "title": "Mystical Assistant",
                        "version": "1"}}
_KNOBS = {"model": "model", "mode": "mode", "effort": "thought_level"}   # knob -> category
# Env vars named like a credential. Their values are masked wherever agent text
# lands (events, texts, cards, todos, error rows, the stderr tail): an agent
# that runs `env`, or echoes a rejected key, would otherwise journal it.
# ponytail: exact-match masking; a re-encoded or truncated key slips through.
_SECRET = re.compile(r"KEY|TOKEN|SECRET|PASS", re.I)


def _secrets(env) -> list:
    """The values to mask, longest first, so one containing another goes whole."""
    return sorted({v for k, v in env.items()
                   if _SECRET.search(k) and isinstance(v, str) and len(v) >= 8},
                  key=len, reverse=True)


def _mask(obj, hide):
    """obj with every value in hide replaced by ***, through dicts and lists."""
    if isinstance(obj, str):
        for v in hide:
            obj = obj.replace(v, "***")
        return obj
    if isinstance(obj, list):
        return [_mask(x, hide) for x in obj]
    if isinstance(obj, dict):
        return {k: _mask(x, hide) for k, x in obj.items()}
    return obj


class AcpError(Exception):
    """A JSON-RPC error from the agent, or a request it never answered (-32603)."""

    def __init__(self, code, message):
        super().__init__(str(message))
        self.code = code


class AcpClosed(Exception):
    """The agent's process went away before it answered."""


class Conn:
    """One agent process speaking newline-delimited JSON-RPC 2.0 on stdio.

    Only the reader thread calls on_notify/on_request, and neither may call
    request(): the reader is what delivers its answer.

    The leader is reaped only by kill(), after it has swept the process group:
    until then an exited leader is a zombie whose pid keeps the pgid reserved,
    so the sweep can't reach a recycled one. That also keeps the agent
    "running" while npx's node child holds the stream after npx itself left."""

    def __init__(self, argv, *, env, cwd, on_notify, on_request):
        self.on_notify, self.on_request = on_notify, on_request
        self.stderr_tail = deque(maxlen=40)
        self._hide = _secrets(env)
        self._wlock, self._plock = threading.Lock(), threading.Lock()
        self._klock = threading.Lock()     # a signal and the reap never interleave
        self._pending, self._ids, self._closed = {}, count(1), False
        self.proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     start_new_session=True)
        self._err = threading.Thread(target=self._drain, daemon=True)
        self._err.start()
        threading.Thread(target=self._read, daemon=True).start()

    def request(self, method, params, timeout):
        rid = next(self._ids)
        slot = [threading.Event(), _UNSET, None]
        with self._plock:
            if self._closed:
                raise AcpClosed(method)
            self._pending[rid] = slot
        try:
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            if not slot[0].wait(timeout):
                raise AcpError(-32603, f"{method}: no answer in {timeout}s")
        finally:
            with self._plock:
                self._pending.pop(rid, None)
        _, res, err = slot
        if err is not None:
            raise AcpError(err.get("code"), _mask(str(err.get("message")), self._hide))
        if res is _UNSET:
            raise AcpClosed(method)
        return res if isinstance(res, dict) else {}

    def notify(self, method, params):
        self._quiet({"jsonrpc": "2.0", "method": method, "params": params})

    def reply(self, rid, result=None, error=None):
        self._quiet({"jsonrpc": "2.0", "id": rid,
                     **({"error": error} if error else {"result": result})})

    def poll(self):
        """None until kill() has swept the group and reaped the leader, then
        its exit code. The runner's watchdog loops on this."""
        return self.proc.returncode

    def kill(self):
        """Sweep the process group, then reap the leader: SIGTERM, up to 2 s for
        the leader to exit and its stdout to close, a moment for the rest, then
        SIGKILL for whatever is left. Signals go out only while the leader is
        unreaped (running, or a zombie holding the pgid), so a stale call (a
        Stop timer firing after the turn) can't reach a recycled pgid. Never
        raises: only OS errors from the signal and wait calls are swallowed.
        ponytail: whatever the agent started in its group (a dev server, a
        watcher) ends with the turn. Keep one process per session alive if
        that bites."""
        for sig in (signal.SIGTERM, signal.SIGKILL):
            with self._klock:
                if self.proc.returncode is not None:
                    break
                try:
                    os.killpg(self.proc.pid, sig)
                except OSError:
                    pass
            if sig == signal.SIGTERM:
                _until(self._left, 2)
                time.sleep(0.1)
        with self._klock:
            try:
                self.proc.wait(2)
            except (subprocess.TimeoutExpired, OSError):
                pass
        # A setsid'd child can still hold stdout, so the reader may never see
        # EOF: the stream is over for us anyway, and nothing may wait on it.
        with self._plock:
            self._closed = True
            for slot in self._pending.values():
                slot[0].set()

    def close(self, grace=2.0):
        """Stdin closed, up to `grace` s for the agent to leave (a child still
        holding stdout, npx's node, may be saving its session), then kill()."""
        with self._wlock:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
        _until(self._left, grace)
        self.kill()

    def _left(self):
        """The leader has exited and nothing holds its stdout any more."""
        return self._exited() and self._closed

    def _exited(self):
        """Has the leader exited? Asked with WNOWAIT, so it stays an unreaped
        zombie: its pid, and with it the group's pgid, can't be recycled yet.
        Without os.waitid (macOS before Python 3.13) nothing can ask that
        without reaping, so its stdout closing stands in for its exit. That's
        degraded, not unsafe: a leader that closes stdout first is swept a beat
        early, and the reap still comes only after the sweep."""
        if self.proc.returncode is not None:
            return True
        if not hasattr(os, "waitid"):
            return self._closed
        try:
            return os.waitid(os.P_PID, self.proc.pid,
                             os.WEXITED | os.WNOWAIT | os.WNOHANG) is not None
        except ChildProcessError:
            # Reaped behind our back: its pid is up for grabs, so kill()'s guard
            # must trip. 0 is Popen's own answer to ECHILD.
            if self.proc.returncode is None:
                self.proc.returncode = 0
            return True
        except OSError:
            return self._closed

    def tail(self, n=5):
        if self._closed:
            self._err.join(1)   # a crash's last words land as the pipes close
        return "\n".join(list(self.stderr_tail)[-n:])

    def _send(self, msg):
        data = json.dumps(msg).encode() + b"\n"
        with self._wlock:
            try:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
            except (OSError, ValueError) as e:
                raise AcpClosed(msg.get("method") or "reply") from e

    def _quiet(self, msg):
        try:
            self._send(msg)
        except AcpClosed:
            pass

    def _read(self):
        try:
            for line in self.proc.stdout:   # binary: split on b"\n" only
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue                # a banner or log line, not a frame
                try:
                    self._dispatch(msg)
                except Exception as e:  # noqa: BLE001 - the reader must outlive a bad frame
                    print(f"[acp] dropped a frame: {e!r}", file=sys.stderr)
        finally:
            self.proc.stdout.close()
            with self._plock:
                self._closed = True
                for slot in self._pending.values():
                    slot[0].set()

    def _dispatch(self, msg):
        method, mid = msg.get("method"), msg.get("id")
        if method is None:                  # an answer to one of ours
            with self._plock:
                slot = self._pending.get(mid)
                if slot:
                    slot[1], slot[2] = msg.get("result"), msg.get("error")
                    slot[0].set()
        elif mid is None:                   # a notification
            self.on_notify(method, msg.get("params") or {})
        else:                               # the agent asks us something
            try:
                res = self.on_request(mid, method, msg.get("params") or {})
            except AcpError as e:
                return self.reply(mid, error={"code": e.code, "message": str(e)})
            except Exception as e:  # noqa: BLE001 - every request gets an answer
                return self.reply(mid, error={"code": -32603, "message": repr(e)})
            if res is not DEFER:
                self.reply(mid, result=res)

    def _drain(self):
        try:
            for raw in self.proc.stderr:   # drained, or a chatty agent blocks on a full pipe
                self.stderr_tail.append(_mask(raw.decode("utf-8", "replace").rstrip(),
                                              self._hide))
        finally:
            self.proc.stderr.close()


def _refuse(rid, method, params):
    raise AcpError(-32601, f"not supported: {method}")


def _until(done, timeout):
    end = time.monotonic() + timeout
    while not done() and time.monotonic() < end:
        time.sleep(0.02)


class Turn:
    """One turn's session/update stream mapped onto the job's events, and its
    permission requests turned into pending cards. Text and thinking arrive in
    chunks, so they are buffered until something else happens. Everything it
    hands the job is masked (see _SECRET)."""

    def __init__(self, job, label, hide=()):
        self.job, self.label, self.hide = job, label, hide
        self.text = self.thought = ""
        self.think_t0 = None
        self.tools = {}                  # toolCallId -> (name, t0, kind)
        self.replaying = False           # a session/load replay: already in the transcript
        self.done = False                # the turn is ending: no new card, Stop or switch
        self.sid, self.options, self.modes = None, [], None
        # Guards the buffers, card creation and the done/interrupted flips: the
        # reader, the turn's end and Stop all touch them.
        self._lock = threading.RLock()

    def _add(self, ev):
        self.job.add(_mask(ev, self.hide))

    def flush(self):
        with self._lock:
            thought = _mask(self.thought.strip(), self.hide)
            text = _mask(self.text.strip(), self.hide)
            if thought:
                self.job.add({"type": "thinking",
                              "ms": int((time.time() - self.think_t0) * 1000), "text": thought})
            if text:
                self.job.texts.append(text)
                self.job.add({"type": "text", "text": text})
            self.text = self.thought = ""
            self.think_t0 = None

    def on_notify(self, method, params):
        if method != "session/update" or self.replaying:
            return
        u = params.get("update") or {}
        self.job.boot, self.job.last_at = None, time.time()
        with self._lock:
            self._update(u.get("sessionUpdate"), u)

    def _update(self, kind, u):
        job = self.job
        if kind in ("agent_message_chunk", "agent_thought_chunk"):
            c = u.get("content") or {}
            if c.get("type") != "text":
                return
            if kind == "agent_message_chunk":
                if self.thought:
                    self.flush()
                self.text += c.get("text") or ""
            else:
                if self.text:
                    self.flush()
                self.think_t0 = self.think_t0 or time.time()
                self.thought += c.get("text") or ""
        elif kind == "tool_call":
            self.flush()
            tid, name = u.get("toolCallId"), u.get("title") or u.get("kind") or "tool"
            self.tools[tid] = (name, time.time(), u.get("kind"))
            self._add({"type": "tool", "name": name, "id": tid, "summary": _summary(u)})
            if u.get("status") in ("completed", "failed"):
                self._done(tid, u)
        elif kind == "tool_call_update":
            if u.get("status") in ("completed", "failed"):
                self._done(u.get("toolCallId"), u)
        elif kind == "plan":
            job.todos = _mask([{"content": e.get("content"), "status": e.get("status"),
                                "activeForm": e.get("content")}
                               for e in u.get("entries") or []], self.hide)
        elif kind == "usage_update":
            if isinstance(u.get("used"), int):
                job.ctx_tokens = u["used"]
            cost = u.get("cost") or {}
            if cost.get("currency") == "USD":
                job.cost = cost.get("amount")
        elif kind == "config_option_update":
            self.options = u.get("configOptions") or self.options

    def _done(self, tid, u):
        _, t0, kind = self.tools.pop(tid, (None, 0.0, None))
        ev = {"type": "tool_done", "id": tid}
        ms = int((time.time() - t0) * 1000) if t0 else 0
        if ms > 0:
            ev["ms"] = ms
        if u.get("status") == "failed":
            ev["is_error"] = True
        content = [c for c in u.get("content") or [] if isinstance(c, dict)]
        diff = next((c for c in content if c.get("type") == "diff"), None)
        text = "\n".join(c["content"].get("text") or "" for c in content
                         if c.get("type") == "content" and isinstance(c.get("content"), dict)
                         and c["content"].get("type") == "text")
        if diff:
            if (patch := _patch(diff)):
                ev["patch"] = patch
        elif (kind or u.get("kind")) == "execute":
            ev["output"] = text[-4000:]
        elif text:
            ev["stat"] = f"{len(text.splitlines())} lines"
        self._add(ev)

    def on_request(self, rid, method, params):
        if method != "session/request_permission":
            _refuse(rid, method, params)
        with self._lock:   # vs. Stop and the turn's end: a card is cancelled there or never made
            if self.job.interrupted or self.done:
                return {"outcome": {"outcome": "cancelled"}}
            self.flush()
            tc = params.get("toolCall") or {}
            name = tc.get("title") or self.tools.get(tc.get("toolCallId"), ("tool",))[0]
            card = _mask({"request_id": f"acp-{rid}", "kind": "permission", "tool_name": name,
                          "summary": _summary(tc), "input": tc.get("rawInput") or {}}, self.hide)
            self.job.add_pending({**card, "acp_rpc_id": rid,
                                  "options": params.get("options") or [], "at": time.time()})
            self.job.add({"type": "permission", "request_id": card["request_id"],
                          "tool_name": card["tool_name"], "summary": card["summary"]})
        self.job.awaiting("permission")
        return DEFER

    def apply(self, conn, sid, knob, value, timeout):
        """Set one knob the way this agent offers it: a config option of the
        knob's category, else (mode only) a legacy mode. False, with a log row,
        when it offers neither or refuses."""
        cat = _KNOBS[knob]
        opt = next((o for o in self.options if isinstance(o, dict) and o.get("category") == cat
                    and str(value) in {v["value"] for v in acp_agents._flat(o.get("options"))}),
                   None)
        modes = [m.get("id") for m in (self.modes or {}).get("availableModes") or []]
        try:
            if opt:
                res = conn.request("session/set_config_option",
                                   {"sessionId": sid, "configId": opt["id"], "value": value},
                                   timeout)
                self.options = res.get("configOptions") or self.options
                return True
            if knob == "mode" and value in modes:
                conn.request("session/set_mode", {"sessionId": sid, "modeId": value}, timeout)
                return True
        except AcpClosed:
            return False
        except AcpError:
            pass
        self.job.add({"type": "log", "src": "acp",
                      "text": f"{self.label} doesn't offer {knob} {value!r}; using its default"})
        return False


def _summary(u) -> str:
    raw = u.get("rawInput") if isinstance(u.get("rawInput"), dict) else {}
    s = raw.get("command") or raw.get("cmd")
    if isinstance(s, list):
        s = " ".join(map(str, s))
    if not s:
        s = ", ".join(str(loc["path"]) for loc in (u.get("locations") or [])[:3]
                      if isinstance(loc, dict) and loc.get("path"))
    return str(s or u.get("title") or "")[:200]


def _patch(d) -> list:
    lines = list(difflib.unified_diff((d.get("oldText") or "").splitlines(),
                                      (d.get("newText") or "").splitlines(),
                                      lineterm="", n=3))[2:]   # minus the ---/+++ header
    return lines[:400] + ["…"] if len(lines) > 400 else lines


def pick_option(options, allow):
    """The agent's own option id for allow (or reject): the _once kind first."""
    kinds = ("allow_once", "allow_always") if allow else ("reject_once", "reject_always")
    return next((o.get("optionId") for k in kinds for o in options or []
                 if isinstance(o, dict) and o.get("kind") == k), None)


def _settle(job, card, allow, note=True) -> bool:
    """Answer one card: the agent's option for allow/deny, `cancelled` for
    allow=None or when it offered no fitting option."""
    try:
        job.pending.remove(card)
    except ValueError:
        return False                        # answered meanwhile (a click racing Stop)
    oid = None if allow is None else pick_option(card.get("options"), allow)
    job.conn.reply(card["acp_rpc_id"], {"outcome": {"outcome": "selected", "optionId": oid}
                                        if oid else {"outcome": "cancelled"}})
    if note:
        job.add({"type": "permission_resolved", "request_id": card["request_id"],
                 "behavior": "allow" if allow and oid else "deny"})
    return True


def _cancel_cards(job, note):
    """Answer every waiting card `cancelled`, until none is left: a card made
    meanwhile is answered too, never dropped by a clear."""
    while job.pending:
        for card in list(job.pending):
            _settle(job, card, None, note)


def _fail(job, msg):
    job.error_msg = msg
    job.add({"type": "error", "message": msg})
    job.status = "error"


def _stopped(job):
    job.status = "done"
    job.add({"type": "stopped"})


def _why(e, conn, label, login_hint) -> str:
    """Why a turn or a TEST failed: one line, then the agent's last stderr
    lines, which name most crashes and hangs."""
    if isinstance(e, AcpError) and e.code == -32000:
        return f"{label} needs a login. {login_hint}"
    if conn is None:
        return f"{label} could not start: {e}"
    head = (f"{label} exited" if isinstance(e, AcpClosed)
            else f"{label}: {e}" if isinstance(e, AcpError) else f"{label}: {e!r}")
    tail = conn.tail()
    return f"{head}\n{tail}" if tail else head


def _authenticate(conn, init, method, label):
    """Sign a key account in, every turn (each turn is a new process). The
    method must be one the agent offers: never a fallback to whatever login
    the CLI has (rule 5), so a missing one fails the turn."""
    if not method:
        return
    ids = {m.get("id") for m in init.get("authMethods") or [] if isinstance(m, dict)}
    if method not in ids:
        raise AcpError(None, f"this version doesn't offer API-key sign-in ({method!r}); "
                             "can't run a key account")
    conn.request("authenticate", {"methodId": method}, 60)


def _open(conn, turn, caps, cwd, sid, on_session):
    """Open the turn's session: new, else resume (no replay), else load with
    its replay dropped. Returns (sid, response); the response is None when the
    agent can do neither of the last two."""
    params = {"cwd": cwd, "mcpServers": []}
    if not sid:
        res = conn.request("session/new", params, 120)
        if on_session:
            on_session(res["sessionId"])    # before the prompt: the id survives a crash
        return res["sessionId"], res
    if (caps.get("sessionCapabilities") or {}).get("resume") is not None:
        return sid, conn.request("session/resume", {"sessionId": sid, **params}, 120)
    if not caps.get("loadSession"):
        return sid, None
    turn.replaying = True
    try:
        return sid, conn.request("session/load", {"sessionId": sid, **params}, 120)
    finally:
        turn.replaying = False


def _finish(job, turn, stop):
    turn.flush()
    job.result = job.texts[-1] if job.texts else ""
    if job.interrupted or stop == "cancelled":
        return _stopped(job)
    if stop == "refusal":
        return _fail(job, f"{turn.label} refused this request.")
    if stop in ("max_tokens", "max_turn_requests"):
        job.add({"type": "log", "src": "acp", "text": f"{turn.label} ended the turn early: {stop}"})
    job.status, job.elapsed = "done", int(time.time() - job.started)
    job.add({"type": "result", "result": job.result, "cost": job.cost,
             "elapsed": job.elapsed, "is_error": False})


def run_turn(job, *, argv, env, cwd, label, login_hint, text, agent_session_id, opts,
             on_spawn=None, on_session=None, cache=None, auth_method=None) -> None:
    """One prompt on a fresh agent process. Never raises: the job ends done,
    stopped or error, with every card answered and the process group gone.
    auth_method: the ACP authenticate id for a key account, None to skip."""
    turn = job.turn = Turn(job, label, _secrets(env))
    conn = None
    try:
        conn = job.conn = Conn(argv, env=env, cwd=cwd,
                               on_notify=turn.on_notify, on_request=turn.on_request)
        if on_spawn:
            on_spawn(conn)
        init = conn.request("initialize", _INIT, 120)
        _authenticate(conn, init, auth_method, label)
        sid, res = _open(conn, turn, init.get("agentCapabilities") or {}, cwd,
                         agent_session_id, on_session)
        if res is None:
            return _fail(job, f"{label} can't resume a session, so this one can't continue. "
                              "Start a new session.")
        turn.options, turn.modes = res.get("configOptions") or [], res.get("modes")
        if cache:
            try:
                cache(turn.options, turn.modes, res.get("models"))
            except Exception as e:  # noqa: BLE001 - a picker cache never fails a turn
                print(f"[acp] options cache: {e!r}", file=sys.stderr)
        for knob, key in (("model", "model"), ("mode", "permission_mode"), ("effort", "effort")):
            if opts.get(key):
                turn.apply(conn, sid, knob, opts[key], 30)
        # Live switches (set_options) wait for turn.sid: by now the options are
        # known and this turn's own picks are in, so none overwrites a newer one.
        turn.sid = job.agent_session_id = sid
        # No timeout on the prompt: the watchdog owns hangs. Stop before it: no prompt.
        stop = None if job.interrupted else conn.request(
            "session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": text}]},
            None).get("stopReason")
        _finish(job, turn, stop)
    except Exception as e:  # noqa: BLE001 - never raises
        turn.flush()
        if job.interrupted:                 # Stop's kill, or an agent that errors on cancel
            _stopped(job)
        elif isinstance(e, AcpClosed) and job.timed_out:
            mins = int((getattr(job, "hang_timeout", None) or config.RUN_TIMEOUT) // 60)
            _fail(job, f"⏱️ No output for {mins} min — killed as hung.")
        else:
            _fail(job, _why(e, conn, label, login_hint))
    finally:
        with turn._lock:
            turn.done = True
        if conn:
            _cancel_cards(job, note=False)
            conn.close()
        if job._interrupt_timer:
            job._interrupt_timer.cancel()


def answer(job, request_id, allow: bool) -> bool:
    """A click on a card. False when no such card is waiting."""
    card = next((p for p in list(job.pending) if p.get("request_id") == request_id), None)
    return card is not None and _settle(job, card, bool(allow))


def cancel(job, grace: float) -> bool:
    """Stop: session/cancel first, then every waiting card answered `cancelled`
    (the spec's order). The group is killed if the agent hasn't ended the turn
    within `grace`; that timer starts before any write, so a wedged pipe can't
    keep Stop from landing, and a second Stop reuses it. False once the agent's
    stdout has closed or the turn is ending."""
    conn, turn = job.conn, job.turn
    if conn is None or conn._closed:
        return False
    with turn._lock:
        if turn.done:
            return False
        job.interrupted = True
    timer = job._interrupt_timer
    if not (timer and timer.is_alive()):
        job._interrupt_timer = timer = threading.Timer(grace, conn.kill)
        timer.daemon = True
        timer.start()
    conn.notify("session/cancel", {"sessionId": turn.sid})
    _cancel_cards(job, note=True)
    return True


def set_options(job, model=None, mode=None, effort=None) -> bool:
    """A live switch over the open connection, called from an HTTP thread
    (never the reader). Returns whether the agent ACCEPTED at least one value,
    not whether a request went out: a value it doesn't offer or refuses is a
    log row and False. False too while the session is still opening (its
    options aren't known; the saved pick applies next turn) and once the turn
    is ending."""
    conn, turn = job.conn, job.turn
    if conn is None or conn._closed or turn is None or turn.done or not turn.sid:
        return False
    done = False
    for knob, value in (("model", model), ("mode", mode), ("effort", effort)):
        if value and turn.apply(conn, turn.sid, knob, value, 10):
            done = True
            if knob == "model":
                job.model = value
    return done


def probe(*, argv, env, label, login_hint, timeout=120, auth_method=None) -> dict:
    """TEST: initialize and session/new in a scratch dir, then delete (or
    close) that session when the agent can. What options it offers."""
    tmp = tempfile.mkdtemp(prefix="mystical-acp-probe-")
    conn = None
    try:
        conn = Conn(argv, env=env, cwd=tmp, on_notify=lambda m, p: None, on_request=_refuse)
        init = conn.request("initialize", _INIT, timeout)
        _authenticate(conn, init, auth_method, label)
        res = conn.request("session/new", {"cwd": tmp, "mcpServers": []}, timeout)
        caps = (init.get("agentCapabilities") or {}).get("sessionCapabilities") or {}
        drop = next((m for m in ("delete", "close") if caps.get(m) is not None), None)
        if drop:
            try:
                conn.request(f"session/{drop}", {"sessionId": res.get("sessionId")}, 10)
            except (AcpError, AcpClosed):
                pass
        return {"ok": True, "options": res.get("configOptions") or [],
                "modes": res.get("modes"), "models": res.get("models"),
                "agent": init.get("agentInfo")}
    except Exception as e:  # noqa: BLE001 - a TEST reports, never raises
        return {"ok": False, "error": _why(e, conn, label, login_hint),
                "options": [], "modes": None}
    finally:
        if conn:
            conn.close()
        shutil.rmtree(tmp, ignore_errors=True)
