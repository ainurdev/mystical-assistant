"""Claude Code runner.

Two entry points share the same auth/session/permission setup:
  - run_blocking()  -> one-shot JSON result (the bot's plain-text prompt path)
  - start_streaming_job() -> a Job whose events stream in live (the Mini App path)

Each run claims its session's slot in state's per-session run registry, so two
turns never hit the same Claude session at once, but different sessions run
concurrently.
"""

import base64
import json
import mimetypes
import os
import queue
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid

from bridge import (accounts, agents, aifeatures, config, devserver, flow, git,
                    inspector, ladder, limits, machine, native_activity,
                    pubsub, relevance, state, store, transcript_jsonl)
from bridge.browser import rel
from bridge.telegram import panel_kb, send, typing


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


def _graph_pack_for(chat_id: int, cwd: "str | None") -> str:
    """Graphify structure pack for injection. Best-effort: no graph, no module,
    any failure — empty string, never blocks a turn."""
    try:
        from bridge import graphmap
        return graphmap.graph_pack(cwd or state.project_dir(chat_id))
    except Exception:  # noqa: BLE001
        return ""


def _graph_refresh_after_turn(chat_id: int, cwd: "str | None") -> None:
    """Keep an existing graph fresh after a successful turn (fire-and-forget;
    refresh_async no-ops for projects that were never mapped)."""
    try:
        from bridge import graphmap
        graphmap.refresh_async(cwd or state.project_dir(chat_id))
    except Exception:  # noqa: BLE001
        pass


def _compose_system_prompt(graph: str = "", flow_section: str = "") -> str:
    """ASK prompt + dev-log note, then the graph pack, then the flow stage.

    Ordering does NOT protect the cache: the whole string lands in
    --append-system-prompt, which sits after the last cache breakpoint, so any
    change re-writes all of it. What protects the cache is only sending the
    volatile packs once per session — see _base_cmd. The flow section is the
    exception that pays for itself: it is stable per stage, so it re-writes
    only when the session actually moves on (bridge/flow.py)."""
    parts = [p for p in (config.ASK_SYSTEM_PROMPT.strip(), _LOG_NOTE,
                         graph.strip(), flow_section.strip()) if p]
    return "\n\n".join(parts)


# Claude session ids we've already injected the graph pack into. The pack
# are rebuilt from live state, so re-sending them each turn silently changes
# --append-system-prompt and invalidates the cached prefix (measured: one added
# pack line moved ~11k tokens from cache_read to cache_create, a ~12x price step
# on that segment, and on a resumed session the invalidated span is the whole
# transcript). Once per session is also all that's useful: turn 1's pack is still
# in context. Bounded by sessions-since-boot.
_packed_sessions: set[str] = set()


# --- ponytail (per-run code-minimalism intensity) ----------------------------
# The ponytail plugin's SessionStart hook reads PONYTAIL_DEFAULT_MODE from the
# child's env; absent means the plugin's own default (full). One env var is the
# whole integration — no tokens, no config writes, native sessions untouched.

_PONYTAIL_LEVELS = ("off", "lite", "full", "ultra")


def normalize_ponytail(level) -> "str | None":
    lv = str(level or "").strip().lower()
    return lv if lv in _PONYTAIL_LEVELS else None


def _run_env(ponytail: "str | None",
             account_slot: "int | None" = None) -> "dict | None":
    """Env for the claude subprocess: None (inherit) unless a run picked a
    ponytail intensity or a non-default Claude account. The account arrives as
    CLAUDE_CONFIG_DIR, which is the whole multi-account mechanism -- every turn
    is still the official binary, just pointed at one login's profile."""
    over = accounts.env_for(account_slot)
    # Switched off in the AI tab, the level is not just skipped but overridden:
    # an absent PONYTAIL_DEFAULT_MODE means the plugin's own default (full), so
    # "off" is the only way to actually not get ponytail.
    if not aifeatures.enabled("ponytail"):
        over["PONYTAIL_DEFAULT_MODE"] = "off"
    elif ponytail:
        over["PONYTAIL_DEFAULT_MODE"] = ponytail
    base = inspector.base_url()
    if base:
        # The inspector is a pass-through proxy in front of api.anthropic.com;
        # off (the default) this is None and the child talks to the API directly.
        over["ANTHROPIC_BASE_URL"] = base
    if not over:
        return None
    return {**os.environ, **over}


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


_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _mcp_config(claude_session_id: str, extra: "dict | None" = None) -> str:
    """Inline --mcp-config JSON for the bridge's own tool servers, plus any
    external servers this session left switched on. PYTHONPATH pins the repo root
    so `-m bridge.*` imports regardless of the run's cwd. Ours go in last: a
    user server named `goals` must not shadow the goal tools."""
    env = {"PYTHONPATH": _REPO_ROOT,
           "MYSTICAL_CLAUDE_SESSION_ID": claude_session_id}
    return json.dumps({"mcpServers": {
        **(extra or {}),
        "goals": {"command": sys.executable,
                  "args": ["-m", "bridge.goal_mcp"], "env": env},
        "verify": {"command": sys.executable,
                   "args": ["-m", "bridge.verify_mcp"], "env": env},
    }})


def _configured_mcp_servers(cwd: "str | None") -> dict:
    """Every MCP server definition we can read back out of config, by name —
    user and local scope from ~/.claude.json, project scope from .mcp.json.

    Best-effort: a file we can't read just means fewer servers we can re-declare,
    which _external_mcp turns into leaving the ambient config alone."""
    out: dict = {}

    def merge(d) -> None:
        if isinstance(d, dict):
            out.update({k: v for k, v in d.items() if isinstance(v, dict)})

    try:
        with open(os.path.expanduser("~/.claude.json"), encoding="utf-8") as f:
            user = json.load(f)
        merge(user.get("mcpServers"))
        merge(((user.get("projects") or {}).get(cwd) or {}).get("mcpServers"))
    except (OSError, ValueError, AttributeError):
        pass
    try:
        with open(os.path.join(cwd or ".", ".mcp.json"), encoding="utf-8") as f:
            merge(json.load(f).get("mcpServers"))
    except (OSError, ValueError, AttributeError):
        pass
    return out


def _external_mcp(disabled_tools: "list[str] | None",
                  cwd: "str | None") -> "tuple[dict, bool]":
    """(external server definitions to inline, whether the ambient MCP config can
    be dropped with --strict-mcp-config).

    A session that never opened the Tools modal gets nothing external — and says
    so as strict mode rather than as one deny rule per server. That's the whole
    latency win: building the deny list meant asking `claude mcp list` what's
    configured, and that health-checks every server (measured 6-9s here) on the
    very thread that then spawns claude. Not loading them saves ~1.6s more
    (system/init 3.2s -> 1.5s, first token 5.5s -> 3.6s, measured).

    Once a session HAS configured its tools we do enumerate, so a server left on
    keeps working: it's re-declared from its own config-file definition, which
    preserves its OAuth (verified against teamwork/github/notion). A plugin-
    bundled server has no definition to copy, so one of those left on drops
    strict mode entirely — a run silently missing a tool the Tools modal shows as
    ON is the UI lying, and that costs more than the seconds do."""
    if disabled_tools is None:
        return {}, True
    from bridge import toolsets  # local: toolsets imports runner
    denied = set(disabled_tools)
    defs = _configured_mcp_servers(cwd)
    extra, strict = {}, True
    for s in toolsets.servers():
        if s["rule"] in denied:
            continue
        if s["name"] in defs:
            extra[s["name"]] = defs[s["name"]]
        else:
            strict = False
    return extra, strict


def _base_cmd(prompt: str, chat_id: int, *, stream: bool,
              interactive: bool = False, model: str | None = None,
              effort: str | None = None, permission_mode: str | None = None,
              claude_session_id: str | None = None, cwd: str | None = None,
              skip_pack: bool = False, new_session: bool = False,
              fork: bool = False, disabled_tools: list[str] | None = None,
              autocompact: str | None = None, flow_section: str = "") -> list[str]:
    """Build the `claude` argv.

    interactive=True (Mini App chat) drives Claude over the stream-json control
    protocol: the prompt is delivered on stdin (not as an arg), permissions are
    routed back to us via `--permission-prompt-tool stdio`, and we run in an
    asking permission mode so tool use surfaces Allow/Deny cards. The bot's
    plain-text path stays non-interactive and keeps EXTRA_CLAUDE_ARGS.

    model/effort (interactive only) map to `--model`/`--effort`; the server
    validates them before they reach here.

    new_session means claude_session_id is an id *we* minted for a session that
    doesn't exist yet — it goes in as --session-id (claude adopts it) rather than
    --resume (which requires an existing transcript).
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
        if claude_session_id:
            # Goal + verify tools, on interactive runs only, alongside whichever
            # external servers this session left switched on — re-declared here
            # so --strict-mcp-config can drop everything else. Internal one-shots
            # below still take MCP off entirely.
            extra, strict = _external_mcp(disabled_tools, cwd)
            cmd += ["--mcp-config", _mcp_config(claude_session_id, extra)]
            if strict:
                cmd.append("--strict-mcp-config")
                if disabled_tools is None:
                    # Nothing external got loaded, so there's nothing left to
                    # deny — and settling it here is what keeps the fallback
                    # below (and its `claude mcp list` call) off this path.
                    disabled_tools = []
    if model:
        cmd += ["--model", model]
    if effort:
        cmd += ["--effort", effort]
    if autocompact and not skip_pack:
        # Window size at which claude compacts itself. Internal one-shots skip it:
        # a titler call is one turn and never near the window.
        cmd += ["--autocompact", autocompact]
    if claude_session_id:
        cmd += (["--session-id", claude_session_id] if new_session
                else ["--resume", claude_session_id])
        if fork:
            # Duplicated session: resume the source transcript but let claude
            # mint a new id, so the original is never appended to.
            cmd.append("--fork-session")
    if skip_pack or (claude_session_id and claude_session_id in _packed_sessions):
        graph = ""
    else:
        graph = _graph_pack_for(chat_id, cwd)
        if claude_session_id:
            _packed_sessions.add(claude_session_id)
    cmd += ["--append-system-prompt", _compose_system_prompt(graph, flow_section)]
    if skip_pack and not (permission_mode and not interactive):
        # Internal one-shots (titler/commit-msg) are pure text transforms
        # whose prompts embed untrusted conversation text. No tools and no
        # EXTRA_CLAUDE_ARGS (acceptEdits!) — an agentic run here is an injection
        # vector: a first message like "scan the project" gets executed, not named.
        # --strict-mcp-config with no --mcp-config means no MCP servers at all:
        # free, since --tools "" already denies their tools, and it takes ~0.9s
        # off each one-shot (5.33s -> 4.45s, mean of 3). Several run per turn.
        cmd += ["--tools", "", "--strict-mcp-config"]
    elif not interactive and permission_mode:
        # An internal one-shot that must *read* the repo (the next-up scout).
        # Its own permission mode instead of EXTRA_CLAUDE_ARGS: 'plan' leaves the
        # read tools available and takes editing and shell off the table. Still an
        # internal one-shot, so it skips MCP for the same second it saves above.
        cmd += ["--permission-mode", permission_mode, "--strict-mcp-config"]
    elif not interactive and config.EXTRA_CLAUDE_ARGS.strip():
        cmd += shlex.split(config.EXTRA_CLAUDE_ARGS)
    if disabled_tools is None and "--strict-mcp-config" not in cmd:
        # No per-session choice on this run (a Telegram one-shot, a sessionless
        # job): same answer a never-configured session gets above — no external
        # MCP servers, said as strict mode rather than as a deny list, so this
        # path never pays for `claude mcp list` either. Only when it's None: an
        # explicit [] is the user switching everything on from the Tools modal,
        # and that has to win — a run that silently re-denies what the UI shows
        # as ON is the UI lying.
        cmd.append("--strict-mcp-config")
        disabled_tools = []
    if disabled_tools:
        # Bare tool/server names, so a switched-off tool leaves the model's
        # context entirely rather than being offered and then refused.
        cmd += ["--disallowedTools", ",".join(disabled_tools)]
    return cmd


# ---------------------------------------------------------------------------
# Blocking run (Telegram plain-text prompt)
# ---------------------------------------------------------------------------

def _claim_session_id(store_session_id: str,
                      existing: "str | None") -> "tuple[str, bool, bool]":
    """(claude session id, is_new, fork). A session with no claude id yet gets one
    minted and persisted BEFORE the child spawns, so it goes in as --session-id and
    the store row is linked from the first moment — see _handle_event.

    A duplicated session has no id of its own but carries its source's in
    fork_from: it resumes that transcript with --fork-session, claude mints the new
    id, and _handle_event stores it (clearing fork_from). Nothing is written to the
    original."""
    if existing:
        return existing, False, False
    row = store.get_session(store_session_id) or {}
    if row.get("fork_from"):
        return row["fork_from"], False, True
    sid = str(uuid.uuid4())
    store.set_claude_session_id(store_session_id, sid)
    return sid, True, False


def run_blocking(chat_id: int, prompt: str, resume_id: str | None = None,
                 cwd: str | None = None, timeout: int | None = None, *,
                 model: str | None = None, skip_pack: bool = False,
                 permission_mode: str | None = None,
                 ponytail: str | None = None, new_session: bool = False,
                 fork: bool = False, flow_section: str = ""):
    cmd = _base_cmd(prompt, chat_id, stream=False, claude_session_id=resume_id,
                    cwd=cwd, model=model, skip_pack=skip_pack,
                    permission_mode=permission_mode, new_session=new_session,
                    fork=fork, flow_section=flow_section)
    timeout = timeout or config.RUN_TIMEOUT
    try:
        proc = subprocess.run(cmd, cwd=cwd or state.project_dir(chat_id), capture_output=True,
                              text=True, timeout=timeout, env=_run_env(ponytail))
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
        store.start_turn(session["id"], job_id, prompt, [],
                         sha=git.head_sha(state.project_dir(chat_id)))
        from bridge import titler  # local import: runner<->* cycle
        titler.kick(chat_id, session, job_id)
        claude_sid, is_new, fork = _claim_session_id(
            session["id"], session["claude_session_id"])
        result, sid, cost, is_error = run_blocking(
            chat_id, prompt, resume_id=claude_sid, new_session=is_new, fork=fork,
            flow_section=flow.section_for(session))
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
        if (is_error and config.AUTO_RESUME and limits.is_limit_error(result)
                and (sid or session["claude_session_id"])):
            d = limits.defer(session["id"], chat_id, None)
            if d is not None:
                # Parked. Same order as the streaming path: escalate second, and
                # stay quiet when a ladder rung takes the work (it announces itself).
                if ladder.escalate(store.get_session(session["id"]) or session,
                                   chat_id):
                    return
                send(chat_id, "⏳ Claude usage limit hit — this session will auto-"
                              f"resume when the limit resets (~{limits.when_str(d[0])}).",
                     _session_kb(chat_id, session["id"]))
                return
        if (is_error and config.AUTO_RESUME and limits.is_server_error(result)
                and (sid or session["claude_session_id"])):
            d = limits.defer_server(session["id"], chat_id, None)
            if d is not None:
                send(chat_id, f"⚠️ Claude API error — retrying {limits.wait_str(d[0])} "
                              f"(attempt {d[1]}/{len(limits.SERVER_BACKOFF)}).")
                return
        if is_error and limits.is_auth_error(result):
            _auth_stop(chat_id, session["id"], None, reply=True)
            return
        if not is_error:
            _graph_refresh_after_turn(chat_id, None)
        footer = f"\n\n— {int(time.time() - started)}s"
        answer = ("⚠️ " if is_error else "") + (result or "(no result)") + footer
        # A button under every reply would be noise; under one that errored or is
        # too long to read in a chat bubble, it's the way out.
        kb = (_session_kb(chat_id, session["id"], "🛠 Open session")
              if is_error or len(answer) > config.TG_MAX - 512 else None)
        send(chat_id, answer, kb)
        if not is_error:
            titler.kick(chat_id, session, job_id)   # retry if the start call missed
            from bridge import learn  # local import: runner<->* cycle
            learn.kick(chat_id, session, job_id)
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
        self.resume_id: str | None = None         # claude session id for this run
        self.new_session = False                  # True -> --session-id, else --resume
        self.fork = False                # duplicated session: --resume + --fork-session
        self.events: list[dict] = []
        self.status = "running"          # running | done | error
        # What this turn is waiting on before its first token, or None once the
        # child starts talking. Deliberately NOT an event: it is a live status,
        # and an event would persist "starting Claude" into every transcript.
        self.boot: str | None = None
        self.result: str | None = None
        self.cost: float | None = None
        self.session_id: str | None = None
        self.started = time.time()
        self.last_at = self.started      # when the last event landed (thinking gap)
        self.elapsed: int | None = None
        self.proc = None                 # subprocess.Popen, for control responses
        self.pending: list[dict] = []    # unresolved can_use_tool requests
        self.interrupted = False         # user pressed Stop
        self.timed_out = False           # watchdog killed the run
        self.error_msg: str | None = None  # stderr/exit error when no result event came
        self.tail_needs: str | None = None  # set when the closing ended needing the user
        self.ask_dismissed = False       # you waved off the closing question (see dismiss_ask)
        self.account_slot: int | None = None  # Claude account this ran on (None = default)
        self.runtime: str | None = None   # 'opencode:<provider>' when a free agent runs it
        self.texts: list[str] = []       # assistant text this turn
        self.ctx_tokens: int | None = None  # window fill on the last request (see _ctx_of)
        # What the turn spent: the same four counters, summed instead of last-wins.
        # None until a message actually reports usage, so a stream that never did
        # leaves the columns NULL — unknown rather than free.
        self.tokens: dict | None = None
        self.cwd: str | None = None       # where claude was spawned (set by _run_streaming)
        self.work_cwd: str | None = None  # worktree the shell moved into, if any
        # tool_use id -> (name, start time), for output/diff + duration on tool_done
        self.open_tools: dict[str, tuple[str, float]] = {}
        self._interrupt_timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self._stdin_lock = threading.Lock()

    def add(self, ev: dict):
        with self._lock:
            self.events.append(ev)
            self.last_at = time.time()
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
                "boot": self.boot,
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


def _with_images(prompt: str, image_paths: list[str] | None) -> str:
    """Point the model at the screenshots it was sent. They stay on disk (the
    upload dir) rather than going inline: a screenshot is a megabyte of base64,
    and the child can just read the file."""
    if not image_paths:
        return prompt
    return ("The user attached screenshot(s); view them before responding: "
            + ", ".join(image_paths) + "\n\n" + prompt)


def steer(session_id: str, text: str, image_paths: list[str] | None = None) -> bool:
    """Fold a message into a session's IN-FLIGHT turn instead of queueing a new
    one. A stream-json user message written to the live child mid-turn is picked
    up at the next tool-loop boundary (the CLI's queued_command fold-in), so the
    running prompt changes course. False if that session has no live job.

    Screenshots ride along as paths, exactly as a normal turn's do — the live
    child reads them off disk, so a mid-turn "look at this" works the same as
    one sent from a cold composer.

    Verified against claude 2.1.220: a turn with no tool call has no fold point,
    so a steer sent at the very end simply runs as a follow-up turn on the same
    process. Same job either way — nothing to clean up.
    """
    with _jobs_lock:
        job = next((j for j in _jobs.values()
                    if j.store_session_id == session_id and j.status == "running"), None)
    if job is None or job.proc is None:
        return False
    job._write_stdin({"type": "user", "message": {"role": "user",
                                                  "content": _with_images(text, image_paths)}})
    job.add({"type": "steer", "text": text, "images": list(image_paths or [])})
    return True


def boot_phase(session_id: str) -> "str | None":
    """What this session's live turn is waiting on before its first token, or
    None. Same lookup as steer(): a session has at most one running job."""
    with _jobs_lock:
        job = next((j for j in _jobs.values()
                    if j.store_session_id == session_id and j.status == "running"), None)
    return job.boot if job else None


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


def _latest_jobs() -> dict[str, "Job"]:
    """The newest job per store-session id — the only one whose ending still
    describes the session. Starting another turn replaces it, so nothing that
    reads this needs state to reset."""
    latest: dict[str, Job] = {}
    with _jobs_lock:
        for j in _jobs.values():
            if not j.store_session_id:
                continue
            cur = latest.get(j.store_session_id)
            if cur is None or j.started > cur.started:
                latest[j.store_session_id] = j
    return latest


def blocked_sessions() -> dict[str, str]:
    """Store-session ids whose MOST RECENT turn ended needing you, mapped to the
    ask."""
    return {sid: j.tail_needs for sid, j in _latest_jobs().items()
            if j.status != "running" and j.tail_needs}


# The closing sentence when a turn signed off by asking you something. Same shape
# the transcript's ASK card splits out (web/src/lib/askback.ts): the last
# sentence, ending in "?", short enough to be a question rather than a paragraph
# that happens to end in one.
_ASK_SPLIT = re.compile(r"(?:[.!?][\"'`)\]]*\s+|\n)")
_ASK_MAX = 240
_ASK_TAIL = 1200      # the question is at the end; no need to scan a 300-line report
# How long an unanswered closing question keeps a session in the WAITING lists.
# The card stays in the transcript and you can still answer it — but nobody is
# blocked on a question you walked away from hours ago, and without a cap it sits
# in the count forever.
_ASK_TTL = 2 * 3600


def _closing_question(text: str) -> str | None:
    t = (text or "").rstrip()[-_ASK_TAIL:]
    if not t.endswith("?"):
        return None
    q = _ASK_SPLIT.split(t)[-1].strip(" \t-*>")
    return q if q.endswith("?") and len(q) <= _ASK_MAX else None


def asked_sessions() -> dict[str, str]:
    """Store-session ids whose last turn *finished* by asking you something,
    mapped to the question. Not blocked_sessions(): that turn couldn't deliver
    what you asked for, this one did and then asked a follow-up. It's still your
    move, and only you can make it."""
    out: dict[str, str] = {}
    now = time.time()
    for sid, j in _latest_jobs().items():
        if j.status != "done" or j.tail_needs or j.ask_dismissed:
            continue
        if now - j.last_at > _ASK_TTL:
            continue
        if q := _closing_question(j.result or (j.texts[-1] if j.texts else "")):
            out[sid] = q
    return out


def dismiss_ask(session_id: str) -> bool:
    """You answered the closing question with "No" — the session is done, not
    waiting on you, and saying so isn't worth a whole turn. Drops the ASK state
    without running anything."""
    j = _latest_jobs().get(session_id)
    if not j or j.status == "running":
        return False
    j.ask_dismissed = True
    # A closing tailstate read as *blocked* (WAIT) shows the same chips and is
    # waved off the same way — without this the row stayed amber after "No".
    j.tail_needs = None
    return True


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


def _running_agents(claude_sid: str) -> int:
    """Subagents still in flight for a native session id (0 if it spawned none).
    Cheap: no subagents dir → two stats; the transcript read behind it is
    memoized on (mtime, size), and a session busy with agents is quiet."""
    return agents.session_agents({"claude_session_id": claude_sid})["running"]


def _build_status(bridge_running: list, awaiting: list, jobs: list,
                  external: list, native_snap: dict) -> dict:
    """Merge bridge + native liveness into one {session_id: {state, kind, source,
    label}} map — the single status contract both web surfaces render from. State
    is 'awaiting' | 'working' | 'checking' | 'parked' | 'live' | 'idle'; bridge
    sessions are awaiting/working/checking/parked, native (VS Code/terminal) working/live/
    idle. External rows are annotated in place with their `state` for the jobs
    monitor."""
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
    # A turn that ENDED on a question only you can answer is awaiting you just as
    # much as one stopped mid-run — it just had no card to raise (see
    # bridge/tailstate.py). Same state, so every surface already sorts, counts and
    # flags it; `kind` is None because there is no pending card to respond to.
    # setdefault: a session that has since started another turn is working now.
    for sid, needs in blocked_sessions().items():
        status.setdefault(sid, {"state": "awaiting", "kind": None,
                                "source": "bridge", "label": needs})
    # A prompt being checked against its session (bridge/relevance.py) holds the
    # send for ~10s before any job exists — surface it so the session stays in the
    # active lists instead of vanishing until the prompt is approved.
    for sid in relevance.checking_ids():
        status.setdefault(sid, {"state": "checking", "kind": None,
                                "source": "bridge",
                                "label": "checking this prompt fits…"})
    # A limit- or error-parked turn (bridge/limits.py) has no process, but it is
    # coming back on its own — reported as idle it reads as finished, and every
    # surface would announce a DONE that never happened.
    for sid, (pkind, at) in limits.parked().items():
        status.setdefault(sid, {
            "state": "parked", "kind": pkind, "source": "bridge",
            "label": (f"usage limit — resuming ~{limits.when_str(at)}" if pkind == "limit"
                      else f"API error — retrying {limits.wait_str(at)}")})
    # A turn that signed off with a question — the ASK card in the transcript —
    # is finished, not blocked: the work landed and nothing is parked. But the
    # next move is yours, and reported as idle it looks like nobody is waiting.
    # Last, so a session already working, checking or parked stays that way.
    for sid, q in asked_sessions().items():
        status.setdefault(sid, {"state": "asking", "kind": None,
                                "source": "bridge", "label": q})
    now = time.time()
    for row in external:
        sid = row.get("session_id")
        st = native_snap.get(sid) if sid else None
        if st and st["state"] == "working":
            row["state"] = "working"
            if sid and sid not in status:
                status[sid] = {"state": "working", "kind": None, "source": "native",
                               "label": st.get("label") or "working…"}
        # A parent blocked on subagents appends nothing to its own transcript, so
        # agents in flight are the only liveness signal it has left — without this
        # a long fan-out reads LIVE, then IDLE/DONE, while it is still working.
        elif sid and (n := _running_agents(sid)):
            row["state"] = "working"
            if sid not in status:
                status[sid] = {"state": "working", "kind": None, "source": "native",
                               "label": f"{n} agent{'s' if n > 1 else ''} working"}
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
    # Same blind spot as the native branch of _build_status, one layer over: a
    # bridge session whose turn ended while background agents keep running holds
    # no job and appends nothing to its transcript, so the agents in flight are
    # its only liveness signal. Only sessions whose process is still up can have
    # any (bridge.agents gates on that), so the live registry bounds the scan.
    for csid in machine.live_session_ids():
        sess = store.get_by_claude_session_id(csid)
        if not sess or sess["id"] in status or sess.get("chat_id") != chat_id:
            continue
        if n := _running_agents(csid):
            status[sess["id"]] = {"state": "working", "kind": None, "source": "bridge",
                                  "label": f"{n} agent{'s' if n > 1 else ''} working"}
    return {"external": external, "bridge_running": bridge_running,
            "jobs": jobs, "awaiting": awaiting, "status": status}


def _notify(chat_id: int | None, text: str, kb: dict | None = None) -> None:
    """Best-effort Telegram push (never raises into the run loop)."""
    if not config.NOTIFY_ENABLE or not chat_id:
        return
    try:
        send(chat_id, text, kb)
    except Exception:  # noqa: BLE001
        pass


def _session_label(session_id: str | None) -> str:
    sess = store.get_session(session_id) if session_id else None
    if not sess:
        return "your session"
    title = sess.get("title") or sess["id"][:8]
    proj = sess.get("project")
    return f"{title}{f' · {proj}' if proj else ''}"


def _session_kb(chat_id: int | None, session_id: str | None,
                label: str = "🛠 Open Panel") -> dict | None:
    """Panel button pointing at the session this message is about."""
    if not chat_id:
        return None
    sess = store.get_session(session_id) if session_id else None
    return panel_kb(chat_id, session_id, sess.get("project") if sess else None, label)


def notify_awaiting(chat_id: int | None, session_id: str | None, kind: str) -> None:
    """Ping when a streaming run blocks on you (a question or an approval)."""
    what = "a question" if kind == "question" else "your approval"
    _notify(chat_id, f"❓ Claude needs {what} — {_session_label(session_id)}",
            _session_kb(chat_id, session_id, "❓ Answer in Panel"))


def notify_turn_done(chat_id: int | None, session_id: str | None, is_error: bool) -> None:
    """Ping when a streaming run finishes (or errors), so you can step away."""
    icon, verb = ("⚠️", "hit an error") if is_error else ("✅", "finished")
    _notify(chat_id, f"{icon} Claude {verb} — {_session_label(session_id)}",
            _session_kb(chat_id, session_id, "🛠 Open session"))


def notify_needs_you(chat_id: int | None, session_id: str | None, needs: str) -> None:
    """Ping when a turn *ended* on something only you can answer. Carries the ask
    itself: it's read off a lock screen, and acting on it shouldn't cost opening
    the transcript to find out what was asked (bridge/tailstate.py)."""
    _notify(chat_id, f"❓ Claude needs you — {_session_label(session_id)}\n{needs}",
            _session_kb(chat_id, session_id, "❓ Answer in Panel"))


# ---------------------------------------------------------------------------
# Auto-resume: only the user may stop a turn
# ---------------------------------------------------------------------------
# Five non-user ways a turn dies, five answers:
#   - The bridge is restarting (group SIGINT/SIGKILL takes the Claude child down):
#     leave the turn 'running' so startup recovery (bridge/recovery.py) claims and
#     resumes it on the next boot.
#   - The account hit a usage limit: an immediate resume can only fail again, so
#     the session is parked in bridge/limits.py, which resumes it when the limit
#     resets.
#   - The API failed transiently (5xx, or a server-side 429): retry, but on
#     limits.SERVER_BACKOFF — once immediately, then 1m/5m/10m/15m/30m apart.
#     Hammering an API that's down neither helps nor keeps the transcript readable.
#   - The login behind the turn expired: no reset and no retry clears that, so
#     the turn stops and its message carries a sign-in button — and the work is
#     remembered, so signing back in resumes it (resume_after_login, below).
#   - Claude crashed while the bridge stays up (API drop, OOM, CLI failure), or
#     the RUN_TIMEOUT watchdog killed a run still doing real work: resume the
#     session right here with a nudge. Consecutive failures are capped per
#     session — a completed turn resets the cap — so a session whose resume
#     itself keeps dying (or keeps timing out) can't burn tokens in a loop. That
#     cap, not the watchdog, is the runaway-cost brake.
# Only a user Stop (job.interrupted) is never auto-resumed.

RESUME_NUDGE = (
    "⏮ Your previous turn was cut off by an error — not by the user. "
    "Review your recent transcript and continue exactly where you left off; "
    "finish the task you were doing. Don't start over.")
TIMEOUT_NUDGE = (
    "⏮ Your previous turn was cut off by the bridge's per-turn time cap — not by "
    "the user. Review your recent transcript and continue exactly where you left "
    "off; finish the task you were doing. Don't start over.")
AUTO_RESUME_MAX = 5                 # consecutive dead turns before giving up
_resume_fails: dict[str, int] = {}  # session id -> consecutive error-ended turns


def _resumable(job: "Job", sess: "dict | None") -> bool:
    """True when a dead session can actually be --resume'd. claude_session_id is
    minted before the spawn now (see _claim_session_id), so its presence alone no
    longer proves a transcript exists: either this run reached init (job.session_id
    came back on an event), or the id predates this run (not job.new_session)."""
    if not (sess or {}).get("claude_session_id"):
        return False
    return bool(job.session_id) or not job.new_session


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
        limits.note_ok(sid)                      # ...and closes any limit episode
        return False
    if job.status != "error" or job.interrupted:
        return False
    if not config.AUTO_RESUME or state.shutting_down:
        return False                              # shutdown → boot recovery's job
    if limits.is_limit_error(job.result or job.error_msg):
        # Usage window exhausted: an immediate resume would just fail again.
        # Park the session; limits fires it back up when the limit resets.
        sess = store.get_session(sid)
        if not _resumable(job, sess):
            return False                          # died before init — nothing to resume
        d = limits.defer(sid, job.chat_id, cwd, model, effort,
                         slot=job.account_slot)
        if d is None:
            return False                          # kept failing past resets — stay stopped
        when, first = d
        # Parked (the safety net). Now see whether the fallback ladder can do
        # better than waiting: another account, or a free agent. A taken rung
        # unparks the session and announces itself, so we stay quiet then.
        if ladder.escalate(sess, job.chat_id, dead_slot=job.account_slot,
                           model=model, effort=effort):
            return True
        if first:
            _notify(job.chat_id,
                    f"⏳ Claude usage limit hit — {_session_label(sid)} is paused and "
                    f"will auto-resume when the limit resets (~{limits.when_str(when)}).",
                    _session_kb(job.chat_id, sid))
        return True
    if limits.is_server_error(job.result or job.error_msg):
        # Anthropic's side blew up: retry, but spaced out along the ladder.
        sess = store.get_session(sid)
        if not _resumable(job, sess):
            return False                          # died before init — nothing to resume
        d = limits.defer_server(sid, job.chat_id, cwd, model, effort,
                                slot=job.account_slot)
        if d is None:
            return False                          # ladder exhausted — stay stopped
        when, attempt = d
        _notify(job.chat_id,
                f"⚠️ Claude API error — retrying {_session_label(sid)} "
                f"{limits.wait_str(when)} "
                f"(attempt {attempt}/{len(limits.SERVER_BACKOFF)}).")
        return True
    if limits.is_auth_error(job.result or job.error_msg):
        # The login behind this turn is dead. Resuming would re-send the same
        # prompt to the same expired token and fail identically, five times
        # over, so stop and hand back the way back in instead.
        _auth_stop(job.chat_id, sid, job.account_slot, cwd, model, effort)
        return False
    if limits.is_context_error(job.result or job.error_msg):
        # The transcript no longer fits the window. A resume resends the same
        # too-long context, so every retry below fails identically at full turn
        # price. Stop and hand it back.
        _notify(job.chat_id,
                f"🧱 {_session_label(sid)} ran out of context window. "
                f"Run /compact in it, or start a fresh session.",
                _session_kb(job.chat_id, sid, "🛠 Open session"))
        return False
    fails = _resume_fails.get(sid, 0) + 1
    _resume_fails[sid] = fails
    if fails > AUTO_RESUME_MAX:
        return False                              # crash/timeout-looping — stay stopped
    sess = store.get_session(sid)
    if not sess or not sess.get("claude_session_id"):
        return False                              # died before init — nothing to resume
    try:
        job2 = start_streaming_job(
            job.chat_id, TIMEOUT_NUDGE if job.timed_out else RESUME_NUDGE, [],
            project=cwd, session_id=sid, model=model, effort=effort)
    except Exception as e:  # noqa: BLE001
        print(f"[auto-resume] failed for {sid}: {e}", file=sys.stderr)
        return False
    if job2 is None:
        return False                              # slot taken (e.g. the queue advanced)
    if job.timed_out:
        _notify(job.chat_id, f"⏱️ The turn hit the {config.RUN_TIMEOUT // 60}-min cap "
                             f"— resuming {_session_label(sid)}.")
    else:
        _notify(job.chat_id, f"🔄 The turn was interrupted by an error "
                             f"— resuming {_session_label(sid)}.")
    return True


# ---------------------------------------------------------------------------
# Dead login: stop, and hand back the way in
# ---------------------------------------------------------------------------
# An expired OAuth session is neither a wait nor a retry — no reset clears it
# and a resume re-sends the same prompt to the same dead token — so the turn
# stops and its message carries a sign-in button. The turn is remembered per
# account slot, so accounts.submit_login_code picks the work back up the moment
# the login lands.

AUTH_NUDGE = (
    "⏮ Your previous turn was cut off because the Claude login had expired — "
    "not by the user. It is signed in again. Review your recent transcript and "
    "continue exactly where you left off; finish the task you were doing. "
    "Don't start over.")

_auth_dead: dict[int, dict] = {}      # account slot -> the turn its dead login killed


def _auth_kb(chat_id: int | None, slot: int) -> dict | None:
    """One button, the only one that helps: start the sign-in for that account.
    Private chats only — same reason panel_kb bails in a group."""
    if not chat_id or chat_id <= 0:
        return None
    return {"inline_keyboard": [[{"text": "🔐 Log in to Claude",
                                  "callback_data": f"re:{slot}"}]]}


def _auth_stop(chat_id: int | None, sid: str | None, slot: int | None,
               cwd: str | None = None, model: str | None = None,
               effort: str | None = None, reply: bool = False) -> None:
    """Report a turn its login killed, and remember it for the sign-in to resume.

    reply=True when this message IS the answer to a prompt sent in the chat (the
    bot path): it goes out whether or not pushes are enabled, because there is
    no other surface it would show up on."""
    slot = int(slot or accounts.DEFAULT_SLOT)
    if sid and chat_id:
        _auth_dead[slot] = {"sid": sid, "chat_id": chat_id, "cwd": cwd,
                            "model": model, "effort": effort, "slot": slot}
    text = (f"🔐 Claude's login has expired — {_session_label(sid)} is stopped. "
            "Sign in again and it picks up where it left off.")
    if reply and chat_id:
        send(chat_id, text, _auth_kb(chat_id, slot))
    else:
        _notify(chat_id, text, _auth_kb(chat_id, slot))


def resume_after_login(slot: "int | None") -> bool:
    """A sign-in landed (bridge/accounts.py calls this): resume the turn that
    slot's dead login killed. Returns whether a resume actually started."""
    e = _auth_dead.pop(int(slot or accounts.DEFAULT_SLOT), None)
    if not e or not config.AUTO_RESUME:
        return False
    sess = store.get_session(e["sid"])
    if not sess or not sess.get("claude_session_id"):
        return False                              # died before init — nothing to resume
    try:
        job = start_streaming_job(e["chat_id"], AUTH_NUDGE, [], project=e["cwd"],
                                  session_id=e["sid"], model=e["model"],
                                  effort=e["effort"], account_slot=e["slot"])
    except Exception as ex:  # noqa: BLE001
        print(f"[reauth] resume failed for {e['sid']}: {ex}", file=sys.stderr)
        return False
    if job is None:
        return False                              # slot taken — the user moved on
    _notify(e["chat_id"], f"🔄 Signed in — resuming {_session_label(e['sid'])}.")
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
    the tool result (we feed it via a `deny` whose message is the answer).
    An answer may carry free-text `notes` instead of / alongside its labels —
    the escape hatch for when none of the prepared options fit."""
    by_header = {a.get("header"): a for a in answers if isinstance(a, dict)}
    parts: list[str] = []
    for q in questions:
        header = q.get("header") or q.get("question") or ""
        a = by_header.get(header)
        if a is None and len(answers) == 1 and len(questions) == 1:
            a = answers[0] if isinstance(answers[0], dict) else None
        labels = (a or {}).get("labels") or []
        notes = ((a or {}).get("notes") or "").strip()
        if labels and notes:
            parts.append(f'For "{header}": {", ".join(labels)} — note: {notes}')
        elif labels:
            parts.append(f'For "{header}": {", ".join(labels)}')
        elif notes:
            parts.append(f'For "{header}": none of the options — {notes}')
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


def _ctx_of(usage: dict) -> "int | None":
    """How full the context window was for the request that produced this message:
    fresh input + what was read from cache + what was just written to it.

    The *last* assistant message's figure is the window fill. Summing this across
    a turn's messages (as transcript_jsonl does, deliberately) measures spend
    instead, and reads an order of magnitude high as a meter."""
    if not isinstance(usage, dict):
        return None
    n = ((usage.get("input_tokens") or 0)
         + (usage.get("cache_read_input_tokens") or 0)
         + (usage.get("cache_creation_input_tokens") or 0))
    return n or None


_USAGE_KEYS = (("in", "input_tokens"), ("out", "output_tokens"),
               ("cache_w", "cache_creation_input_tokens"),
               ("cache_r", "cache_read_input_tokens"))


def _add_usage(job: "Job", usage: dict) -> None:
    """Add one message's usage to the turn's running total. Summed, not
    last-wins: the last message's figure is how full the window was, the sum is
    what the turn spent. Both are wanted, for different readouts."""
    if not isinstance(usage, dict) or not any(usage.get(k) for _, k in _USAGE_KEYS):
        return
    acc = job.tokens or {key: 0 for key, _ in _USAGE_KEYS}
    for key, src in _USAGE_KEYS:
        acc[key] += usage.get(src) or 0
    job.tokens = acc
    # Flushed per message, not only in the turn's finally: SPEND polls while the
    # turn runs, and a turn accounted only once it's over reads as "unknown" for
    # exactly as long as anyone would be watching it.
    if job.store_session_id:
        store.set_turn_tokens(job.id, acc)


# Longest log line kept — a debugging window rather than an archive (see
# inspector.MAX_ENTRIES).
_LOG_MAX = 4000
# Hooks get a tighter cap than that: a SessionStart hook injects kilobytes of
# preamble, identically, on every turn — the row exists to say what fired and
# roughly what it said, and the injected text is already in the model's context.
# ponytail: one flat cap. If a blocking hook's reason ever gets cut, give the
# failures _LOG_MAX and keep this for the ones that succeeded.
_HOOK_MAX = 800
# Stderr lines journalled per turn. A child that spews would otherwise put one
# store row and one SSE frame on the wire per line; the fatal-error path still
# reads its own 50-line tail regardless.
_STDERR_LOG_MAX = 40


def _hook_log(job: Job, d: dict):
    """A hook that said something or failed. Hooks fire on nearly every tool, so
    one that ran clean and silent is noise — what's worth a row is the context it
    injected, the reason it blocked, or the way it broke."""
    out = (d.get("stdout") or d.get("output") or "").strip()
    err = (d.get("stderr") or "").strip()
    code = d.get("exit_code") or 0
    bad = bool(code) or d.get("outcome") not in (None, "success")
    if not (out or err or bad):
        return
    body = "\n".join(x for x in (out, err) if x) or f"exit {code}"
    job.add({"type": "log", "src": "hook",
             "label": d.get("hook_name") or d.get("hook_event") or "hook",
             "text": body[:_HOOK_MAX], "error": bad})


def _note_work_cwd(job: "Job", command: str) -> None:
    """Follow the session's shell when it walks into a worktree.

    `cd ~/projects/.worktrees/x/feat-y && git commit` is how an agent works a
    feature branch, and claude's own cwd never moves with it — so the session
    row keeps naming the checkout's branch while every commit lands on another
    one. Recording the destination lets the surfaces label the session with the
    branch it is actually on.

    Deliberately narrow: only a literal `cd` to a path git already lists as a
    worktree of this session's repo counts. A `cd /tmp`, a relative `cd`, or a
    command that merely reads a worktree leaves the label alone — a wrong branch
    on the card is worse than a stale one. Best-effort; never raises into the
    turn."""
    if not (job.store_session_id and job.cwd):
        return
    try:
        dest = git.shell_cd_target(command)
        if not dest:
            return
        if os.path.realpath(dest) == os.path.realpath(job.cwd):
            new = None                       # walked back home
        elif git.is_worktree_of(job.cwd, dest):
            new = dest
        else:
            return
        if new != job.work_cwd:
            job.work_cwd = new
            store.set_work_cwd(job.store_session_id, new)
    except Exception:  # noqa: BLE001 - a label is never worth failing a turn over
        pass


def _handle_event(job: Job, d: dict):
    t = d.get("type")
    job.boot = None          # the child is talking; nothing is loading any more
    sid = d.get("session_id")
    if sid and sid != job.session_id:
        job.session_id = sid
        # Normally a no-op: we mint the id and persist it before the spawn, so the
        # store row is already linked when the scanner first sees the JSONL. Kept
        # for the case where claude reports an id other than the one we asked for
        # (e.g. --session-id rejected on an older CLI) — the row must follow it.
        if job.store_session_id:
            store.set_claude_session_id(job.store_session_id, sid)
    if t == "assistant":
        usage = d.get("message", {}).get("usage") or {}
        ctx = _ctx_of(usage)
        if ctx:
            job.ctx_tokens = ctx      # last one wins; persisted at turn end
        _add_usage(job, usage)        # and the running total; also at turn end
        for b in d.get("message", {}).get("content", []):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text":
                txt = (b.get("text") or "").strip()
                if txt:
                    job.texts.append(txt)
                    job.add({"type": "text", "text": txt})
            elif b.get("type") == "thinking":
                # The reasoning text rides the stream in full (and lands on disk
                # the same way) — Claude Code just never prints it. Carry it, shut
                # by default in both frontends, alongside the wall-clock gap since
                # the last thing it did. A redacted block (text stripped, only a
                # signature) still earns the bare marker it always got, provided
                # the pause was long enough to have been sat through.
                gap = int((time.time() - job.last_at) * 1000)
                txt = (b.get("thinking") or "").strip()
                if txt or gap >= transcript_jsonl.THINK_MIN_MS:
                    ev = {"type": "thinking", "ms": gap}
                    if txt:
                        ev["text"] = txt
                    job.add(ev)
            elif b.get("type") == "tool_use":
                name = b.get("name", "tool")
                inp = b.get("input", {})
                if name == "Bash":
                    _note_work_cwd(job, inp.get("command") or "")
                job.open_tools[b.get("id")] = (name, time.time())
                job.add({"type": "tool", "name": name, "id": b.get("id"),
                         "summary": _summarize_tool(name, inp)})
    elif t == "user":
        for b in d.get("message", {}).get("content", []):
            if isinstance(b, dict) and b.get("type") == "tool_result":
                rid = b.get("tool_use_id")
                name, t0 = job.open_tools.pop(rid, (None, 0.0))
                ms = int((time.time() - t0) * 1000) if t0 else 0
                ev = transcript_jsonl.tool_done(
                    rid, name, ms, b, d.get("tool_use_result"))
                imgs = _save_result_images(job.id, rid, b.get("content"))
                if imgs:
                    ev["images"] = imgs
                job.add(ev)
    elif t == "system" and d.get("subtype") == "hook_response":
        _hook_log(job, d)
    elif t == "result":
        job.result = d.get("result", "") or d.get("error", "")
        job.cost = d.get("total_cost_usd")
        if d.get("session_id"):
            job.session_id = d["session_id"]
        # An interrupted turn may report is_error; treat it as a clean stop.
        job.status = "error" if (d.get("is_error") and not job.interrupted) else "done"
        job.elapsed = int(time.time() - job.started)
        job.add({"type": "result", "result": job.result, "cost": job.cost,
                 "elapsed": job.elapsed, "is_error": job.status == "error"})


_MCP_IMG_MAX = 4                    # images kept per tool result
_MCP_IMG_BYTES = 8 * 1024 * 1024    # per image, decoded


def _save_result_images(job_id: str, rid: str, content) -> list[str]:
    """Images a tool handed back (Playwright, chrome-devtools, Figma…), written
    next to the run's uploads so the transcript can show them instead of the word
    "image". Paths, not base64: a screenshot is a megabyte, and the event goes
    into the store and down every SSE stream. Best-effort — a tool result must
    never fail because its screenshot didn't land."""
    if not isinstance(content, list):
        return []
    out: list[str] = []
    for i, b in enumerate(content):
        if len(out) >= _MCP_IMG_MAX or not isinstance(b, dict):
            continue
        if b.get("type") != "image":
            continue
        src = b.get("source") or {}
        if src.get("type") != "base64" or not isinstance(src.get("data"), str):
            continue
        ext = mimetypes.guess_extension(src.get("media_type") or "") or ".png"
        try:
            raw = base64.b64decode(src["data"], validate=True)
            if not raw or len(raw) > _MCP_IMG_BYTES:
                continue
            d = os.path.join(config.UPLOAD_DIR, job_id)
            os.makedirs(d, exist_ok=True)
            fp = os.path.join(d, f"mcp-{rid or 'tool'}-{i}{ext}")
            with open(fp, "wb") as f:
                f.write(raw)
            out.append(fp)
        except (ValueError, OSError) as e:
            print(f"[runner] tool image dropped: {e}", file=sys.stderr)
    return out


def _cleanup_uploads(job_id: str):
    d = os.path.join(config.UPLOAD_DIR, job_id)
    shutil.rmtree(d, ignore_errors=True)


def _prune_uploads():
    """A finished run leaves its screenshots on disk — the turn is in the
    transcript and the dashboard serves them back (/local/attachment) — so
    bound the dir by age instead of deleting each run's images on the spot."""
    cutoff = time.time() - config.UPLOAD_KEEP_DAYS * 86400
    try:
        with os.scandir(config.UPLOAD_DIR) as it:
            for e in it:
                if e.is_dir() and e.stat().st_mtime < cutoff:
                    shutil.rmtree(e.path, ignore_errors=True)
    except OSError:
        pass


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


def _consume_free_agent(job: Job, prompt: str, cwd: str) -> None:
    """Run one turn on a fallback-ladder free agent instead of Claude.

    Blocking, not streamed: opencode is a different runtime with its own event
    schema, so its stdout is captured and reported as the turn's single
    assistant message. Everything after this (journaling, finish_turn, the
    notification) is _run_streaming's shared finally block."""
    from bridge import freeagent
    want = (job.runtime or "").split(":", 1)[-1]
    provider = next((p for p in freeagent.available()
                     if p["provider"] == want), None)
    if provider is None:
        job.error_msg = (f"free agent {want!r} is not configured any more "
                         f"(its API key or model went away)")
        job.add({"type": "error", "message": job.error_msg})
        job.status = "error"
        return
    # No --session: job.resume_id is a *Claude* session id and means nothing to
    # opencode. Continuity travels in the briefing prompt instead.
    cmd = freeagent.build_cmd(prompt, provider, None, cwd)
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                              env=freeagent.run_env(),
                              timeout=config.RUN_TIMEOUT)
    except FileNotFoundError:
        job.error_msg = "`opencode` not found on PATH."
        job.add({"type": "error", "message": job.error_msg})
        job.status = "error"
        return
    except subprocess.TimeoutExpired:
        job.timed_out = True
        job.error_msg = "free agent timed out"
        job.add({"type": "error", "message": job.error_msg})
        job.status = "error"
        return
    text = (proc.stdout or "").strip()
    if proc.returncode != 0:
        job.error_msg = (proc.stderr or "").strip() or f"opencode exited {proc.returncode}"
        job.add({"type": "error", "message": job.error_msg})
        job.status = "error"
        return
    if text:
        job.texts.append(text)
        job.add({"type": "text", "text": text})
    job.result = text
    job.status = "done"
    job.elapsed = int(time.time() - job.started)
    job.add({"type": "result", "result": job.result,
             "cost": job.cost, "elapsed": job.elapsed})


def _run_streaming(job: Job, prompt: str, image_paths: list[str], cwd: str,
                   model: str | None = None, effort: str | None = None,
                   permission_mode: str | None = None, ponytail: str | None = None):
    proc = None
    job.cwd = cwd
    try:
        if (job.runtime or "").startswith("opencode:"):
            _consume_free_agent(job, prompt, cwd)
            return
        full_prompt = _with_images(prompt, image_paths)
        # The gap before the first token is two waits, and an empty stream makes
        # both read as a hang. Name whichever one we are actually in: the health
        # check only blocks while the cache is still cold (see toolsets.warm).
        from bridge import toolsets  # local: toolsets imports runner
        if job.store_session_id and not toolsets.ready():
            job.boot = "checking configured MCP servers"
        cmd = _base_cmd(full_prompt, job.chat_id, stream=True, interactive=True,
                        model=model, effort=effort, permission_mode=permission_mode,
                        claude_session_id=job.resume_id, cwd=cwd,
                        new_session=job.new_session,
                        disabled_tools=store.get_disabled_tools(job.store_session_id)
                        if job.store_session_id else None,
                        autocompact=store.get_autocompact(job.store_session_id)
                        if job.store_session_id else None,
                        flow_section=flow.section_for(
                            store.get_session(job.store_session_id))
                        if job.store_session_id else "")
        try:
            proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, bufsize=1,
                                    env=_run_env(ponytail, job.account_slot))
        except FileNotFoundError:
            job.add({"type": "error", "message": "`claude` not found on PATH."})
            job.status = "error"
            return
        job.proc = proc
        # Claude is up but still building its context — connecting MCP servers and
        # loading the transcript — which is most of the wait on a resumed session.
        job.boot = "starting Claude"

        # Drain stderr continuously: a child that writes more than the OS pipe
        # buffer mid-run would otherwise block against our unread pipe while we
        # block on stdout — deadlock. Keep a tail for error reporting, and put the
        # first lines in the transcript: normally the child says nothing here, so
        # anything it does say (a dying MCP server, --debug output) is the reason
        # a turn went strange, and it used to be visible only if the run died.
        stderr_tail: list[str] = []
        stderr_logged = 0

        def _drain_stderr():
            nonlocal stderr_logged
            try:
                for eline in proc.stderr:
                    stderr_tail.append(eline)
                    if len(stderr_tail) > 50:
                        del stderr_tail[:-50]
                    if stderr_logged < _STDERR_LOG_MAX and eline.strip():
                        stderr_logged += 1
                        job.add({"type": "log", "src": "stderr",
                                 "text": eline.rstrip()[:_LOG_MAX]})
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
            job.error_msg = msg
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
            if job.ctx_tokens:
                # Also on a killed/timed-out turn: the last request's fill is still
                # what the next one resumes into.
                store.set_ctx_tokens(job.store_session_id, job.ctx_tokens)
            # Also on a killed turn: what it spent before dying was still spent,
            # and a capped turn is exactly the one worth accounting for.
            store.set_turn_tokens(job.id, job.tokens)
            if not restart_killed:   # else leave 'running' for boot recovery to resume
                store.finish_turn(job.id, job.status, job.cost, job.elapsed)
        job.clear_pending()
        job.close_stdin()
        _prune_uploads()
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
        if not resumed and not restart_killed:
            # An active goal queues its own next turn. After auto-resume, so a
            # limit-parked turn is picked up by the ladder rather than raced by
            # a nudge that would run against the same exhausted account.
            from bridge import goals  # local import: runner<->* cycle
            resumed = goals.continue_after_turn(job, model, effort) or resumed
        # A typed session settles its turn: card out, stage stamped, ungated
        # moves applied. Independent of resumption, so it runs either way.
        flow.after_turn(job, model, effort)
        if not job.interrupted and job.status == "done" and job.store_session_id:
            _graph_refresh_after_turn(job.chat_id, cwd)
        if not job.interrupted and not resumed and not restart_killed:
            # Owns the ping: "finished" is a lie for a turn that ended asking you
            # something, so what it says depends on how the closing reads.
            from bridge import tailstate  # local import: runner<->tailstate cycle
            tailstate.kick(job, cwd)
        if job.store_session_id and job.status == "done":
            _sess = store.get_session(job.store_session_id)
            if _sess:
                from bridge import learn, titler  # local import: runner<->* cycle
                titler.kick(job.chat_id, _sess, job.id)   # retry if the start call missed
                learn.kick(job.chat_id, _sess, job.id)


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
    # A stage may tighten or loosen the posture for its own turns (FIX only
    # accepts edits after its diagnosis was approved) — that is what gives a
    # gate teeth rather than just a prompt asking nicely.
    return session, cwd, flow.permission_for(
        session, permission_mode or session.get("permission_mode"))


def start_streaming_job(chat_id: int, prompt: str, image_paths: list[str],
                        project: str | None = None, job_id: str | None = None,
                        model: str | None = None, effort: str | None = None,
                        permission_mode: str | None = None,
                        session_id: str | None = None,
                        origin: str | None = None, ponytail: str | None = None,
                        account_slot: int | None = None,
                        runtime: str | None = None) -> Job | None:
    """Acquire the busy lock and start a streaming run. Returns None if busy.

    Resolves (or creates) the store session and runs it in the session's own cwd
    with its own permission posture; --resume continuity comes from that session's
    claude_session_id. `origin` marks where a newly-created session started.

    account_slot picks which Claude login runs the turn (None = the ambient one);
    runtime is set instead when a fallback-ladder free agent takes over. Both are
    recorded on the turn so the transcript shows what produced it.

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
        job.resume_id, job.new_session, job.fork = _claim_session_id(
            session["id"], session["claude_session_id"])
        job.account_slot = account_slot
        if runtime is None and account_slot and account_slot != accounts.DEFAULT_SLOT:
            runtime = f"claude:{account_slot}"
        job.runtime = runtime
        _register(job)
        store.start_turn(session["id"], job.id, prompt,
                         [os.path.basename(p) for p in image_paths], model=model,
                         runtime=runtime, sha=git.head_sha(cwd))
        from bridge import titler  # local import: runner<->* cycle
        titler.kick(chat_id, session, job.id)
        _ensure_journal_thread()
        threading.Thread(target=_run_streaming,
                         args=(job, prompt, image_paths, cwd, model, effort, perm,
                               ponytail),
                         daemon=True).start()
        return job
    except BaseException:
        state.release_run(session["id"])
        raise
