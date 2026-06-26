"""Claude Code runner.

Two entry points share the same auth/session/permission setup:
  - run_blocking()  -> one-shot JSON result (the bot's plain-text prompt path)
  - start_streaming_job() -> a Job whose events stream in live (the Mini App path)

Each run claims its session's slot in state's per-session run registry, so two
turns never hit the same Claude session at once, but different sessions run
concurrently.
"""

import json
import os
import queue
import shlex
import shutil
import subprocess
import threading
import time
import uuid

from bridge import (config, devserver, machine, native_activity, pubsub, state,
                    store, transcript_jsonl)
from bridge.browser import rel
from bridge.telegram import send, typing


# ---------------------------------------------------------------------------
# Journaling: persist + publish run events OFF the hot stdout loop
# ---------------------------------------------------------------------------

_journal_q: "queue.Queue[tuple[str, str, dict]]" = queue.Queue()
_journal_thread: threading.Thread | None = None
_journal_lock = threading.Lock()


def _journal_one(item: tuple[str, str, dict]) -> None:
    session_id, turn_id, ev = item
    try:
        seq = store.append_event(session_id, turn_id, ev)
        pubsub.publish(f"session:{session_id}", {**ev, "seq": seq})
    except Exception:  # noqa: BLE001  (never let journaling break a run)
        pass


def _journal_worker() -> None:
    while True:
        _journal_one(_journal_q.get())


def _ensure_journal_thread() -> None:
    global _journal_thread
    with _journal_lock:
        if _journal_thread is None:
            _journal_thread = threading.Thread(target=_journal_worker, daemon=True)
            _journal_thread.start()


def _drain_journal() -> None:
    """Synchronously process any queued journal items (used by tests)."""
    while True:
        try:
            item = _journal_q.get_nowait()
        except queue.Empty:
            return
        _journal_one(item)


def _base_cmd(prompt: str, chat_id: int, *, stream: bool,
              interactive: bool = False, model: str | None = None,
              effort: str | None = None, permission_mode: str | None = None,
              claude_session_id: str | None = None) -> list[str]:
    """Build the `claude` argv.

    interactive=True (Mini App chat) drives Claude over the stream-json control
    protocol: the prompt is delivered on stdin (not as an arg), permissions are
    routed back to us via `--permission-prompt-tool stdio`, and we run in an
    asking permission mode so tool use surfaces Allow/Deny cards. The bot's
    plain-text path stays non-interactive and keeps EXTRA_CLAUDE_ARGS.

    model/effort (interactive only) map to `--model`/`--effort`; the server
    validates them before they reach here.
    """
    fmt = "stream-json" if stream else "json"
    cmd = ["claude", "-p"]
    if not interactive:
        cmd.append(prompt)  # text input as an arg
    cmd += ["--output-format", fmt]
    if stream:
        cmd.append("--verbose")  # required with stream-json in -p mode
    if interactive:
        cmd += ["--input-format", "stream-json",
                "--permission-mode", permission_mode or config.MINIAPP_PERMISSION_MODE,
                "--permission-prompt-tool", "stdio"]
    if model:
        cmd += ["--model", model]
    if effort:
        cmd += ["--effort", effort]
    if claude_session_id:
        cmd += ["--resume", claude_session_id]
    log_note = (
        "If a dev server was started for this project from the bridge, its output "
        f"is logged to {devserver.DEV_LOG_REL} in the project root — read that file "
        "(e.g. tail it) to inspect dev-server logs.")
    extra = config.ASK_SYSTEM_PROMPT.strip()
    cmd += ["--append-system-prompt", f"{extra}\n\n{log_note}" if extra else log_note]
    if not interactive and config.EXTRA_CLAUDE_ARGS.strip():
        cmd += shlex.split(config.EXTRA_CLAUDE_ARGS)
    return cmd


# ---------------------------------------------------------------------------
# Blocking run (Telegram plain-text prompt)
# ---------------------------------------------------------------------------

def run_blocking(chat_id: int, prompt: str, resume_id: str | None = None):
    cmd = _base_cmd(prompt, chat_id, stream=False, claude_session_id=resume_id)
    try:
        proc = subprocess.run(cmd, cwd=state.project_dir(chat_id), capture_output=True,
                              text=True, timeout=config.RUN_TIMEOUT)
    except subprocess.TimeoutExpired:
        return (f"⏱️ Timed out after {config.RUN_TIMEOUT // 60} min.", None, None, True)
    except FileNotFoundError:
        return ("❌ `claude` not found on PATH.", None, None, True)

    if not proc.stdout.strip():
        err = proc.stderr.strip() or f"claude exited {proc.returncode}"
        return (f"❌ No output.\n{err[:1500]}", None, None, True)

    try:
        d = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raw = (proc.stdout or proc.stderr).strip()
        return (raw[:3500], None, None, proc.returncode != 0)

    return (d.get("result", "") or d.get("error", ""),
            d.get("session_id"), d.get("total_cost_usd"), bool(d.get("is_error")))


def handle_task(chat_id: int, prompt: str, session: dict):
    """Runs in a thread; the caller already claimed `session`'s run slot."""
    try:
        typing(chat_id)
        send(chat_id, f"🤖 On it… ({rel(state.project_dir(chat_id))})")
        started = time.time()
        job_id = uuid.uuid4().hex
        store.start_turn(session["id"], job_id, prompt, [])
        result, sid, cost, is_error = run_blocking(
            chat_id, prompt, resume_id=session["claude_session_id"])
        store.append_event(session["id"], job_id,
                           {"type": "result", "result": result, "cost": cost})
        if sid:
            store.set_claude_session_id(session["id"], sid)
        store.finish_turn(job_id, "error" if is_error else "done", cost,
                          int(time.time() - started))
        footer = f"\n\n— {int(time.time() - started)}s"
        if cost is not None:
            footer += f" · ${cost:.4f}"
        send(chat_id, ("⚠️ " if is_error else "") + (result or "(no result)") + footer)
    finally:
        state.release_run(session["id"])


# ---------------------------------------------------------------------------
# Streaming jobs (Mini App)
# ---------------------------------------------------------------------------

INTERRUPT_GRACE = 5.0   # seconds to wait for a graceful interrupt before SIGTERM
INTERRUPT_KILL = 2.0    # seconds after SIGTERM before SIGKILL


class Job:
    def __init__(self, job_id: str, chat_id: int, store_session_id: str | None = None):
        self.id = job_id
        self.chat_id = chat_id
        self.store_session_id = store_session_id  # store session row (journaling target)
        self.resume_id: str | None = None         # claude session id to --resume from
        self.events: list[dict] = []
        self.status = "running"          # running | done | error
        self.result: str | None = None
        self.cost: float | None = None
        self.session_id: str | None = None
        self.started = time.time()
        self.elapsed: int | None = None
        self.proc = None                 # subprocess.Popen, for control responses
        self.pending: list[dict] = []    # unresolved can_use_tool requests
        self.interrupted = False         # user pressed Stop
        self._interrupt_timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self._stdin_lock = threading.Lock()

    def add(self, ev: dict):
        with self._lock:
            self.events.append(ev)
        if self.store_session_id:
            _journal_q.put((self.store_session_id, self.id, ev))

    def add_pending(self, entry: dict):
        with self._lock:
            self.pending.append(entry)

    def clear_pending(self):
        with self._lock:
            self.pending = []

    def _write_stdin(self, obj: dict):
        """Write one JSON line to the live process's stdin (control channel)."""
        proc = self.proc
        if proc is None or proc.stdin is None:
            return
        line = json.dumps(obj) + "\n"
        with self._stdin_lock:
            try:
                proc.stdin.write(line)
                proc.stdin.flush()
            except (BrokenPipeError, ValueError, OSError):
                pass

    def close_stdin(self):
        proc = self.proc
        if proc is None or proc.stdin is None:
            return
        with self._stdin_lock:
            try:
                if not proc.stdin.closed:
                    proc.stdin.close()
            except (BrokenPipeError, ValueError, OSError):
                pass

    def interrupt(self) -> bool:
        """Stop the current turn: ask Claude to interrupt over the control
        channel, then escalate to SIGTERM/SIGKILL if it doesn't exit. The
        session is preserved, so the next message resumes. Returns False if the
        job is not running."""
        proc = self.proc
        if self.status != "running" or proc is None:
            return False
        self.interrupted = True
        self._write_stdin({"type": "control_request",
                           "request_id": uuid.uuid4().hex,
                           "request": {"subtype": "interrupt"}})
        self._interrupt_timer = threading.Timer(INTERRUPT_GRACE, self._escalate)
        self._interrupt_timer.daemon = True
        self._interrupt_timer.start()
        return True

    def _escalate(self):
        proc = self.proc
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
        except (OSError, ValueError):
            pass
        killer = threading.Timer(INTERRUPT_KILL, self._kill_if_alive)
        killer.daemon = True
        killer.start()

    def _kill_if_alive(self):
        proc = self.proc
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except (OSError, ValueError):
                pass

    def respond(self, request_id: str, *, behavior: str = "allow",
                message: str | None = None, answers: list | None = None) -> bool:
        """Answer a pending can_use_tool request. Returns False if unknown."""
        with self._lock:
            entry = next((p for p in self.pending if p["request_id"] == request_id), None)
            if entry is None:
                return False
            self.pending = [p for p in self.pending if p["request_id"] != request_id]

        if entry["kind"] == "question":
            resp = {"behavior": "deny",
                    "message": _format_answers(entry.get("questions", []), answers or [])}
            self.add({"type": "question_answered", "request_id": request_id,
                      "answers": answers or []})
        elif behavior == "allow":
            resp = {"behavior": "allow", "updatedInput": entry.get("input", {})}
            self.add({"type": "permission_resolved", "request_id": request_id,
                      "behavior": "allow"})
        else:
            resp = {"behavior": "deny",
                    "message": message or "The user declined this action."}
            self.add({"type": "permission_resolved", "request_id": request_id,
                      "behavior": "deny"})

        self._write_stdin({"type": "control_response", "response": {
            "subtype": "success", "request_id": request_id, "response": resp}})
        return True

    def snapshot(self, cursor: int) -> dict:
        with self._lock:
            out = {
                "status": self.status,
                "events": self.events[cursor:],
                "next_cursor": len(self.events),
                "pending": list(self.pending),
            }
            if self.status != "running":
                out.update(result=self.result, cost=self.cost,
                           elapsed=self.elapsed, session_id=self.session_id)
            return out

    def activity(self) -> dict:
        """A short 'what is it doing right now' label for the jobs monitor:
        awaiting input, the latest tool call, or thinking — plus a tool count."""
        with self._lock:
            pending = list(self.pending)
            tools = 0
            last_tool = None
            for ev in self.events:
                if ev.get("type") == "tool":
                    tools += 1
                    last_tool = ev
        if pending:
            kinds = {p.get("kind") for p in pending}
            kind = "question" if "question" in kinds else "permission"
            label = "awaiting your answer" if kind == "question" else "awaiting your approval"
            return {"state": "awaiting", "kind": kind, "label": label, "tools": tools}
        if last_tool is not None:
            name = last_tool.get("name", "")
            summary = last_tool.get("summary", "")
            return {"state": "tool",
                    "label": (f"{name}: {summary}" if summary else name) or "working…",
                    "tools": tools}
        return {"state": "thinking", "label": "thinking…", "tools": tools}


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()
_JOBS_MAX = 20


def get_job(job_id: str) -> Job | None:
    with _jobs_lock:
        return _jobs.get(job_id)


def awaiting_input() -> list[dict]:
    """Store-session ids whose live job is blocked on user input, with the kind
    ('question' | 'permission') — drives the 'waiting on you' indicator in the
    session lists. A question takes precedence if both are pending."""
    out: list[dict] = []
    with _jobs_lock:
        for j in _jobs.values():
            if j.status == "running" and j.pending and j.store_session_id:
                kinds = {p.get("kind") for p in j.pending}
                out.append({"session_id": j.store_session_id,
                            "kind": "question" if "question" in kinds else "permission"})
    return out


def running_jobs(chat_id: int) -> list[dict]:
    """Rich detail for this chat's live streaming (bridge) jobs — powers the
    background-jobs monitor. External VS Code/terminal sessions come separately
    from machine.list_running()."""
    with _jobs_lock:
        jobs = [j for j in _jobs.values()
                if j.chat_id == chat_id and j.status == "running"]
    out = []
    for j in jobs:
        sid = j.store_session_id
        sess = store.get_session(sid) if sid else None
        out.append({
            "session_id": sid,
            "job_id": j.id,
            "project": sess["project"] if sess else None,
            "title": (sess["title"] if sess else None),
            "started": j.started,
            "activity": j.activity(),
        })
    out.sort(key=lambda d: d["started"] or 0, reverse=True)
    return out


# A native (VS Code/terminal) session that isn't writing *right now* but whose
# transcript was touched within this window shows as LIVE — your current working
# session, briefly paused (thinking, a long tool, reading) — instead of flat IDLE.
# native_activity flags the tighter "writing now" → working state.
_LIVE_WINDOW = 90.0


def _build_status(bridge_running: list, awaiting: list, jobs: list,
                  external: list, native_snap: dict) -> dict:
    """Merge bridge + native liveness into one {session_id: {state, kind, source,
    label}} map — the single status contract both web surfaces render from. State
    is 'awaiting' | 'working' | 'live' | 'idle'; bridge sessions are awaiting/
    working, native (VS Code/terminal) sessions working/live/idle. External rows
    are annotated in place with their `state` for the jobs monitor."""
    awaiting_map = {a["session_id"]: a.get("kind") for a in awaiting}
    job_label = {j["session_id"]: (j.get("activity") or {}).get("label")
                 for j in jobs if j.get("session_id")}
    status: dict[str, dict] = {}
    for sid in bridge_running:
        if sid in awaiting_map:
            kind = awaiting_map[sid]
            label = "awaiting your answer" if kind == "question" else "awaiting your approval"
            status[sid] = {"state": "awaiting", "kind": kind,
                           "source": "bridge", "label": label}
        else:
            status[sid] = {"state": "working", "kind": None, "source": "bridge",
                           "label": job_label.get(sid) or "working…"}
    now = time.time()
    for row in external:
        sid = row.get("session_id")
        st = native_snap.get(sid) if sid else None
        if st and st["state"] == "working":
            row["state"] = "working"
            if sid and sid not in status:
                status[sid] = {"state": "working", "kind": None, "source": "native",
                               "label": st.get("label") or "working…"}
        elif sid and (now - (row.get("last_active") or 0)) < _LIVE_WINDOW:
            row["state"] = "live"
            if sid not in status:
                status[sid] = {"state": "live", "kind": None, "source": "native",
                               "label": "active"}
        else:
            row["state"] = "idle"
    return status


def running_snapshot(chat_id: int) -> dict:
    """The full /running payload: external sessions + bridge jobs + bridge-running
    ids + awaiting list + the unified status map. Both servers return this verbatim
    so the dashboard and Mini App show identical per-session status."""
    external = machine.list_running()
    bridge_running = store.running_session_ids(chat_id)
    awaiting = awaiting_input()
    jobs = running_jobs(chat_id)
    status = _build_status(bridge_running, awaiting, jobs, external,
                           native_activity.snapshot())
    return {"external": external, "bridge_running": bridge_running,
            "jobs": jobs, "awaiting": awaiting, "status": status}


def _notify(chat_id: int | None, text: str) -> None:
    """Best-effort Telegram push (never raises into the run loop)."""
    if not config.NOTIFY_ENABLE or not chat_id:
        return
    try:
        send(chat_id, text)
    except Exception:  # noqa: BLE001
        pass


def _session_label(session_id: str | None) -> str:
    sess = store.get_session(session_id) if session_id else None
    if not sess:
        return "your session"
    title = sess.get("title") or sess["id"][:8]
    proj = sess.get("project")
    return f"{title}{f' · {proj}' if proj else ''}"


def notify_awaiting(chat_id: int | None, session_id: str | None, kind: str) -> None:
    """Ping when a streaming run blocks on you (a question or an approval)."""
    what = "a question" if kind == "question" else "your approval"
    link = f"\n{state.miniapp_url}" if state.miniapp_url else ""
    _notify(chat_id, f"❓ Claude needs {what} — {_session_label(session_id)}{link}")


def notify_turn_done(chat_id: int | None, session_id: str | None, is_error: bool) -> None:
    """Ping when a streaming run finishes (or errors), so you can step away."""
    icon, verb = ("⚠️", "hit an error") if is_error else ("✅", "finished")
    _notify(chat_id, f"{icon} Claude {verb} — {_session_label(session_id)}")


def _register(job: Job):
    with _jobs_lock:
        _jobs[job.id] = job
        if len(_jobs) > _JOBS_MAX:
            for old in sorted(_jobs.values(), key=lambda j: j.started)[:-_JOBS_MAX]:
                _jobs.pop(old.id, None)


def _summarize_tool(name: str, inp: dict) -> str:
    if not isinstance(inp, dict):
        return ""
    if name == "Bash":
        return (inp.get("command") or "")[:120]
    for key in ("file_path", "path", "pattern", "url", "query", "command", "prompt"):
        if inp.get(key):
            return str(inp[key])[:120]
    return ""


def _format_answers(questions: list, answers: list) -> str:
    """Turn the user's AskUserQuestion selections into a message Claude reads as
    the tool result (we feed it via a `deny` whose message is the answer)."""
    by_header = {a.get("header"): a.get("labels", []) for a in answers if isinstance(a, dict)}
    parts: list[str] = []
    for q in questions:
        header = q.get("header") or q.get("question") or ""
        labels = by_header.get(header)
        if labels is None and len(answers) == 1 and len(questions) == 1:
            labels = answers[0].get("labels", []) if isinstance(answers[0], dict) else []
        if labels:
            parts.append(f'For "{header}": {", ".join(labels)}')
    if not parts:
        return "The user did not select an option."
    return "The user answered. " + "; ".join(parts)


def _handle_control_request(job: Job, obj: dict):
    """A `can_use_tool` request: queue it as pending and surface a transcript
    event (a permission card, or a question card for AskUserQuestion)."""
    req = obj.get("request", {})
    if req.get("subtype") != "can_use_tool":
        return  # other control subtypes need no response from us
    rid = obj.get("request_id")
    tool = req.get("tool_name", "tool")
    if tool == "AskUserQuestion":
        questions = (req.get("input") or {}).get("questions", [])
        job.add_pending({"request_id": rid, "kind": "question",
                         "tool_name": tool, "questions": questions})
        job.add({"type": "question", "request_id": rid, "questions": questions})
    else:
        summary = _summarize_tool(tool, req.get("input", {}))
        job.add_pending({"request_id": rid, "kind": "permission", "tool_name": tool,
                         "summary": summary, "input": req.get("input", {})})
        job.add({"type": "permission", "request_id": rid,
                 "tool_name": tool, "summary": summary})
    notify_awaiting(job.chat_id, job.store_session_id,
                    "question" if tool == "AskUserQuestion" else "permission")


def _handle_event(job: Job, d: dict):
    t = d.get("type")
    sid = d.get("session_id")
    if sid and sid != job.session_id:
        job.session_id = sid
        # Persist the native session id the moment it's known (the init event),
        # not only at turn end — so a long-running or question-awaiting run is
        # linked to its store row before the native scanner encounters its JSONL.
        # Otherwise the scanner can't dedup and spawns a phantom 'vscode' copy.
        if job.store_session_id:
            store.set_claude_session_id(job.store_session_id, sid)
    if t == "assistant":
        for b in d.get("message", {}).get("content", []):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text":
                txt = (b.get("text") or "").strip()
                if txt:
                    job.add({"type": "text", "text": txt})
            elif b.get("type") == "tool_use":
                name = b.get("name", "tool")
                job.add({"type": "tool", "name": name,
                         "summary": _summarize_tool(name, b.get("input", {}))})
    elif t == "user":
        for b in d.get("message", {}).get("content", []):
            if isinstance(b, dict) and b.get("type") == "tool_result":
                job.add({"type": "tool_done"})
    elif t == "result":
        job.result = d.get("result", "") or d.get("error", "")
        job.cost = d.get("total_cost_usd")
        if d.get("session_id"):
            job.session_id = d["session_id"]
        # An interrupted turn may report is_error; treat it as a clean stop.
        job.status = "error" if (d.get("is_error") and not job.interrupted) else "done"
        job.elapsed = int(time.time() - job.started)
        job.add({"type": "result", "result": job.result,
                 "cost": job.cost, "elapsed": job.elapsed})


def _cleanup_uploads(job_id: str):
    d = os.path.join(config.UPLOAD_DIR, job_id)
    shutil.rmtree(d, ignore_errors=True)


def _watchdog(job: Job, proc) -> None:
    """Kill a run that spends RUN_TIMEOUT actually working. Seconds spent blocked
    on the user (job.pending non-empty) don't accrue, so an unanswered card can't
    time the run out."""
    active = 0.0
    while proc.poll() is None and active < config.RUN_TIMEOUT:
        time.sleep(1.0)
        if not job.pending and not job.interrupted:
            active += 1.0
    if proc.poll() is None and active >= config.RUN_TIMEOUT:
        proc.kill()


def _run_streaming(job: Job, prompt: str, image_paths: list[str], cwd: str,
                   model: str | None = None, effort: str | None = None,
                   permission_mode: str | None = None):
    proc = None
    try:
        full_prompt = prompt
        if image_paths:
            full_prompt = ("The user attached screenshot(s); view them before "
                           "responding: " + ", ".join(image_paths) + "\n\n" + prompt)
        cmd = _base_cmd(full_prompt, job.chat_id, stream=True, interactive=True,
                        model=model, effort=effort, permission_mode=permission_mode,
                        claude_session_id=job.resume_id)
        try:
            proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, bufsize=1)
        except FileNotFoundError:
            job.add({"type": "error", "message": "`claude` not found on PATH."})
            job.status = "error"
            return
        job.proc = proc

        # Watchdog: kill the run if it spends RUN_TIMEOUT *working* — time spent
        # blocked on you (a permission/question card) doesn't count, so a slow
        # human reply never gets Claude killed mid-task.
        threading.Thread(target=_watchdog, args=(job, proc), daemon=True).start()

        # Deliver the prompt on stdin as a stream-json user message.
        job._write_stdin({"type": "user",
                          "message": {"role": "user", "content": full_prompt}})

        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("type") == "control_request":
                _handle_control_request(job, d)
                continue
            _handle_event(job, d)
            if d.get("type") == "result":
                # Turn finished; close stdin so the stream-json process exits
                # (it otherwise stays alive awaiting more input).
                job.close_stdin()
        proc.wait()

        if job.interrupted:
            # Stopped by the user (graceful interrupt or kill): finalize cleanly
            # and mark the turn so the transcript shows it was stopped.
            if job.status == "running":
                job.status = "done"
            job.add({"type": "stopped"})
        elif job.status == "running":
            # No terminal result event — surface stderr / exit code.
            err = (proc.stderr.read() if proc.stderr else "").strip()
            job.add({"type": "error",
                     "message": err[:1500] or f"claude exited {proc.returncode}"})
            job.status = "error"
    except Exception as e:  # noqa: BLE001
        job.add({"type": "error", "message": str(e)})
        job.status = "error"
    finally:
        if job._interrupt_timer:
            job._interrupt_timer.cancel()
        if job.elapsed is None:
            job.elapsed = int(time.time() - job.started)
        if job.store_session_id:
            if job.session_id:
                store.set_claude_session_id(job.store_session_id, job.session_id)
            store.finish_turn(job.id, job.status, job.cost, job.elapsed)
        job.clear_pending()
        job.close_stdin()
        _cleanup_uploads(job.id)
        if job.store_session_id:
            state.release_run(job.store_session_id)
        if not job.interrupted:
            notify_turn_done(job.chat_id, job.store_session_id, job.status == "error")


_FULL_PERM_ORIGINS = {"dashboard", "miniapp"}


def _surface_default_permission(origin: str | None) -> str | None:
    """New sessions from the desktop dashboard / Mini App default to full autonomy."""
    return config.NEW_SESSION_PERMISSION_MODE if origin in _FULL_PERM_ORIGINS else None


def _adopt_native(session: dict, origin: str | None) -> None:
    """Move a session that started in VSCode/terminal under the bridge's store on
    its first continuation: import its JSONL transcript once (so the full prior
    history renders from the store next to new turns), give it the continuing
    surface's permission posture, and mark it bridge-origin. Resume continuity
    (claude_session_id) and cwd are preserved."""
    path = transcript_jsonl.find_transcript(session.get("claude_session_id"))
    if path:
        data = transcript_jsonl.parse_jsonl(path)
        store.import_transcript(session["id"], data["turns"], data["events"])
    if not session.get("permission_mode"):
        store.set_permission_mode(session["id"], _surface_default_permission(origin))
    store.set_origin(session["id"], "bridge")


def _resolve_session(chat_id: int, project_dir: str, *, session_id: str | None,
                     permission_mode: str | None, origin: str | None) -> dict:
    """Just resolve/create the store session row (idempotent, lock-free) so its id
    is known before we claim its run slot."""
    return store.ensure_session(
        chat_id, rel(project_dir), session_id, origin=origin, cwd=project_dir,
        permission_mode=permission_mode or _surface_default_permission(origin))


def _resolve_run_context(chat_id: int, project_dir: str, *, session_id: str | None,
                         permission_mode: str | None, origin: str | None):
    """Resolve the session then its cwd + permission in one shot (the split-free
    path used outside the concurrent run loop, e.g. tests)."""
    session = _resolve_session(chat_id, project_dir, session_id=session_id,
                               permission_mode=permission_mode, origin=origin)
    return _finalize_run_context(session, project_dir,
                                 permission_mode=permission_mode, origin=origin)


def _finalize_run_context(session: dict, project_dir: str, *,
                          permission_mode: str | None, origin: str | None):
    """Once the session's run slot is held, finish resolving the cwd + permission
    to run it with (adopting a native session into the store on first continuation
    — done under the lock so two surfaces can't double-import). Returns
    (session, cwd, permission_mode)."""
    if session.get("origin") in ("vscode", "terminal"):
        _adopt_native(session, origin)
        session = store.get_session(session["id"])
    cwd = session.get("cwd")
    if not cwd and session.get("claude_session_id"):
        path = transcript_jsonl.find_transcript(session["claude_session_id"])
        cwd = transcript_jsonl.recover_cwd(path) if path else None
    cwd = cwd or project_dir
    if not session.get("cwd"):
        store.set_cwd(session["id"], cwd)
    return session, cwd, (permission_mode or session.get("permission_mode"))


def start_streaming_job(chat_id: int, prompt: str, image_paths: list[str],
                        project: str | None = None, job_id: str | None = None,
                        model: str | None = None, effort: str | None = None,
                        permission_mode: str | None = None,
                        session_id: str | None = None,
                        origin: str | None = None) -> Job | None:
    """Acquire the busy lock and start a streaming run. Returns None if busy.

    Resolves (or creates) the store session and runs it in the session's own cwd
    with its own permission posture; --resume continuity comes from that session's
    claude_session_id. `origin` marks where a newly-created session started.

    Claims only THIS session's run slot, so a run in another project/session keeps
    going; returns None only if this very session already has an in-flight turn."""
    project_dir = project or state.project_dir(chat_id)
    session = _resolve_session(chat_id, project_dir, session_id=session_id,
                               permission_mode=permission_mode, origin=origin)
    if not state.acquire_run(session["id"], chat_id):
        return None
    try:
        session, cwd, perm = _finalize_run_context(
            session, project_dir, permission_mode=permission_mode, origin=origin)
        job = Job(job_id or uuid.uuid4().hex, chat_id, session["id"])
        job.resume_id = session["claude_session_id"]
        _register(job)
        store.start_turn(session["id"], job.id, prompt,
                         [os.path.basename(p) for p in image_paths], model=model)
        _ensure_journal_thread()
        threading.Thread(target=_run_streaming,
                         args=(job, prompt, image_paths, cwd, model, effort, perm),
                         daemon=True).start()
        return job
    except BaseException:
        state.release_run(session["id"])
        raise
