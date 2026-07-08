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
import sys
import threading
import time
import uuid

from bridge import (config, devserver, git, machine, memory, native_activity,
                    project_config, pubsub, state, store, transcript_jsonl)
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
    except Exception as e:  # noqa: BLE001  (never let journaling break a run)
        print(f"[journal] dropped event for session {session_id}: {e}", file=sys.stderr)


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


_LOG_NOTE = (
    "If a dev server was started for this project from the bridge, its output "
    f"is logged to {devserver.DEV_LOG_REL} in the project root — read that file "
    "(e.g. tail it) to inspect dev-server logs.")
_EDIT_TOOLS = {"Edit", "Write", "MultiEdit"}


def _project_key(chat_id: int, cwd: "str | None") -> str:
    return rel(cwd or state.project_dir(chat_id))


def _branch_for(chat_id: int, cwd: "str | None") -> "str | None":
    return git.current_branch_cached(cwd or state.project_dir(chat_id)) or None


def _memory_pack_for(chat_id: int, cwd: "str | None") -> str:
    """Project+branch memory Context Pack for injection. Best-effort: disabled, an
    'off' project posture, or any failure yields an empty pack (never blocks a turn)."""
    if not config.MEMORY_ENABLE:
        return ""
    try:
        project = _project_key(chat_id, cwd)
        if project_config.memory_mode(project) == "off":
            return ""
        return memory.render_pack(chat_id, project, _branch_for(chat_id, cwd))
    except Exception:  # noqa: BLE001
        return ""


def _compose_system_prompt(pack: str = "") -> str:
    """Stable content first (ASK prompt + dev-log note), then the memory pack —
    which is byte-stable within a session, so the prefix stays cache-eligible."""
    parts = [p for p in (config.ASK_SYSTEM_PROMPT.strip(), _LOG_NOTE, pack.strip()) if p]
    return "\n\n".join(parts)


def _capture_async(chat_id: int, session_id: "str | None", turn_id: str,
                   cwd: "str | None", assistant_text: str, edited_files: list) -> None:
    """Run the post-turn memory extractor off the hot path (fire-and-forget). The
    project's posture gates it: 'off' skips capture, 'auto' keeps without the gate."""
    if not config.MEMORY_ENABLE or not session_id or not (assistant_text or "").strip():
        return
    project = _project_key(chat_id, cwd)
    mode = project_config.memory_mode(project)
    if mode == "off":
        return

    def work():
        try:
            memory.propose(chat_id, session_id, turn_id, project,
                           _branch_for(chat_id, cwd), assistant_text, edited_files,
                           auto=(mode == "auto"))
        except Exception:  # noqa: BLE001
            pass
    threading.Thread(target=work, daemon=True).start()


# ---------------------------------------------------------------------------
# Resolve the `claude` launcher without trusting the ambient PATH
# ---------------------------------------------------------------------------
# The bridge may be started from a context whose PATH omits ~/.local/bin — where
# Claude installs its launcher — e.g. systemd, cron, a non-login shell, or a
# nested agent. There, subprocess(["claude", ...]) raises FileNotFoundError and
# the turn dies with "claude not found on PATH". We resolve to an absolute path
# once (override -> PATH -> known install dirs) and re-resolve only if the cached
# path disappears (e.g. a self-update repointing the symlink).

_CLAUDE_FALLBACKS = (
    "~/.local/bin/claude",
    "~/.claude/local/claude",
)
_claude_bin: str | None = None


def claude_bin() -> str:
    """Absolute path to the `claude` launcher. Falls back to config.CLAUDE_BIN
    verbatim when nothing resolves, so the FileNotFoundError branch below can
    still surface the friendly 'not found on PATH' error."""
    global _claude_bin
    if _claude_bin and os.path.exists(_claude_bin):
        return _claude_bin
    name = config.CLAUDE_BIN
    if os.sep in name:                                   # explicit path override
        _claude_bin = os.path.expanduser(name)
        return _claude_bin
    found = shutil.which(name)
    if not found:
        for cand in _CLAUDE_FALLBACKS:
            cand = os.path.expanduser(cand)
            if os.access(cand, os.X_OK):
                found = cand
                break
    _claude_bin = found or name
    return _claude_bin


def _base_cmd(prompt: str, chat_id: int, *, stream: bool,
              interactive: bool = False, model: str | None = None,
              effort: str | None = None, permission_mode: str | None = None,
              claude_session_id: str | None = None, cwd: str | None = None,
              skip_pack: bool = False) -> list[str]:
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
    cmd = [claude_bin(), "-p"]
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
    pack = "" if skip_pack else _memory_pack_for(chat_id, cwd)
    cmd += ["--append-system-prompt", _compose_system_prompt(pack)]
    if not interactive and config.EXTRA_CLAUDE_ARGS.strip():
        cmd += shlex.split(config.EXTRA_CLAUDE_ARGS)
    return cmd


# ---------------------------------------------------------------------------
# Blocking run (Telegram plain-text prompt)
# ---------------------------------------------------------------------------

def run_blocking(chat_id: int, prompt: str, resume_id: str | None = None,
                 cwd: str | None = None, timeout: int | None = None, *,
                 model: str | None = None, skip_pack: bool = False):
    cmd = _base_cmd(prompt, chat_id, stream=False, claude_session_id=resume_id,
                    cwd=cwd, model=model, skip_pack=skip_pack)
    timeout = timeout or config.RUN_TIMEOUT
    try:
        proc = subprocess.run(cmd, cwd=cwd or state.project_dir(chat_id), capture_output=True,
                              text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return (f"⏱️ Timed out after {timeout // 60} min.", None, None, True)
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
        # Journal (persist + publish) so SSE subscribers see bot-driven turns
        # live, exactly like streaming-path events.
        _journal_one((session["id"], job_id,
                      {"type": "result", "result": result, "cost": cost}))
        if sid:
            store.set_claude_session_id(session["id"], sid)
        if is_error and state.shutting_down:
            return   # restart killed the run: stay 'running' for boot recovery
        store.finish_turn(job_id, "error" if is_error else "done", cost,
                          int(time.time() - started))
        if not is_error:
            _capture_async(chat_id, session["id"], job_id, None, result, [])
        footer = f"\n\n— {int(time.time() - started)}s"
        send(chat_id, ("⚠️ " if is_error else "") + (result or "(no result)") + footer)
        if not is_error:
            from bridge import learning, titler  # local import: runner<->* cycle
            threading.Thread(target=learning.capture_after_turn,
                             args=(chat_id, session, job_id),
                             kwargs={"tool_visibility": False},
                             daemon=True).start()
            threading.Thread(target=titler.generate_after_turn,
                             args=(chat_id, session, job_id),
                             daemon=True).start()
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
        self.timed_out = False           # watchdog killed the run
        self.texts: list[str] = []       # assistant text this turn (memory capture)
        self.edited: list[str] = []      # files edited this turn (Edit/Write/MultiEdit)
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


# ---------------------------------------------------------------------------
# Auto-resume: only the user may stop a turn
# ---------------------------------------------------------------------------
# Two non-user ways a turn dies, two answers:
#   - The bridge is restarting (group SIGINT/SIGKILL takes the Claude child down):
#     leave the turn 'running' so startup recovery (bridge/recovery.py) claims and
#     resumes it on the next boot.
#   - Claude crashed while the bridge stays up (API drop, OOM, CLI failure):
#     resume the session right here with a nudge. Consecutive failures are capped
#     per session — a completed turn resets the cap — so a session whose resume
#     itself keeps dying can't burn tokens in a loop.
# User Stop (job.interrupted) and the RUN_TIMEOUT watchdog (job.timed_out — the
# deliberate runaway-cost brake) are never auto-resumed.

RESUME_NUDGE = (
    "⏮ Your previous turn was cut off by an error — not by the user. "
    "Review your recent transcript and continue exactly where you left off; "
    "finish the task you were doing. Don't start over.")
AUTO_RESUME_MAX = 2                 # consecutive crashed turns before giving up
_resume_fails: dict[str, int] = {}  # session id -> consecutive error-ended turns


def _restart_killed(job: "Job") -> bool:
    """An error end while the bridge is shutting down is the restart killing the
    child, not a real failure — the turn must stay 'running' for boot recovery."""
    return (state.shutting_down and job.status == "error"
            and not job.interrupted and not job.timed_out)


def _maybe_auto_resume(job: "Job", cwd: str, model: str | None,
                       effort: str | None) -> bool:
    """Resume a session whose turn died without the user behind it. Returns True
    when a resume run was started (the caller then skips the error notification)."""
    sid = job.store_session_id
    if not sid:
        return False
    if job.status == "done":
        _resume_fails.pop(sid, None)             # healthy turn resets the cap
        return False
    if job.status != "error" or job.interrupted or job.timed_out:
        return False
    if not config.AUTO_RESUME or state.shutting_down:
        return False                              # shutdown → boot recovery's job
    fails = _resume_fails.get(sid, 0) + 1
    _resume_fails[sid] = fails
    if fails > AUTO_RESUME_MAX:
        return False                              # crash-looping — stay stopped
    sess = store.get_session(sid)
    if not sess or not sess.get("claude_session_id"):
        return False                              # died before init — nothing to resume
    try:
        job2 = start_streaming_job(job.chat_id, RESUME_NUDGE, [], project=cwd,
                                   session_id=sid, model=model, effort=effort)
    except Exception as e:  # noqa: BLE001
        print(f"[auto-resume] failed for {sid}: {e}", file=sys.stderr)
        return False
    if job2 is None:
        return False                              # slot taken (e.g. the queue advanced)
    _notify(job.chat_id,
            f"🔄 The turn was interrupted by an error — resuming {_session_label(sid)}.")
    return True


def _register(job: Job):
    with _jobs_lock:
        _jobs[job.id] = job
        if len(_jobs) > _JOBS_MAX:
            # Evict finished jobs only — dropping a running job would 404 its
            # respond/interrupt endpoints and strand a pending permission card.
            done = [j for j in _jobs.values() if j.status != "running"]
            excess = len(_jobs) - _JOBS_MAX
            for old in sorted(done, key=lambda j: j.started)[:excess]:
                _jobs.pop(old.id, None)


# One canonical tool summarizer, defined in the dependency-free transcript module
# and reused here (and in agents.py) so a tool call renders identically whether it
# comes from the live stream or a native transcript.
_summarize_tool = transcript_jsonl._summarize_tool


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
                    job.texts.append(txt)
                    job.add({"type": "text", "text": txt})
            elif b.get("type") == "tool_use":
                name = b.get("name", "tool")
                inp = b.get("input", {})
                if name in _EDIT_TOOLS and isinstance(inp, dict) and inp.get("file_path"):
                    job.edited.append(str(inp["file_path"]))
                job.add({"type": "tool", "name": name,
                         "summary": _summarize_tool(name, inp)})
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
        job.timed_out = True
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
                        claude_session_id=job.resume_id, cwd=cwd)
        try:
            proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, bufsize=1)
        except FileNotFoundError:
            job.add({"type": "error", "message": "`claude` not found on PATH."})
            job.status = "error"
            return
        job.proc = proc

        # Drain stderr continuously: a child that writes more than the OS pipe
        # buffer mid-run would otherwise block against our unread pipe while we
        # block on stdout — deadlock. Keep only a tail for error reporting.
        stderr_tail: list[str] = []

        def _drain_stderr():
            try:
                for eline in proc.stderr:
                    stderr_tail.append(eline)
                    if len(stderr_tail) > 50:
                        del stderr_tail[:-50]
            except (ValueError, OSError):
                pass

        if proc.stderr is not None:
            threading.Thread(target=_drain_stderr, daemon=True).start()

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
            # No terminal result event — surface the timeout / stderr / exit code.
            err = "".join(stderr_tail).strip()
            if job.timed_out:
                msg = f"⏱️ Timed out after {config.RUN_TIMEOUT // 60} min."
            else:
                msg = err[:1500] or f"claude exited {proc.returncode}"
            job.add({"type": "error", "message": msg})
            job.status = "error"
    except Exception as e:  # noqa: BLE001
        job.add({"type": "error", "message": str(e)})
        job.status = "error"
    finally:
        if job._interrupt_timer:
            job._interrupt_timer.cancel()
        # Never leave the finally with the child alive: the run slot is released
        # below, and a second --resume against a still-running claude would
        # corrupt its session transcript. Normal exits reaped already; this is
        # the exception/error path's safety net.
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=5)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
        if job.elapsed is None:
            job.elapsed = int(time.time() - job.started)
        restart_killed = _restart_killed(job)   # freeze: the flag can flip mid-finally
        if job.store_session_id:
            if job.session_id:
                store.set_claude_session_id(job.store_session_id, job.session_id)
            if not restart_killed:   # else leave 'running' for boot recovery to resume
                store.finish_turn(job.id, job.status, job.cost, job.elapsed)
        job.clear_pending()
        job.close_stdin()
        _cleanup_uploads(job.id)
        if job.store_session_id:
            state.release_run(job.store_session_id)
            # The session's run slot is now free: let the preview queue mark this
            # item done/failed and start the next queued prompt. Best-effort.
            try:
                from bridge import queue_manager
                queue_manager.notify_job_done(
                    job.store_session_id, job.id, job.status,
                    job.result, job.cost, job.elapsed)
            except Exception:  # noqa: BLE001 — never let the queue break a run
                pass
        resumed = not restart_killed and _maybe_auto_resume(job, cwd, model, effort)
        if not job.interrupted and job.status == "done" and job.store_session_id:
            _capture_async(job.chat_id, job.store_session_id, job.id, cwd,
                           "\n\n".join(job.texts), list(job.edited))
        if not job.interrupted and not resumed and not restart_killed:
            notify_turn_done(job.chat_id, job.store_session_id, job.status == "error")
        # Teacher-mode capture (best-effort, background thread). Streaming has
        # tool visibility, so we trust Edit/Write detection.
        if job.store_session_id and job.status == "done":
            _sess = store.get_session(job.store_session_id)
            if _sess:
                from bridge import learning, titler  # local import: runner<->* cycle
                threading.Thread(target=learning.capture_after_turn,
                                 args=(job.chat_id, _sess, job.id),
                                 kwargs={"tool_visibility": True},
                                 daemon=True).start()
                threading.Thread(target=titler.generate_after_turn,
                                 args=(job.chat_id, _sess, job.id),
                                 daemon=True).start()


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
    # A stored cwd can be a git worktree that was later removed; spawning there
    # raises FileNotFoundError (which the bridge misreports as "`claude` not found
    # on PATH"). Fall back to the project dir so the run still proceeds.
    if not os.path.isdir(cwd):
        cwd = project_dir
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
