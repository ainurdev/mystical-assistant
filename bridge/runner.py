"""Claude Code runner.

Two entry points share the same auth/session/permission setup:
  - run_blocking()  -> one-shot JSON result (the bot's plain-text prompt path)
  - start_streaming_job() -> a Job whose events stream in live (the Mini App path)

Both serialize on state.busy so only one Claude run happens at a time.
"""

import json
import os
import shlex
import shutil
import subprocess
import threading
import time
import uuid

from bridge import config, state
from bridge.browser import rel
from bridge.telegram import send, typing


def _base_cmd(prompt: str, chat_id: int, stream: bool) -> list[str]:
    fmt = "stream-json" if stream else "json"
    cmd = ["claude", "-p", prompt, "--output-format", fmt]
    if stream:
        cmd.append("--verbose")  # required with stream-json in -p mode
    sid = state.sessions.get(chat_id)
    if sid:
        cmd += ["--resume", sid]
    if config.ASK_SYSTEM_PROMPT.strip():
        cmd += ["--append-system-prompt", config.ASK_SYSTEM_PROMPT]
    if config.EXTRA_CLAUDE_ARGS.strip():
        cmd += shlex.split(config.EXTRA_CLAUDE_ARGS)
    return cmd


# ---------------------------------------------------------------------------
# Blocking run (Telegram plain-text prompt)
# ---------------------------------------------------------------------------

def run_blocking(chat_id: int, prompt: str):
    cmd = _base_cmd(prompt, chat_id, stream=False)
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


def handle_task(chat_id: int, prompt: str):
    """Runs in a thread; assumes the caller already acquired state.busy."""
    try:
        typing(chat_id)
        send(chat_id, f"🤖 On it… ({rel(state.project_dir(chat_id))})")
        started = time.time()
        result, sid, cost, is_error = run_blocking(chat_id, prompt)
        if sid:
            state.sessions[chat_id] = sid
        footer = f"\n\n— {int(time.time() - started)}s"
        if cost is not None:
            footer += f" · ${cost:.4f}"
        send(chat_id, ("⚠️ " if is_error else "") + (result or "(no result)") + footer)
    finally:
        state.busy_chat = None
        state.busy.release()


# ---------------------------------------------------------------------------
# Streaming jobs (Mini App)
# ---------------------------------------------------------------------------

class Job:
    def __init__(self, job_id: str, chat_id: int):
        self.id = job_id
        self.chat_id = chat_id
        self.events: list[dict] = []
        self.status = "running"          # running | done | error
        self.result: str | None = None
        self.cost: float | None = None
        self.session_id: str | None = None
        self.started = time.time()
        self.elapsed: int | None = None
        self._lock = threading.Lock()

    def add(self, ev: dict):
        with self._lock:
            self.events.append(ev)

    def snapshot(self, cursor: int) -> dict:
        with self._lock:
            out = {
                "status": self.status,
                "events": self.events[cursor:],
                "next_cursor": len(self.events),
            }
            if self.status != "running":
                out.update(result=self.result, cost=self.cost,
                           elapsed=self.elapsed, session_id=self.session_id)
            return out


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()
_JOBS_MAX = 20


def get_job(job_id: str) -> Job | None:
    with _jobs_lock:
        return _jobs.get(job_id)


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


def _handle_event(job: Job, d: dict):
    t = d.get("type")
    if d.get("session_id"):
        job.session_id = d["session_id"]
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
        job.status = "error" if d.get("is_error") else "done"
        job.elapsed = int(time.time() - job.started)
        job.add({"type": "result", "result": job.result,
                 "cost": job.cost, "elapsed": job.elapsed})


def _cleanup_uploads(job_id: str):
    d = os.path.join(config.UPLOAD_DIR, job_id)
    shutil.rmtree(d, ignore_errors=True)


def _run_streaming(job: Job, prompt: str, image_paths: list[str], cwd: str):
    proc = None
    try:
        full_prompt = prompt
        if image_paths:
            full_prompt = ("The user attached screenshot(s); view them before "
                           "responding: " + ", ".join(image_paths) + "\n\n" + prompt)
        cmd = _base_cmd(full_prompt, job.chat_id, stream=True)
        try:
            proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, bufsize=1)
        except FileNotFoundError:
            job.add({"type": "error", "message": "`claude` not found on PATH."})
            job.status = "error"
            return

        # Watchdog: kill the run if it exceeds RUN_TIMEOUT.
        timer = threading.Timer(config.RUN_TIMEOUT, proc.kill)
        timer.daemon = True
        timer.start()

        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            _handle_event(job, d)
        proc.wait()
        timer.cancel()

        if job.status == "running":
            # No terminal result event — surface stderr / exit code.
            err = (proc.stderr.read() if proc.stderr else "").strip()
            job.add({"type": "error",
                     "message": err[:1500] or f"claude exited {proc.returncode}"})
            job.status = "error"
    except Exception as e:  # noqa: BLE001
        job.add({"type": "error", "message": str(e)})
        job.status = "error"
    finally:
        if job.elapsed is None:
            job.elapsed = int(time.time() - job.started)
        if job.session_id:
            state.sessions[job.chat_id] = job.session_id
        _cleanup_uploads(job.id)
        state.busy_chat = None
        state.busy.release()


def start_streaming_job(chat_id: int, prompt: str, image_paths: list[str],
                        project: str | None = None, job_id: str | None = None) -> Job | None:
    """Acquire the busy lock and start a streaming run. Returns None if busy."""
    if not state.busy.acquire(blocking=False):
        return None
    state.busy_chat = chat_id
    job = Job(job_id or uuid.uuid4().hex, chat_id)
    _register(job)
    cwd = project or state.project_dir(chat_id)
    threading.Thread(target=_run_streaming,
                     args=(job, prompt, image_paths, cwd), daemon=True).start()
    return job
