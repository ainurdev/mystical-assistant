"""Claude Code runner.

Two entry points share the same auth/session/permission setup:
  - run_blocking()  -> one-shot JSON result (internal one-shots: titles, cards, digests)
  - start_streaming_job() -> a Job whose events stream in live (every surface's turns:
    Mini App, dashboard, and the bot chat through bridge/tglive.py)

Each run claims its session's slot in state's per-session run registry, so two
turns never hit the same Claude session at once, but different sessions run
concurrently.

A session whose profile names another agent runs its turn through AcpJob and
bridge/acp.py instead of a claude child: same events, cards, Stop and
watchdog, its own session id in sessions.agent_session_id, and none of the
Claude-only paths (steer, auto-resume, the bot's blocking run).
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
import tempfile
import threading
import time
import uuid

from bridge import (accounts, acp, acp_agents, agents, aifeatures, config, devserver,
                    git, inspector, integrations, ladder, limits, machine, native_activity, notices,
                    profiles, pubsub, relevance, state, store, team, tgask, tgtopics,
                    transcript_jsonl, waits)
from bridge.browser import rel
from bridge.telegram import panel_kb, send


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


# Agent (ACP) sessions get this on their first prompt; ACP has no system prompt.
_MYSTICAL_NOTE = (
    "Files this project needs for Mystical but git should never see — "
    "screenshots, recordings, scratch scripts, drafts, reports — go in "
    ".mystical/ in the project root. It ignores itself "
    "(.mystical/.gitignore is `*`), so never add .mystical to the project's "
    ".gitignore and never commit anything from it.")

_LOG_NOTE = (
    "To run this project (dev server, `npm run dev`, anything long-lived the "
    "human will look at), use the Run tool — not Bash. The bridge owns what Run "
    "starts, so it outlives the turn and the human can follow its port and logs "
    "in the dashboard; a background Bash process is invisible to them. Its "
    f"output is also logged to {devserver.DEV_LOG_REL} in the project root — "
    "read that file (e.g. tail it) to inspect dev-server logs.\n\n"
    + _MYSTICAL_NOTE)

# A failed push stays failed in its session: retried, a denied one reads as a
# bypass to the permission check. A new session on the branch starts from the
# human's own ask — the dashboard's push buttons open one, git's message drafted.
_PUSH_NOTE = (
    "If a git push is denied (a permission check refuses it) or rejected (the "
    "remote refuses it), don't retry it and don't route around it with another "
    "command, tool or API. Say what failed, in git's words, and suggest the "
    "human handle it in a new session on that branch: Mystical's dashboard "
    "opens one from its push buttons, with the failure as an unsent draft.")

# Told to every interactive run of a session whose repo is on a Rivendell task
# board (_rivendell_note_for): the work gets a task, the task's key rides the
# branch and the PR, and Rivendell links the PR by that key on its own. The ask
# waits for the push (docs/superpowers/specs/rivendell-task-check.md): a card at
# the start stopped the turn before any work while you were away, and its title
# was a guess from one line. The card's shape is fixed here because the
# dashboard dresses a "Task" card (QuestionCard) and the bridge reads its answer
# (taskcheck.answer_state); _push_gate holds a push that skipped it.
_RIVENDELL_NOTE = (
    "This repo's work is tracked on a Rivendell task board. Before you change code for a "
    "piece of work, call mcp__goals__ListRivendellTasks (a deferred tool: load it with "
    "ToolSearch first). If an open task covers the work, carry its key without asking: in "
    "the name of a branch you create, in the repo's own branch style (e.g. "
    "fix/NRA-61-login-redirect), in your commit messages, and in the PR title, which is how "
    "Rivendell links the PR. If none covers it, don't ask yet: do the work. Ask once, right "
    "before the first git push or gh pr create of work that carries no key, with one "
    "AskUserQuestion card whose header is \"Task\". Its question says that nothing open on "
    "<board> ▸ <list> (as the tool reports them) covers this push and asks whether to track it "
    "as a task, then on a second line: ⎇ <branch> · <n> commits · <git diff --shortstat of "
    "what the push sends>. Its options, the one you recommend first with \" (Recommended)\" at "
    "the end of its label: Create “<a title written from what the work did>” (description: "
    "New task in <list>. Its key goes in the branch and the PR title.); "
    "It's <KEY> <its title>, only for an open task that may cover it (description: The closest "
    "open task (<column>). Its key goes in the PR title.); Not a task (description: Push as "
    "is. This branch won't ask again.). Recommend Not a task for a tiny change (a version "
    "bump, a typo), the open task when it likely covers the work, and Create otherwise. On "
    "Create, call mcp__goals__CreateRivendellTask with that title. On Create or It's <KEY>, "
    "rename the branch to carry the key if it was never pushed (never rename a pushed one) "
    "and put the key in the PR title. On Not a task, push as is. A push that carries no key "
    "is held back once per branch until you have asked. Questions, reviews and research need "
    "no task.")


def _ensure_mystical(cwd: "str | None") -> None:
    """The note promises .mystical/; make it exist. Repos only, not every cwd."""
    if cwd and os.path.exists(os.path.join(cwd, ".git")):
        try:
            devserver.mystical_dir(cwd)
        except OSError:
            pass


def _graph_pack_for(chat_id: int, cwd: "str | None") -> str:
    """Graphify structure pack for injection. Best-effort: no graph, no module,
    any failure — empty string, never blocks a turn."""
    try:
        from bridge import graphmap
        return graphmap.graph_pack(cwd or state.project_dir(chat_id))
    except Exception:  # noqa: BLE001
        return ""


def _tasks_digest_for(project: "str | None", cwd: "str | None") -> str:
    """Tracker digest for injection (bridge/trackers.py). Same contract as the
    graph pack: best-effort, empty on anything, never blocks a turn past the
    2 s the digest itself allows. `project` is the session's rel — a worktree's
    cwd is not the project the link hangs off."""
    try:
        if not (integrations.installed("trackers") and aifeatures.enabled("tasks")):
            return ""
        from bridge import trackers
        return trackers.digest(project or rel(cwd or state.project_dir(0)))
    except Exception:  # noqa: BLE001
        return ""


def _dream_pack_for(chat_id: int, cwd: "str | None") -> str:
    """The repo's nightly digest for injection (bridge/dream.py). Same contract
    as the graph pack: best-effort, empty on anything, never blocks a turn."""
    try:
        from bridge import dream
        return dream.pack(cwd or state.project_dir(chat_id))
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


# Told to every run while the AI BROWSER is hidden: the MCPs are headless by
# flag, but a run can still `open` a URL or launch its own headed Chrome from
# Bash, and that window lands in front of the user.
_HIDDEN_BROWSER_NOTE = (
    "Browser work is hidden here: the Playwright and chrome-devtools MCP servers run "
    "headless (SETTINGS → SYSTEM → BROWSER). Never open a visible browser on this "
    "machine — no `open <url>`, no headed launches; the user is working in front of it.")


def _compose_system_prompt(graph: str = "", rivendell: str = "") -> str:
    """ASK prompt + the dev-log and push notes (+ the Rivendell note for a
    session that gets it), then the graph pack.

    Ordering does NOT protect the cache: the whole string lands in
    --append-system-prompt, which sits after the last cache breakpoint, so any
    change re-writes all of it. What protects the cache is only sending the
    volatile packs once per session — see _base_cmd."""
    parts = [p for p in (config.ASK_SYSTEM_PROMPT.strip(), _LOG_NOTE, _PUSH_NOTE,
                         _HIDDEN_BROWSER_NOTE if config.AI_BROWSER_HEADLESS else "",
                         rivendell, graph.strip()) if p]
    return "\n\n".join(parts)


# Claude session ids we've already injected the graph pack into. The pack
# are rebuilt from live state, so re-sending them each turn silently changes
# --append-system-prompt and invalidates the cached prefix (measured: one added
# pack line moved ~11k tokens from cache_read to cache_create, a ~12x price step
# on that segment, and on a resumed session the invalidated span is the whole
# transcript). Once per session is also all that's useful: turn 1's pack is still
# in context. Bounded by sessions-since-boot.
_packed_sessions: set[str] = set()

# claude session id -> whether its runs carry the Rivendell note, decided at the
# session's first run and kept: a board linked later, or a Rivendell that was
# down that moment, must not re-write a running session's appended prompt (the
# same cache cost as above). Bounded by sessions-since-boot, like the set above.
_rivendell_notes: dict[str, bool] = {}


def _rivendell_note_for(chat_id: int, claude_session_id: str, cwd: "str | None") -> str:
    """The Rivendell note for an interactive run of this session, or "". The
    RIVENDELL TASKS switch is read every run, since a switch applies to the next
    turn. Whether the repo is on a board is asked once (rivendell.on_board, at
    most 2 s) and kept. Rivendell's own runs never get the note: they run
    unattended, so nobody is there to answer its card."""
    if not aifeatures.enabled("rvtrack"):
        return ""
    if claude_session_id not in _rivendell_notes:
        try:
            from bridge import rivendell
            row = store.get_by_claude_session_id(claude_session_id) or {}
            _rivendell_notes[claude_session_id] = bool(
                not str(row.get("origin") or "").startswith("rivendell")
                and rivendell.on_board(cwd or state.project_dir(chat_id)))
        except Exception:  # noqa: BLE001 — the note never blocks a turn
            _rivendell_notes[claude_session_id] = False
    return _RIVENDELL_NOTE if _rivendell_notes[claude_session_id] else ""


def _push_gate(cwd: str) -> "dict | None":
    """--settings hooks for a run that carries the Rivendell note: bridge/taskcheck.py
    as a PreToolUse hook on Bash, which holds back a push from this repo that
    names no task, once per branch. Inline JSON: it holds paths and key prefixes,
    no secret. None when `cwd` isn't in a git repo, since there is nothing to gate."""
    from bridge import rivendell, taskcheck
    try:
        home = taskcheck.repo_id(cwd)
        prefixes = ",".join(rivendell.key_prefixes(cwd)) if home else ""
    except Exception:  # noqa: BLE001 — the gate never blocks a turn
        return None
    if not home:
        return None
    hook = " ".join(shlex.quote(a) for a in (
        sys.executable, "-I", os.path.join(_REPO_ROOT, "bridge", "taskcheck.py"), home, prefixes))
    return {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": hook}]}]}


def _one_settings(cmd: list[str]) -> list[str]:
    """claude keeps only the last --settings it is given, so every one a run
    collects (the Stop hook, a push gate, a tracker's ask rule in extra_args)
    goes in as one: objects merged key by key, lists joined."""
    def merge(a, b):
        if isinstance(a, dict) and isinstance(b, dict):
            return {**a, **{k: merge(a[k], v) if k in a else v for k, v in b.items()}}
        return a + b if isinstance(a, list) and isinstance(b, list) else b
    out, merged, i = [], None, 0
    while i < len(cmd):
        if cmd[i] == "--settings" and i + 1 < len(cmd):
            try:
                val = json.loads(cmd[i + 1])
            except ValueError:          # a settings *file*: not ours to fold, pass it on
                val = None
            if isinstance(val, dict):
                merged = val if merged is None else merge(merged, val)
                i += 2
                continue
        out.append(cmd[i])
        i += 1
    return out if merged is None else out + ["--settings", json.dumps(merged)]


# --- ponytail (per-run code-minimalism intensity) ----------------------------
# The ponytail plugin's SessionStart hook reads PONYTAIL_DEFAULT_MODE from the
# child's env; absent means the plugin's own default (full). One env var is the
# whole integration — no tokens, no config writes, native sessions untouched.

_PONYTAIL_LEVELS = ("off", "lite", "full", "ultra")


def normalize_ponytail(level) -> "str | None":
    lv = str(level or "").strip().lower()
    return lv if lv in _PONYTAIL_LEVELS else None


def _run_env(ponytail: "str | None",
             account_slot: "int | None" = None) -> dict:
    """Env for the claude subprocess: the inherited env plus a run's ponytail
    intensity and Claude account. The account arrives as CLAUDE_CONFIG_DIR,
    which is the whole multi-account mechanism -- every turn is still the
    official binary, just pointed at one login's profile."""
    over = accounts.env_for(account_slot)
    # Once a turn's result is out, -p waits for its background agents only 10
    # min, then kills them mid-work and exits -- the report they were running
    # for never arrives. Without the ceiling it also waits forever for a
    # background shell (a dev server): _watchdog ends those turns.
    over["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"] = "0"
    # The host flag that tells the model AskUserQuestion options can carry a
    # `preview`; under -p it's off unless set. The cards draw an option's
    # preview images as that option's pictures (_adopt_preview_images).
    over["CLAUDE_CODE_QUESTION_PREVIEW_FORMAT"] = "markdown"
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
    """Path to the --mcp-config file for the bridge's own tool servers, plus any
    external servers this session left switched on. PYTHONPATH pins the repo root
    so `-m bridge.*` imports regardless of the run's cwd. Ours go in last: a
    user server named `goals` must not shadow the goal tools.

    A file, not the inline JSON it used to be: it carries the dashboard token and
    whatever the external servers authenticate with (a GitHub PAT or a Rivendell
    bearer in a header, a Railway key in an env block), and argv is
    world-readable (`ps`, /proc/<pid>/cmdline) where a 0600 file in a 0700 dir
    is the user's alone. One fresh dir per call, so concurrent runs never share
    a file; _run_streaming removes it once the child that read it is gone."""
    env = {"PYTHONPATH": _REPO_ROOT,
           "MYSTICAL_CLAUDE_SESSION_ID": claude_session_id,
           # The Run tool starts dev servers in the *bridge* process (its registry
           # is module state there), so it calls back over the dashboard's own
           # localhost API — same token any browser tab uses.
           "MYSTICAL_DASH": f"http://127.0.0.1:{config.DASH_PORT}",
           "MYSTICAL_DASH_TOKEN": config.DASH_TOKEN}
    d = tempfile.mkdtemp(prefix="mystical-mcp-")
    path = os.path.join(d, "mcp.json")
    try:
        # O_EXCL: created here at 0600, never written through something already there.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {
                **(extra or {}),
                "goals": {"command": sys.executable,
                          "args": ["-m", "bridge.goal_mcp"], "env": env},
                "verify": {"command": sys.executable,
                           "args": ["-m", "bridge.verify_mcp"], "env": env},
            }}, f)
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)   # half-written can already hold a token
        raise
    return path


# The flag each browser MCP takes for the three AI BROWSER settings (hidden,
# binary, profile folder), keyed by the package in its args rather than by its
# `claude mcp list` name, so a server someone renamed is still caught.
_BROWSER_MCP_FLAGS = {
    "@playwright/mcp": ("--headless", "--executable-path", "--user-data-dir"),
    "chrome-devtools-mcp": ("--headless", "--executablePath", "--userDataDir"),
}


def _with_browser(defn: dict) -> dict:
    """A server definition with the AI BROWSER settings appended as flags, when it
    is one of the two browser MCPs; anything else unchanged. A flag the user's own
    definition already carries is left to them — yargs would turn a repeated
    --userDataDir into a list."""
    args = list(defn.get("args") or [])
    flags = next((f for pkg, f in _BROWSER_MCP_FLAGS.items() if any(pkg in a for a in args)), None)
    if not flags:
        return defn
    own = {a.split("=", 1)[0] for a in args}
    headless, binary, profile = flags
    extra = [headless] if config.AI_BROWSER_HEADLESS and headless not in own else []
    if config.AI_BROWSER_EXECUTABLE and binary not in own:
        extra += [binary, config.AI_BROWSER_EXECUTABLE]
    if config.AI_BROWSER_PROFILE and profile not in own:
        extra += [profile, config.AI_BROWSER_PROFILE]
    return {**defn, "args": args + extra} if extra else defn


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
            extra[s["name"]] = _with_browser(defs[s["name"]])
        elif s.get("dir"):
            # Local to a different project: this cwd's claude couldn't load it
            # even without strict mode, so skipping it hides nothing.
            continue
        else:
            strict = False
    return extra, strict


def _with_mode(args: list[str], mode: "str | None") -> list[str]:
    """`args` (EXTRA_CLAUDE_ARGS) with `mode` in place of the permission flags
    they carry: --permission-mode in either spelling, and the
    --dangerously-skip-permissions that is Bypass by another name. No mode:
    unchanged."""
    if not mode:
        return args
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a == "--permission-mode":
            skip = True                  # and its value
        elif not (a.startswith("--permission-mode=") or a == "--dangerously-skip-permissions"):
            out.append(a)
    return out + ["--permission-mode", mode]


def _base_cmd(prompt: str, chat_id: int, *, stream: bool,
              interactive: bool = False, model: str | None = None,
              effort: str | None = None, permission_mode: str | None = None,
              claude_session_id: str | None = None, cwd: str | None = None,
              skip_pack: bool = False, new_session: bool = False,
              fork: bool = False, disabled_tools: list[str] | None = None,
              autocompact: str | None = None, project: str | None = None) -> list[str]:
    """Build the `claude` argv.

    interactive=True (Mini App chat) drives Claude over the stream-json control
    protocol: the prompt is delivered on stdin (not as an arg), permissions are
    routed back to us via `--permission-prompt-tool stdio`, and we run in an
    asking permission mode so tool use surfaces Allow/Deny cards. A one-shot
    stays non-interactive and keeps EXTRA_CLAUDE_ARGS — with the caller's mode,
    when it brings one, in place of their permission flag (_with_mode). The bot
    chat's turns are interactive and bring EXTRA_CLAUDE_ARGS' own (bridge/tglive.py).

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
        if os.getuid() != 0 or os.environ.get("IS_SANDBOX") == "1":
            # Bypass on offer, not on: this flag only permits a switch to
            # bypassPermissions. The mode above is what runs until the user
            # picks another mid-turn (Job.set_run_settings), and claude
            # 2.1.280 refuses that switch on a child launched without this
            # ("not launched with --dangerously-skip-permissions"). Only the
            # bridge writes this child's stdin, so only the settings routes
            # can use it. Not as root outside a sandbox: claude exits at
            # startup there (its own process.getuid() check, IS_SANDBOX=1
            # the opt-out), so the flag would fail every turn — a root
            # install just can't switch a running turn to Bypass.
            cmd.append("--allow-dangerously-skip-permissions")
        if claude_session_id and not skip_pack:
            # Goal + verify tools, on interactive runs only, alongside whichever
            # external servers this session left switched on — re-declared here
            # so --strict-mcp-config can drop everything else. Internal one-shots
            # below (an interactive one too: start_streaming_job's skip_pack)
            # still take MCP off entirely.
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
        # The task digest and the nightly digest ride the same once-per-session
        # gate: something that moved between turns must not re-write the
        # appended prompt.
        graph = "\n\n".join(p for p in (graph, _tasks_digest_for(project, cwd),
                                         _dream_pack_for(chat_id, cwd)) if p)
        if claude_session_id:
            _packed_sessions.add(claude_session_id)
    _ensure_mystical(cwd)
    # Only runs that get the goals server (below) can act on the note.
    rv_note = (_rivendell_note_for(chat_id, claude_session_id, cwd)
               if interactive and claude_session_id and not skip_pack else "")
    cmd += ["--append-system-prompt", _compose_system_prompt(graph, rv_note)]
    hooks = {}
    if interactive and not skip_pack:
        # bridge/askhook.py: options offered in prose go back once to be asked
        # as a card. Only where AskUserQuestion can be answered: the bot's
        # plain-text path has no permission host, and internal one-shots ask nobody.
        ask = " ".join(shlex.quote(a) for a in (
            sys.executable, "-I", os.path.join(_REPO_ROOT, "bridge", "askhook.py")))
        hooks["Stop"] = [{"hooks": [{"type": "command", "command": ask}]}]
    if rv_note:
        hooks.update(_push_gate(cwd or state.project_dir(chat_id)) or {})
    if hooks:
        cmd += ["--settings", json.dumps({"hooks": hooks})]
    if skip_pack and not (permission_mode and not interactive):
        # Internal one-shots (titler/commit-msg) are pure text transforms
        # whose prompts embed untrusted conversation text. No tools and no
        # EXTRA_CLAUDE_ARGS (acceptEdits!) — an agentic run here is an injection
        # vector: a first message like "scan the project" gets executed, not named.
        # --strict-mcp-config with no --mcp-config means no MCP servers at all:
        # free, since --tools "" already denies their tools, and it takes ~0.9s
        # off each one-shot (5.33s -> 4.45s, mean of 3). Several run per turn.
        cmd += ["--tools", "", "--strict-mcp-config"]
    elif not interactive and permission_mode and skip_pack:
        # An internal one-shot that must *read* the repo (the next-up scout).
        # Its own permission mode instead of EXTRA_CLAUDE_ARGS: 'plan' leaves the
        # read tools available and takes editing and shell off the table. Still an
        # internal one-shot, so it skips MCP for the same second it saves above.
        cmd += ["--permission-mode", permission_mode, "--strict-mcp-config"]
    elif not interactive:
        # A one-shot with tools: EXTRA_CLAUDE_ARGS, with the caller's mode, when
        # it brings one, in place of the permission flag those carry; the rest
        # (--add-dir, --allowedTools...) is still the user's.
        cmd += _with_mode(shlex.split(config.EXTRA_CLAUDE_ARGS), permission_mode)
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
# Blocking run (internal one-shots)
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
                 fork: bool = False, account_slot: "int | None" = None):
    cmd = _base_cmd(prompt, chat_id, stream=False, claude_session_id=resume_id,
                    cwd=cwd, model=model, skip_pack=skip_pack,
                    permission_mode=permission_mode, new_session=new_session,
                    fork=fork)
    timeout = timeout or config.RUN_TIMEOUT
    try:
        proc = subprocess.run(cmd, cwd=cwd or state.project_dir(chat_id), capture_output=True,
                              text=True, timeout=timeout, env=_run_env(ponytail, account_slot))
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


def adopt_uploads(job_id: str, paths: list[str] | None) -> list[str]:
    """Move files that arrived before their turn existed (a file sent to the bot)
    into the turn's own upload dir: the turn id IS where store.load and both
    surfaces look for its attachments."""
    out: list[str] = []
    if not paths:
        return out
    d = os.path.join(config.UPLOAD_DIR, job_id)
    os.makedirs(d, exist_ok=True)
    for i, p in enumerate(paths):
        dest = os.path.join(d, f"{i + 1}-{os.path.basename(p)}")
        try:
            os.replace(p, dest)
            try:
                os.rmdir(os.path.dirname(p))           # its own tg-<ms> folder, now empty
            except OSError:
                pass
            out.append(dest)
        except OSError as e:
            print(f"[runner] attachment dropped: {e}", file=sys.stderr)
    return out


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
        # Set in _run_streaming's finally once the child has exited and the
        # session's run slot is free. `status` alone cannot say that: a turn
        # that ends with a background agent pending reads "done" and goes back
        # to "running" when the agent reports (see the assistant branch).
        self.exited = threading.Event()
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
        # A prompt sent from Telegram (bridge/tglive.py): its answer is the
        # message there, so _announce_end sends no DONE/FAILED ping for it.
        self.tg_live = False
        self.told = False         # an end notice of its own already reached the chat (_maybe_auto_resume)
        self.timed_out = False           # watchdog killed the run
        # How long this run may stay silent before the watchdog kills it as
        # hung; None means config.RUN_TIMEOUT. A Rivendell run sets its own
        # kind's timeout: a subagents batch's parent turn is silent for as
        # long as its agents work.
        self.hang_timeout: float | None = None
        self.error_msg: str | None = None  # stderr/exit error when no result event came
        self.ask_dismissed = False       # you waved off the closing question (see dismiss_ask)
        self.account_slot: int | None = None  # Claude account this ran on (None = default)
        self.refusal: str | None = None   # set before spawn: the bound profile can't run (see profiles.refusal)
        self.runtime: str | None = None   # 'claude:<slot>' or 'acp:<agent>'; None = the default Claude login
        self.model: str | None = None     # what the child runs on; a live switch moves it
        # Our set_model / set_permission_mode requests the CLI hasn't answered
        # yet: request_id -> (subtype, value). See control_answered.
        self._controls: dict[str, tuple[str, str]] = {}
        self._held: dict[str, str] = {}   # a pick made before the child existed
        self.texts: list[str] = []       # assistant text this turn
        self.ctx_tokens: int | None = None  # window fill on the last request (see _ctx_of)
        # What the turn spent: the same four counters, summed instead of last-wins.
        # None until a message actually reports usage, so a stream that never did
        # leaves the columns NULL — unknown rather than free.
        self.tokens: dict | None = None
        self.cwd: str | None = None       # where claude was spawned (set by _run_streaming)
        self.project: str | None = None   # the session's project rel (a worktree cwd differs)
        # A tracker update turn (bridge/trackers.py): the MCP server to switch on
        # for this turn whatever the session's toggles say, and the argv extras
        # (the --settings ask rule) that make every call on it show a card.
        self.mcp_on: str | None = None
        self.extra_args: list[str] = []
        # A run whose prompt carries untrusted text (start_streaming_job's skip_pack):
        # no tools, no MCP servers, and never resumed (_maybe_auto_resume).
        self.skip_pack = False
        self.work_cwd: str | None = None  # worktree the shell moved into, if any
        # tool_use id -> (name, start time), for output/diff + duration on tool_done
        self.open_tools: dict[str, tuple[str, float]] = {}
        # The latest TodoWrite list, so a clip can be shown against the plan it
        # is evidence for. Last write wins: that is what the plan *is*.
        self.todos: list = []
        # The plan as the task tools keep it — what claude 2.1.280 -p offers
        # instead of TodoWrite: task id -> its latest status (TaskCreate's result
        # names the id, TaskUpdate moves it). The RIVENDELL card's todo bar.
        self.task_status: dict[str, str] = {}
        # tool_use id -> {notes, resolves} from a Record/Attach call, held until
        # its result comes back with the file.
        self.clip_meta: dict[str, dict] = {}
        # tool_use id -> the image file a Read opened, so the chat shows that
        # file and not the copy the CLI shrank for the model (_save_result_images).
        self.read_paths: dict[str, str] = {}
        # tool_use id -> (command, worktrees before it) for a Bash call, judged by
        # _note_work_cwd once its result says it ran.
        self.bash_cmds: dict[str, tuple[str, "set[str] | None"]] = {}
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

    def _write_stdin(self, obj: dict) -> bool:
        """Write one JSON line to the live process's stdin (control channel).
        False when nothing took it: no child yet, or its stdin is gone (closed
        at the turn's `result`, or the child exited)."""
        proc = self.proc
        if proc is None or proc.stdin is None:
            return False
        line = json.dumps(obj) + "\n"
        with self._stdin_lock:
            try:
                proc.stdin.write(line)
                proc.stdin.flush()
            except (BrokenPipeError, ValueError, OSError):
                return False
        return True

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
        session is preserved, so the next message resumes. Returns False once
        the child has exited."""
        proc = self.proc
        if proc is None or proc.poll() is not None:
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

    # A deny's `message` reaches the model as the tool's result (respond).
    takes_notes = True

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
            _record_task_answer(self.work_cwd or self.cwd, entry.get("questions", []), answers or [])
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

    def set_run_settings(self, model: "str | None" = None,
                         permission_mode: "str | None" = None) -> bool:
        """Switch the live child's model and/or permission mode mid-turn, over
        the stream-json control channel interrupt() uses: claude 2.1.280's
        `set_model` / `set_permission_mode` control requests (bypass needs the
        offer _base_cmd makes at spawn). Returns whether anything reached the
        child; False means the caller's saved row is all the next turn gets.

        Written is not switched. The CLI answers each request on stdout, and only
        its success (control_answered) moves Job.model or, for a switch to
        bypassPermissions, approves the permission cards already waiting —
        "stop asking" has to cover the one on screen. A refusal (a managed
        disableBypassPermissionsMode, an unknown model) becomes an error row
        (_handle_event), changes nothing live, and the saved pick still stands.
        Questions (AskUserQuestion) stay open either way: they ask for a
        decision, not a permission.

        A pick that lands while the child is still being spawned (job.proc is
        None while the MCP health check, the graph pack and the task digest
        build its argv) is held, and _run_streaming writes it the moment the
        child exists, ahead of the prompt (release_held).

        ponytail: a can_use_tool the CLI emits after its success answer (a check
        that began before the switch) still shows its card; it's answerable."""
        with self._lock:
            if self.proc is None:
                if self.exited.is_set():
                    return False
                if model:
                    self._held["model"] = model
                if permission_mode:
                    self._held["permission_mode"] = permission_mode
                return bool(model or permission_mode)
        sent = False
        for subtype, key, value in (("set_model", "model", model),
                                    ("set_permission_mode", "mode", permission_mode)):
            if not value:
                continue
            rid = uuid.uuid4().hex
            with self._lock:          # before the write: the answer can beat us back
                self._controls[rid] = (subtype, value)
            if self._write_stdin({"type": "control_request", "request_id": rid,
                                  "request": {"subtype": subtype, key: value}}):
                sent = True
            else:
                with self._lock:
                    self._controls.pop(rid, None)
        return sent

    def release_held(self) -> None:
        """Write the picks set_run_settings held while the child was spawning.
        _run_streaming calls it right after job.proc is set, before the prompt;
        the lock orders it after any hold that saw no child yet."""
        with self._lock:
            held, self._held = self._held, {}
        if held:
            self.set_run_settings(**held)

    def control_answered(self, request_id: "str | None", ok: bool) -> None:
        """The CLI's answer to one of set_run_settings' requests. Its success is
        the moment the switch is real: the model moves, and a switch to
        bypassPermissions approves the permission cards already waiting —
        except what Bypass itself would still ask about (_bypass_still_asks),
        and nothing at all on a tracker update, whose --settings ask rule
        (extra_args) is there so you confirm every call on its server.
        Answers to anything else (interrupt) are not ours to act on."""
        with self._lock:
            sent = self._controls.pop(request_id, None)
        if not ok or sent is None:
            return
        subtype, value = sent
        if subtype == "set_model":
            self.model = value
        elif value == "bypassPermissions" and not self.extra_args:
            with self._lock:
                waiting = [p["request_id"] for p in self.pending
                           if p.get("kind") == "permission" and not _bypass_still_asks(p)]
            for rid in waiting:
                self.respond(rid, behavior="allow")

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


class AcpJob(Job):
    """A turn run by a non-Claude agent over ACP (bridge/acp.py). Same events,
    cards and Stop as a Claude job; the control channel is JSON-RPC, so every
    stream-json write path is closed off: _write_stdin takes nothing, and
    job.proc stays None (acp keeps the process in job.conn), which leaves
    close_stdin, _escalate and _kill_if_alive nothing to act on. A pick is never
    held (set_run_settings goes straight to the agent), so release_held has
    nothing to send.

    Lock order inside acp.py is turn._lock, then job._lock: never call
    interrupt, respond or set_run_settings while holding job._lock."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.acp_account = ""            # the agent account id; "" = the CLI's own login
        self.agent_session_id = None     # the agent's own session id, once it's open
        self.conn = None                 # acp.Conn
        self.turn = None                 # acp.Turn

    def _write_stdin(self, obj):         # no stream-json stdin here
        return False

    def add(self, ev):
        # A restart's kill is no failure: no error row, so the turn left for
        # boot recovery reads INTERRUPTED, as a Claude one does (_stopping). No
        # grace needed: an agent runs in its own session, so only stop_children
        # reaches it, after shutting_down is up.
        if (ev.get("type") == "error" and state.shutting_down
                and not self.interrupted and not self.timed_out):
            return
        super().add(ev)

    def awaiting(self, kind):
        # acp's reader thread calls this: a Telegram send there would stall the
        # agent's stdout, and a live switch waiting on its answer behind it.
        threading.Thread(target=notify_awaiting, daemon=True,
                         args=(self.chat_id, self.store_session_id, kind)).start()

    def interrupt(self):
        return acp.cancel(self, INTERRUPT_GRACE)

    # ACP's permission answer is allow/deny only: a deny's note can't ride it.
    takes_notes = False

    def respond(self, request_id, *, behavior="allow", message=None, answers=None):
        return acp.answer(self, request_id, behavior == "allow")

    def set_run_settings(self, model=None, permission_mode=None):
        return acp.set_options(self, model=model, mode=permission_mode)


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()
_JOBS_MAX = 20


def get_job(job_id: str) -> Job | None:
    with _jobs_lock:
        return _jobs.get(job_id)


STOP_WAIT = 10.0   # how long stop_children gives its children, all of them together


def stop_children() -> None:
    """SIGTERM every live child, then SIGKILL whatever is still alive STOP_WAIT
    later: one deadline for all of them, so stuck children don't add up. Not
    Job.stop(): that marks the turn user-stopped, and turns a restart stops
    must stay resumable.

    An agent turn has no job.proc: its group goes through Conn.kill(), never
    through the Popen underneath (poll/wait there would reap the leader before
    the sweep). Each kill is bounded (a few seconds), so they run side by side
    inside the same deadline."""
    with _jobs_lock:
        procs = [j.proc for j in _jobs.values() if j.proc and j.proc.poll() is None]
        conns = [j.conn for j in _jobs.values() if isinstance(j, AcpJob) and j.conn]
    kills = [threading.Thread(target=c.kill, daemon=True) for c in conns]
    for t in kills:
        t.start()
    for p in procs:
        p.terminate()
    end = time.monotonic() + STOP_WAIT
    for p in procs:
        try:
            p.wait(timeout=max(0.0, end - time.monotonic()))
        except subprocess.TimeoutExpired:
            p.kill()
    for t in kills:
        t.join(max(0.0, end - time.monotonic()))


def _with_images(prompt: str, image_paths: list[str] | None) -> str:
    """Point the model at what it was sent. Attachments stay on disk (the upload
    dir) rather than going inline: a screenshot is a megabyte of base64, and the
    child can just read the file.

    "File(s)", not "screenshot(s)" — the tray takes any file, and telling the
    model a .csv is a screenshot is how it ends up trying to look at one."""
    if not image_paths:
        return prompt
    return ("The user attached file(s); open them before responding: "
            + ", ".join(image_paths) + "\n\n" + prompt)


def steer(session_id: str, text: str, image_paths: list[str] | None = None) -> bool:
    """Fold a message into a session's IN-FLIGHT turn instead of queueing a new
    one. A stream-json user message written to the live child mid-turn is picked
    up at the next tool-loop boundary (the CLI's queued_command fold-in), so the
    running prompt changes course. False if nothing took it: no live job, or its
    stdin already closed (the turn ended between the lookup and the write).

    Screenshots ride along as paths, exactly as a normal turn's do — the live
    child reads them off disk, so a mid-turn "look at this" works the same as
    one sent from a cold composer.

    Verified against claude 2.1.220: a turn with no tool call has no fold point,
    so a steer sent at the very end simply runs as a follow-up turn on the same
    process. Same job either way — nothing to clean up.

    An agent turn (AcpJob) can't take one: ACP has no mid-turn message, so the
    client queues instead.
    """
    with _jobs_lock:
        job = next((j for j in _jobs.values()
                    if j.store_session_id == session_id and j.status == "running"), None)
    if job is None or job.proc is None or isinstance(job, AcpJob):
        return False
    if not job._write_stdin({"type": "user", "message": {"role": "user",
                                                         "content": _with_images(text, image_paths)}}):
        return False
    job.add({"type": "steer", "text": text, "images": list(image_paths or [])})
    return True


def boot_phase(session_id: str) -> "str | None":
    """What this session's live turn is waiting on before its first token, or
    None. Same lookup as steer(): a session has at most one running job."""
    with _jobs_lock:
        job = next((j for j in _jobs.values()
                    if j.store_session_id == session_id and j.status == "running"), None)
    return job.boot if job else None


def apply_run_settings(session_id: str, model: "str | None" = None,
                       permission_mode: "str | None" = None) -> bool:
    """Switch a session's in-flight turn to a pick its row already holds (the
    settings routes save first). False when nothing live took it. The newest
    job is the only one that can still be live; whether it is, is
    Job.set_run_settings' call (a closed stdin says no)."""
    job = _latest_jobs().get(session_id)
    return job.set_run_settings(model=model, permission_mode=permission_mode) if job else False


def live_job(session_id: str) -> "Job | None":
    """The session's in-flight job, or None — what the RIVENDELL tab and the
    Rivendell worker read a run's live state off. Same lookup as steer() and
    boot_phase(): a session has at most one running job."""
    with _jobs_lock:
        return next((j for j in _jobs.values()
                     if j.store_session_id == session_id and j.status == "running"), None)


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
    mapped to the question. It's still your move, and only you can make it."""
    out: dict[str, str] = {}
    now = time.time()
    for sid, j in _latest_jobs().items():
        if j.status != "done" or j.ask_dismissed:
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
    # The rest is the chat's paused card: its clock, countdown and bar, the login
    # it waits on, and the logins an ASK offered.
    for sid, p in limits.parked().items():
        status.setdefault(sid, {
            "state": "parked", "kind": p["kind"], "source": "bridge",
            "label": (f"usage limit — resuming ~{limits.when_str(p['at'])}" if p["kind"] == "limit"
                      else f"API error — retrying {limits.wait_str(p['at'])}"),
            "at": p["at"], "since": p["since"], "slot": p["slot"], "offer": p["offer"]})
    # A turn that signed off with a question — the ASK card in the transcript —
    # is finished, not blocked: the work landed and nothing is parked. But the
    # next move is yours, and reported as idle it looks like nobody is waiting.
    # Last, so a session already working, checking or parked stays that way.
    for sid, q in asked_sessions().items():
        status.setdefault(sid, {"state": "asking", "kind": None,
                                "source": "bridge", "label": q})
    # A turn that ended on WaitForSession (bridge/waits.py) isn't done either:
    # it wakes on its own when the session it waits on finishes.
    for sid, w in waits.active().items():
        status.setdefault(sid, {"state": "waiting", "kind": None, "source": "bridge",
                                "label": f"waiting on {w['title']}", "on": w["on"],
                                "then": w["then"], "since": w["since"]})
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


def bridge_status(chat_id: int) -> dict:
    """_build_status over this chat's bridge sessions only: no process scan."""
    return _build_status(store.running_session_ids(chat_id), awaiting_input(),
                         running_jobs(chat_id), [], {})


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


def _notify(chat_id: int | None, text: str, kb: dict | None = None, *,
            kind: "str | None" = None, sid: "str | None" = None, body: str = "",
            meta: "dict | None" = None, ask=None, always: bool = False) -> None:
    """Best-effort push (never raises into the run loop). With a `kind` and a
    `sid` the event goes in the feed (bridge/notices.py) first; with a `kind`,
    Telegram gets it only when that event's route allows it. An ask's own echo
    (notices.echo) is marked quiet: the bell keeps it, nothing knocks twice.
    Only what needs you rings: the rest arrives silent. It goes in the
    session's topic when the chat has threads (bridge/tgtopics.py). `ask`, when
    given, sends instead and says whether it did (bridge/tgask.py). always=True
    is a turn the chat started (bridge/tglive.py): its ping goes whatever the
    routes say, as no other surface would show it."""
    quiet = bool(kind and sid and notices.echo(kind, sid))
    if kind and sid:
        notices.emit(kind, sid, body=body, meta={**(meta or {}), "quiet": True} if quiet else meta)
    if quiet or not chat_id or (not always and (not config.NOTIFY_ENABLE
                                                or (kind and not notices.telegram_ok(kind)))):
        return
    try:
        if ask and ask():
            return
        send(chat_id, text, kb, silent=notices.tier(kind) != "needs",
             thread=tgtopics.thread_for(chat_id, sid))
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


def _plugin_session(session_id: str | None) -> bool:
    """A Rivendell run's session. Its worker pings once per JOB
    (rivendell.Worker._ping_done), so the per-turn pings stay quiet for it —
    a queue-mode batch would otherwise ping once per step, and an autonomous
    run's closing question is for its requester, in Rivendell.
    ponytail: by origin, so a turn you later send by hand in such a session
    pings nothing either; tell them apart if that ever matters."""
    sess = store.get_session(session_id) if session_id else None
    return bool(sess) and integrations.is_plugin_origin(sess.get("origin"))


def notify_awaiting(chat_id: int | None, session_id: str | None, kind: str,
                    body: str = "", job_id: "str | None" = None,
                    request_id: "str | None" = None) -> None:
    """Ping when a streaming run blocks on you (a question or an approval).
    `body` is what it asks — the command, or the question — for the bell, and
    `request_id` the card it belongs to, so a button answers that card only."""
    what = "has a question" if kind == "question" else "needs your approval"
    job = get_job(job_id) if job_id else None
    _notify(chat_id, f"❓ Claude {what} — {_session_label(session_id)}",
            _session_kb(chat_id, session_id, "❓ Answer in Panel"),
            kind="question" if kind == "question" else "approve", sid=session_id,
            body=body, meta={"job_id": job_id, "request_id": request_id} if job_id else None,
            # The ask itself, answerable from the chat; the generic ping when it can't go.
            ask=lambda: tgask.ping(chat_id, session_id, job_id, request_id),
            always=bool(job and job.tg_live))


def _first_line(text: str) -> str:
    return next((ln.strip() for ln in (text or "").splitlines() if ln.strip()), "")[:200]


def notify_turn_done(chat_id: int | None, session_id: str | None, is_error: bool,
                     body: str = "") -> None:
    """Ping when a streaming run finishes (or errors), so you can step away. The
    feed's line is the closing sentence, or for a failure what outcomes.py
    calls it, which a red row is useless without."""
    if _plugin_session(session_id):
        return
    try:
        turn = (store.last_turn(session_id) if session_id else None) or {}
    except Exception:  # noqa: BLE001
        turn = {}
    out = turn.get("outcome") or {}
    line = (f"{out['label'].capitalize()}: {out.get('detail') or ''}".strip()[:200]
            if is_error and out.get("label") else _first_line(body))
    icon, verb = ("⚠️", "hit an error") if is_error else ("✅", "finished")
    why = f"\n{line}" if is_error and line else ""
    _notify(chat_id, f"{icon} Claude {verb} — {_session_label(session_id)}{why}",
            _session_kb(chat_id, session_id, "🛠 Open session"),
            kind="failed" if is_error else "done", sid=session_id, body=line,
            meta={"elapsed": turn["elapsed"]} if turn.get("elapsed") else None)


def notify_waiting(chat_id: int | None, session_id: str | None, on_title: str) -> None:
    """A turn that ended on WaitForSession: not DONE, it wakes on its own."""
    if _plugin_session(session_id):
        return
    _notify(chat_id, f"⧖ Claude is waiting — {_session_label(session_id)}\non {on_title}",
            _session_kb(chat_id, session_id, "🛠 Open session"),
            kind="waiting", sid=session_id, body=f"waiting on {on_title}")


def notify_woken(chat_id: int | None, session_id: str | None, body: str) -> None:
    """A waiting session was queued its wake-up (bridge/waits.py)."""
    if _plugin_session(session_id):
        return
    _notify(chat_id, f"⧖ Claude is carrying on — {_session_label(session_id)}\n{body}",
            _session_kb(chat_id, session_id, "🛠 Open session"),
            kind="resumed", sid=session_id, body=body)


def _announce_end(job) -> None:
    """A turn that ended by itself: WAITING when it ended on WaitForSession (it
    wakes on its own), else DONE or FAILED; then wake whoever waited on it."""
    chat = None if job.tg_live else job.chat_id     # None: the bell only (_notify)
    if w := waits.get(job.store_session_id or ""):
        notify_waiting(chat, job.store_session_id, w["title"])
    else:
        notify_turn_done(chat, job.store_session_id, job.status == "error",
                         body=(job.error_msg or "") if job.status == "error" else
                         (job.result or (job.texts[-1] if job.texts else "")))
    waits.target_ended(job)


# ---------------------------------------------------------------------------
# Auto-resume: only the user may stop a turn
# ---------------------------------------------------------------------------
# Five non-user ways a turn dies, five answers:
#   - The bridge is restarting (its own stop_children, or a stop signal that
#     reached the child too, takes the Claude child down): leave the turn
#     'running', with no error event, so startup recovery (bridge/recovery.py)
#     claims and resumes it on the next boot and it reads INTERRUPTED. A child
#     can die a beat before the main thread raises shutting_down; _stopping
#     waits that beat out.
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
#     the RUN_TIMEOUT watchdog killed a run that went silent: resume the
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
    "⏮ Your previous turn was killed by the bridge's hang watchdog (no output "
    "for too long) — not by the user. Review your recent transcript and continue "
    "exactly where you left off; finish the task you were doing. Don't start over.")
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


# How a child dies of a stop signal: SIGTERM (systemd stopping the unit, or
# stop_children) or SIGINT (Ctrl-C, `mystical stop` signalling the process
# group) — raw as -N, or as the CLI's own 128+N exit once it handled the signal.
_STOP_EXITS = (-15, 143, -2, 130)
# How long a child that died of one waits for the bridge to say it is stopping.
STOP_GRACE = 3.0


def _stopping(rc: "int | None") -> bool:
    """Is the bridge going down with this child? The stop signal can reach both
    at once, and Python runs the bridge's handler on the main thread only, so a
    runner thread can see its child die before shutting_down is up. A death by a
    stop signal waits up to STOP_GRACE for the flag; any other exit doesn't."""
    # ponytail: polls a bool every 50 ms for at most STOP_GRACE. An Event would
    # wake at once; this only runs for a child that died of a stop signal.
    end = time.monotonic() + (STOP_GRACE if rc in _STOP_EXITS else 0)
    while not state.shutting_down and time.monotonic() < end:
        time.sleep(0.05)
    return state.shutting_down


def _maybe_auto_resume(job: "Job", cwd: str, model: str | None,
                       effort: str | None) -> bool:
    """Resume a session whose turn died without the user behind it. Returns True
    when a resume run was started (the caller then skips the error notification).
    Never an agent turn's (acp:): no parking, no resume for those (spec non-goal)."""
    if (job.runtime or "").startswith("acp:"):
        return False
    sid = job.store_session_id
    if not sid:
        return False
    if job.status == "done":
        _resume_fails.pop(sid, None)             # healthy turn resets the cap
        limits.note_ok(sid)                      # ...and closes any limit episode
        return False
    if job.status != "error" or job.interrupted or job.refusal:
        return False                              # a refused turn is refused again
    if job.skip_pack:
        return False                              # tools-off: a resume would run with tools
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
        # better than waiting: another account. A taken rung unparks the
        # session and announces itself, so we stay quiet then.
        if ladder.escalate(sess, job.chat_id, dead_slot=job.account_slot,
                           model=model, effort=effort):
            return True
        if first:
            _notify(job.chat_id,
                    f"⏳ Claude usage limit hit — {_session_label(sid)} is paused and "
                    f"will auto-resume when the limit resets (~{limits.when_tg(when)}).",
                    _session_kb(job.chat_id, sid), kind="parked", sid=sid,
                    body=f"Hit the usage limit. It resumes on its own around {limits.when_str(when)}.",
                    always=job.tg_live)
            job.told = True
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
                f"(attempt {attempt}/{len(limits.SERVER_BACKOFF)}).", kind="retrying", sid=sid,
                body=f"API error. Retrying {limits.wait_str(when)} "
                     f"(attempt {attempt}/{len(limits.SERVER_BACKOFF)}).", always=job.tg_live)
        job.told = True
        return True
    if limits.is_auth_error(job.result or job.error_msg):
        # The login behind this turn is dead. Resuming would re-send the same
        # prompt to the same expired token and fail identically, five times
        # over, so stop and hand back the way back in instead.
        _auth_stop(job.chat_id, sid, job.account_slot, cwd, model, effort, reply=job.tg_live)
        job.told = True
        return False
    if limits.is_outdated_error(job.result or job.error_msg):
        # The API refused this CLI for the model. A resume runs the same CLI and
        # is refused again. It can arrive as a failed compaction, so it goes
        # before the context branch, whose "/compact" would fail the same way.
        # No ping here: the turn's FAILED carries outcomes.py's "update Claude Code".
        return False
    if limits.is_context_error(job.result or job.error_msg):
        # The transcript no longer fits the window. A resume resends the same
        # too-long context, so every retry below fails identically at full turn
        # price. Stop and hand it back (its FAILED says what to do).
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
            project=cwd, session_id=sid, model=model, effort=effort,
            account_slot=job.account_slot, runtime=job.runtime)
    except Exception as e:  # noqa: BLE001
        print(f"[auto-resume] failed for {sid}: {e}", file=sys.stderr)
        return False
    if job2 is None:
        return False                              # slot taken (e.g. the queue advanced)
    if job.timed_out:
        mins = (job.hang_timeout or config.RUN_TIMEOUT) // 60
        _notify(job.chat_id, f"⏱️ No output for {mins} min — "
                             f"killed as hung, resuming {_session_label(sid)}.",
                kind="resumed", sid=sid, body=f"No output for {mins} min, so it was killed as hung. Resuming.")
    else:
        _notify(job.chat_id, f"🔄 The turn was interrupted by an error "
                             f"— resuming {_session_label(sid)}.",
                kind="resumed", sid=sid, body="Interrupted by an error. Resuming.")
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
        notices.emit("login", sid or "", body=f"Claude's login on account {slot} expired. "
                                              "Sign in again and it picks up where it left off.",
                     meta={"slot": slot})
        send(chat_id, text, _auth_kb(chat_id, slot))
    else:
        _notify(chat_id, text, _auth_kb(chat_id, slot), kind="login", sid=sid,
                body=f"Claude's login on account {slot} expired. "
                     "Sign in again and it picks up where it left off.", meta={"slot": slot})


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
    _notify(e["chat_id"], f"🔄 Signed in — resuming {_session_label(e['sid'])}.",
            kind="resumed", sid=e["sid"], body="Signed in again. Resuming.")
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
    # Headers can repeat (one "Task" question per repo), so each question takes
    # the next unused answer under its header; the surfaces send them in order.
    by_header: dict = {}
    for a in answers:
        if isinstance(a, dict):
            by_header.setdefault(a.get("header"), []).append(a)
    parts: list[str] = []
    for q in questions:
        header = q.get("header") or q.get("question") or ""
        same = by_header.get(header)
        a = same.pop(0) if same else None
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


def _record_task_answer(cwd: "str | None", questions: list, answers: list) -> None:
    """An answered Task card (the Rivendell note's push question) goes into the
    checkout's .mystical/tasks.json, for its branch: the task tab shows it, and
    the push gate lets that branch's pushes through. Any surface's answer counts,
    because they all land here. Never raises into the answer."""
    try:
        from bridge import taskcheck
        got = taskcheck.answer_state(questions, answers)
        if got:
            top = taskcheck.toplevel(cwd)
            taskcheck.record(top, taskcheck.branch(top), got)
    except Exception as e:  # noqa: BLE001
        print(f"[runner] task answer not recorded: {e}", file=sys.stderr)


def _mcp_detail(inp) -> str:
    """An MCP call's input, readable: long strings raw (a comment body keeps
    its lines), everything else as JSON."""
    if not isinstance(inp, dict):
        return json.dumps(inp, ensure_ascii=False)[:4000]
    parts = []
    for k, v in inp.items():
        if isinstance(v, str) and ("\n" in v or len(v) > 60):
            parts.append(f"{k}:\n{v}")
        else:
            parts.append(f"{k}: {v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)}")
    return "\n".join(parts)[:4000]


# A can_use_tool request's reason fields (claude 2.1.280's schema).
_ASK_WHY = ("requires_user_interaction", "decision_reason_type", "matched_ask_rule",
            "classifier_approvable")
# Reason types claude's own bypassPermissions just runs (2.1.280's permission
# check): no reason (a plain ask), the default/plan mode asking, the auto-mode
# classifier, a path outside the working dirs, and the generic "other". Every
# other type — an ask rule, a safety check (.git/, settings files...), a sandbox
# override, a compound command hiding either, a hook that asked, and anything a
# newer CLI adds — leaves its card for you.
_BYPASS_RUNS = {None, "mode", "classifier", "workingDir", "other"}


def _bypass_still_asks(card: dict) -> bool:
    """Would claude's own bypassPermissions still ask about this permission
    card? Then a switch to Bypass leaves it for you. Read from 2.1.280's
    permission check: a tool that needs you in any mode (ExitPlanMode:
    requires_user_interaction), a matched ask rule, a safety check (its
    classifier_approvable says one is in the reason), a reason type outside
    _BYPASS_RUNS, and an MCP tool an org policy caps at "ask" (type "other").
    A plain ask and the auto-mode classifier's are what Bypass just runs —
    those it approves."""
    why = card.get("decision_reason_type")
    return bool(card.get("tool_name") == "ExitPlanMode"
                or card.get("requires_user_interaction")
                or card.get("matched_ask_rule") is not None
                or card.get("classifier_approvable") is not None
                or why not in _BYPASS_RUNS
                or (why == "other" and str(card.get("tool_name", "")).startswith("mcp__")))


def _handle_control_request(job: Job, obj: dict):
    """A `can_use_tool` request: queue it as pending and surface a transcript
    event (a permission card, or a question card for AskUserQuestion)."""
    req = obj.get("request", {})
    if req.get("subtype") != "can_use_tool":
        return  # other control subtypes need no response from us
    rid = obj.get("request_id")
    tool = req.get("tool_name", "tool")
    if tool == "AskUserQuestion":
        questions = _adopt_preview_images(job.id, rid, (req.get("input") or {}).get("questions", []))
        job.add_pending({"request_id": rid, "kind": "question",
                         "tool_name": tool, "questions": questions,
                         "at": time.time()})    # since when: the card's "ASKS · 3m ago"
        job.add({"type": "question", "request_id": rid, "questions": questions})
        from bridge import rivendell  # local import: rivendell reaches runner lazily too
        if rivendell.ping_question(job, rid, questions):
            return    # a Rivendell run's own ping carries the options as buttons
    else:
        summary = _summarize_tool(tool, req.get("input", {}))
        # Why the CLI asked, in its own fields: a switch to Bypass approves
        # only what Bypass itself wouldn't ask about (_bypass_still_asks).
        job.add_pending({"request_id": rid, "kind": "permission", "tool_name": tool,
                         "summary": summary, "input": req.get("input", {}),
                         **{k: req.get(k) for k in _ASK_WHY}})
        ev = {"type": "permission", "request_id": rid, "tool_name": tool, "summary": summary}
        inp = req.get("input") or {}
        if tool.startswith("mcp__"):
            # The whole call, not 120 chars of it: an MCP write (a tracker
            # comment, a status change) is judged on its full text.
            ev["detail"] = _mcp_detail(inp)
        elif tool == "Bash" and len(str(inp.get("command") or "")) > len(summary):
            # A command is allowed on all of it: the tail past 120 chars is
            # often the `&& git push` the card exists for.
            ev["detail"] = str(inp["command"])[:4000]
        elif tool == "ExitPlanMode" and inp.get("plan"):
            # The plan is what's being approved; the card renders it as markdown.
            ev["detail"] = str(inp["plan"])[:8000]
        job.add(ev)
    ask = (((req.get("input") or {}).get("questions") or [{}])[0].get("question") or ""
           if tool == "AskUserQuestion" else f"{tool}: {summary}")
    notify_awaiting(job.chat_id, job.store_session_id,
                    "question" if tool == "AskUserQuestion" else "permission",
                    body=ask, job_id=job.id, request_id=rid)


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


def _trees_before(job: "Job", command: str) -> "set[str] | None":
    """The repo's worktrees from just before a Bash command that adds one, so its
    result can tell which tree it made. None for any other command, or when git
    can't say."""
    if "worktree add" not in command or not job.cwd:
        return None
    try:
        return {w["path"] for w in git.worktrees(job.cwd)} or None
    except Exception:  # noqa: BLE001 - same as _note_work_cwd: never fail a turn
        return None


def _note_work_cwd(job: "Job", command: str, before: "set[str] | None" = None) -> None:
    """Follow the session onto the worktree it works in, once a Bash command ran.

    `cd ~/projects/.worktrees/x/feat-y/web && git commit` is how an agent works a
    feature branch, and claude's own cwd never moves with it — so the session
    row keeps naming the checkout's branch while every commit lands on another
    one. Recording the tree lets the surfaces label the session with the branch
    it is actually on.

    Two things move it. A command that added a worktree of this session's repo
    (`before` holds the trees from just before it ran): a session that starts on
    main and branches off for its change is on that branch from then on, whether
    or not it ever `cd`s there. And a literal `cd` into a linked worktree, at any
    depth (git.worktree_holding); landing in the session's own tree walks it home.
    A `cd` to the main checkout never does: that is where probes, merges and
    reads of master happen mid-feature, so the label stays on the branch until
    the session enters another tree or its tree is removed (_session_brief then
    falls back to the checkout). Judged on the result, not the call: `git
    worktree add … && cd …` names a tree that only exists once the line has run.
    A `cd /tmp`, a relative `cd`, or a command that merely reads a worktree
    leaves the label alone — a wrong branch on the card is worse than a stale
    one. Best-effort; never raises into the turn."""
    if not (job.store_session_id and job.cwd):
        return
    try:
        made = [w["path"] for w in git.worktrees(job.cwd)
                if not w["is_main"] and w["path"] not in before] if before else []
        dest = git.shell_cd_target(command)
        tree = made[0] if len(made) == 1 else git.worktree_holding(job.cwd, dest) if dest else ""
        if not tree:
            return
        new = None if os.path.realpath(tree) == os.path.realpath(job.cwd) else tree   # None: home
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
        if job.status == "done":
            # ponytail: claude -p emits `result` when the model ends its turn with
            # a background task still pending, then stays alive and wakes the
            # model with the task's notification — same process, same turn. Back
            # to running, or a watchdog kill / crash from here reads as a clean
            # finish: no error row, no timeout notice, no auto-resume.
            job.status, job.elapsed = "running", None
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
                    cmd = inp.get("command") or ""
                    job.bash_cmds[b.get("id")] = (cmd, _trees_before(job, cmd))
                elif name == "TodoWrite" and isinstance(inp.get("todos"), list):
                    job.todos = inp["todos"]
                elif name == "TaskUpdate" and inp.get("taskId"):
                    tid = str(inp["taskId"])
                    job.task_status[tid] = str(inp.get("status")
                                               or job.task_status.get(tid, "pending"))
                elif name.endswith(("__Record", "__Attach")):
                    job.clip_meta[b.get("id")] = _clip_meta(job, inp)
                elif name == "Read" and isinstance(inp.get("file_path"), str):
                    job.read_paths[b.get("id")] = inp["file_path"]
                job.open_tools[b.get("id")] = (name, time.time())
                ev = {"type": "tool", "name": name, "id": b.get("id"),
                      "summary": _summarize_tool(name, inp)}
                if (am := transcript_jsonl.agent_meta(name, inp)):
                    ev["agent"] = am
                job.add(ev)
    elif t == "user":
        for b in d.get("message", {}).get("content", []):
            if isinstance(b, dict) and b.get("type") == "tool_result":
                rid = b.get("tool_use_id")
                name, t0 = job.open_tools.pop(rid, (None, 0.0))
                if (bash := job.bash_cmds.pop(rid, None)) is not None:
                    _note_work_cwd(job, *bash)
                made = d.get("tool_use_result") if name == "TaskCreate" else None
                if (isinstance(made, dict) and isinstance(made.get("task"), dict)
                        and made["task"].get("id")):
                    job.task_status.setdefault(str(made["task"]["id"]), "pending")
                ms = int((time.time() - t0) * 1000) if t0 else 0
                ev = transcript_jsonl.tool_done(
                    rid, name, ms, b, d.get("tool_use_result"))
                imgs = _save_result_images(job.id, rid, b.get("content"),
                                           job.read_paths.pop(rid, None))
                if (clip := _save_result_file(job.id, rid, name, b.get("content"))):
                    imgs = imgs + [clip]
                    # Only on the event that actually carries a file: a panel
                    # with nothing to sit beside is not worth streaming.
                    if (meta := job.clip_meta.pop(rid, None)) is not None:
                        meta["chapters"] = _clip_chapters(b.get("content"))
                        if any(meta.values()):
                            ev["clip"] = meta
                job.clip_meta.pop(rid, None)
                if imgs:
                    ev["images"] = imgs
                job.add(ev)
    elif t == "system" and d.get("subtype") == "init" and job.status == "done":
        # Another turn in the same process. On --resume the CLI first replays
        # the notice of a background task the last process left behind, a
        # no-op whose result ("", num_turns 0) beats our prompt (CLI 2.1.302).
        # Left done, _watchdog's shell grace killed the child mid-thinking.
        job.status, job.elapsed = "running", None
    elif t == "system" and d.get("subtype") == "hook_response":
        _hook_log(job, d)
    elif t == "control_response":
        # The CLI's answer to one of ours (interrupt, set_model,
        # set_permission_mode). Only a refusal earns a row: the pick it carried
        # is saved either way, and the next turn spawns with it. A success is
        # when a switch takes effect (Job.control_answered).
        r = d.get("response") or {}
        if r.get("subtype") == "error":
            job.add({"type": "log", "src": "control", "error": True,
                     "text": str(r.get("error") or "control request refused")[:_LOG_MAX]})
        job.control_answered(r.get("request_id"), r.get("subtype") == "success")
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


def _save_result_images(job_id: str, rid: str, content,
                        original: "str | None" = None) -> list[str]:
    """Images a tool handed back (Playwright, chrome-devtools, Figma…), written
    next to the run's uploads so the transcript can show them instead of the word
    "image". Paths, not base64: a screenshot is a megabyte, and the event goes
    into the store and down every SSE stream. Best-effort — a tool result must
    never fail because its screenshot didn't land.

    `original` is the image file a Read opened. The CLI shrinks an image to
    2000px on its long side before the model sees it (toolUseResult.dimensions
    says so), and that shrunk copy is all the stream carries -- a 2561x6111
    design shot reached the chat at 838x2000. So a Read's image is the file
    itself, copied like an Attach, as long as it is still there."""
    if not isinstance(content, list):
        return []
    if original and (mimetypes.guess_type(original)[0] or "").startswith("image/") \
            and any(isinstance(b, dict) and b.get("type") == "image" for b in content):
        try:
            if 0 < os.path.getsize(original) <= _MCP_FILE_BYTES:
                d = os.path.join(config.UPLOAD_DIR, job_id)
                os.makedirs(d, exist_ok=True)
                fp = os.path.join(d, f"mcp-{rid or 'tool'}-0{os.path.splitext(original)[1].lower()}")
                shutil.copy2(original, fp)
                return [fp]
        except OSError as e:          # gone or unreadable: the shrunk copy still lands
            print(f"[runner] read image original dropped: {e}", file=sys.stderr)
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


_CLIP_NOTES_CHARS = 600
_CLIP_TODOS = 12          # a plan longer than this is not a caption any more


def _clip_meta(job: "Job", inp: dict) -> dict:
    """What a Record/Attach call claims, snapshotted when the call is made.

    The plan is read here rather than at the result because a long recording can
    outlive its own todo list -- stamping the list as it was when the clip was
    asked for is what keeps `resolves` pointing at the rows it was counted
    against. Indices out of range are dropped rather than clamped: a wrong row
    lit up is worse than none."""
    notes = inp.get("notes")
    todos = [t for t in job.todos if isinstance(t, dict)][:_CLIP_TODOS]
    res = inp.get("resolves")
    res = [i for i in res if isinstance(i, int) and 0 <= i < len(todos)] if isinstance(res, list) else []
    return {
        "notes": notes.strip()[:_CLIP_NOTES_CHARS] if isinstance(notes, str) else "",
        "todos": [{"content": str(t.get("content", ""))[:200],
                   "status": str(t.get("status", ""))} for t in todos],
        "resolves": res,
    }


def _clip_chapters(content) -> list:
    """The `CHAPTERS [...]` line verify_mcp puts under the path. Anything that is
    not our own shape is no chapters at all -- this parses a tool result, so it
    stays incurious about text it did not write."""
    if not isinstance(content, list):
        return []
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "text":
            continue
        lines = (b.get("text") or "").splitlines()
        if len(lines) < 2 or not lines[1].startswith("CHAPTERS "):
            continue
        try:
            got = json.loads(lines[1][len("CHAPTERS "):])
        except ValueError:
            return []
        return [{"t": float(c["t"]), "text": str(c["text"])[:200]}
                for c in got
                if isinstance(c, dict) and isinstance(c.get("t"), (int, float)) and "text" in c]
    return []


_MCP_FILE_BYTES = 64 * 1024 * 1024  # one clip or attachment, on disk


def _save_result_file(job_id: str, rid: str, name: "str | None",
                      content) -> "str | None":
    """Record and Attach hand back a path rather than bytes -- a clip is tens of
    megabytes, and this event goes into the store and down every SSE stream, so
    base64 is out of the question. Putting the file next to the run's uploads is
    what puts it in the transcript, and makes it subject to the same pruning as
    everything else there.

    Gated on the tool name: this is our own tools' first line, not a path
    sniffed out of whatever text some other tool happened to return. Record
    writes to a temp dir nobody serves, so its clip is moved; an attachment is a
    file the human already owns somewhere, so it is copied and left where it is.
    Record stays video-only -- it cannot produce anything else, and widening it
    would let the one tool with a whole page of prose in its result publish a
    stray image path."""
    if not name or not isinstance(content, list):
        return None
    if name.endswith("__Record"):
        kinds, take = ("video/",), shutil.move
    elif name.endswith("__Attach"):
        kinds, take = ("image/", "video/"), shutil.copy2
    else:
        return None
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "text":
            continue
        first = ((b.get("text") or "").splitlines() or [""])[0].strip()
        if not first or not os.path.isfile(first):
            continue
        if not (mimetypes.guess_type(first)[0] or "").startswith(kinds):
            continue
        try:
            if os.path.getsize(first) > _MCP_FILE_BYTES:
                return None
            d = os.path.join(config.UPLOAD_DIR, job_id)
            os.makedirs(d, exist_ok=True)
            # One tool call, one file: the id keeps two of them in the same turn
            # from overwriting each other, and the real name keeps the extension
            # the players key off.
            fp = os.path.join(d, f"{rid or 'tool'}-{os.path.basename(first)}")
            take(first, fp)
            return fp
        except OSError as e:
            print(f"[runner] attachment dropped: {e}", file=sys.stderr)
            return None
    return None


# A picture in an AskUserQuestion option's preview: ![alt](/absolute/path), the
# shape config.ASK_SYSTEM_PROMPT asks for.
_PREVIEW_IMG = re.compile(r"!\[([^\]\n]*)\]\(\s*<?(/[^)\s>]+)>?\s*\)")


def _adopt_preview_images(job_id: str, rid: "str | None", questions):
    """Copy the local images a question's option previews point at into the
    run's uploads, and point the previews at the copies.

    /local/attachment and the Mini App's /api/attachment serve UPLOAD_DIR and
    nothing else, on purpose, so a preview naming ~/x/.mystical/shot.png would
    draw nothing. Same contract as Attach (_save_result_file): images only, the
    same size cap, copied rather than moved because the file is whoever made
    it. Anything else in a preview (text, a path that isn't an image file)
    stays as written. Never raises: the question has to reach the human even
    when its pictures can't."""
    if not isinstance(questions, list):
        return questions
    tag = re.sub(r"[^\w-]", "", rid or "")[:40] or "q"
    n = 0

    def adopt(m: "re.Match") -> str:
        nonlocal n
        src = m.group(2)
        try:
            if (not os.path.isfile(src)
                    or not (mimetypes.guess_type(src)[0] or "").startswith("image/")
                    or os.path.getsize(src) > _MCP_FILE_BYTES):
                return m.group(0)
            d = os.path.join(config.UPLOAD_DIR, job_id)
            os.makedirs(d, exist_ok=True)
            n += 1
            # The request id keeps two questions in one turn from overwriting
            # each other's a.png; the real name keeps the extension.
            fp = os.path.join(d, f"{tag}-{n}-{os.path.basename(src)}")
            shutil.copy2(src, fp)
            return f"![{m.group(1)}]({fp})"
        except OSError as e:
            print(f"[runner] preview image not copied: {e}", file=sys.stderr)
            return m.group(0)

    out = []
    for q in questions:
        if isinstance(q, dict) and isinstance(q.get("options"), list):
            q = {**q, "options": [
                {**o, "preview": _PREVIEW_IMG.sub(adopt, o["preview"])}
                if isinstance(o, dict) and isinstance(o.get("preview"), str) else o
                for o in q["options"]]}
        out.append(q)
    return out


def _cleanup_uploads(job_id: str):
    d = os.path.join(config.UPLOAD_DIR, job_id)
    shutil.rmtree(d, ignore_errors=True)


def _prune_uploads():
    """A finished run leaves its screenshots on disk — the turn is in the
    transcript and the dashboard serves them back (/local/attachment) — so
    bound the dir by age instead of deleting each run's images on the spot."""
    cutoff = time.time() - config.UPLOAD_KEEP_DAYS * 86400
    keep = team.owned_uploads()     # what teammates sent: kept till dismissed or expired (team.py)
    try:
        with os.scandir(config.UPLOAD_DIR) as it:
            for e in it:
                if e.is_dir() and e.name not in keep and e.stat().st_mtime < cutoff:
                    shutil.rmtree(e.path, ignore_errors=True)
    except OSError:
        pass


# After the turn's result the claude child lives on only for background work
# (_run_env lifts the CLI's wait ceiling). An agent or workflow reports back
# into the same process and the model carries on (the assistant branch flips
# the job to running), so a turn waits for those. A background shell or
# monitor can be a dev server that never ends: once no agent is working and
# the child has been quiet this long, the turn is over.
BG_SHELL_GRACE = 15.0


def _watchdog(job: Job, proc) -> None:
    """Kill a run that has gone silent: no event from the child for the job's
    hang timeout (config.RUN_TIMEOUT unless the run set its own) while nothing
    waits on the user. A busy turn runs for as long as it takes — this is a
    hang detector, not a work cap (the cost brake is the auto-resume cap, see
    _maybe_auto_resume). And end a finished turn whose child only background
    shells keep alive (BG_SHELL_GRACE): the CLI takes them down and exits, and
    the turn closes on the result it already has.

    proc is the claude child, or an agent turn's acp.Conn (its poll() never
    reaps; its kill() sweeps the group). It stands down once the turn has
    ended (job.exited): a descendant still holding an agent's stream must not
    get a finished turn timed out and killed.

    Silence is awake time: the monotonic clock stops while the machine sleeps,
    the wall clock jumps. On wall time a closed lid read as a hang -- all 20
    hung kills on the Mac 2026-10-13..20 were sleep, not a stuck child."""
    seen, quiet_since = job.last_at, time.monotonic()
    limit = job.hang_timeout or config.RUN_TIMEOUT
    while proc.poll() is None and not job.exited.wait(1.0):
        if job.pending or job.interrupted or job.last_at != seen:
            seen, quiet_since = job.last_at, time.monotonic()
            if job.pending or job.interrupted:
                continue                # waiting on the user, or stopping: not a hang
        quiet = time.monotonic() - quiet_since
        if (job.status != "running" and not (job.runtime or "").startswith("acp:")
                and quiet >= BG_SHELL_GRACE
                and not (job.session_id and _running_agents(job.session_id))):
            proc.terminate()
            job.exited.wait(INTERRUPT_KILL)
            if proc.poll() is None:
                proc.kill()
            return
        if quiet >= limit:
            job.timed_out = True
            proc.kill()
            return


def _consume_acp(job: AcpJob, prompt: str, image_paths: list[str], cwd: str,
                 model: "str | None", effort: "str | None",
                 permission_mode: "str | None") -> None:
    """Run this turn on its ACP agent. Preconditions (owner, install, account,
    no Claude model) end it with the reason before anything starts: checked
    here, in the turn, so every caller is covered (safety rule 6). Everything
    after (journaling, finish_turn, the slot) is _run_streaming's finally."""
    agent = job.runtime.split(":", 1)[1]
    p = acp_agents.preset(agent)
    problem = acp_agents.run_problem(p, job.acp_account, job.chat_id, model)
    if problem:
        return acp._fail(job, problem)
    sess = store.get_session(job.store_session_id) if job.store_session_id else None
    job.boot = f"starting {p['label']}"
    _ensure_mystical(cwd)
    agent_sid = (sess or {}).get("agent_session_id")
    acp.run_turn(
        job, argv=acp_agents.argv(p), env=acp_agents.env_for(p, job.acp_account), cwd=cwd,
        label=p["label"], login_hint=acp_agents.login_hint(p, job.acp_account),
        auth_method=acp_agents.auth_method(p, job.acp_account),
        text=(_with_images(prompt, image_paths) if agent_sid
              else _MYSTICAL_NOTE + "\n\n" + _PUSH_NOTE + "\n\n" + _with_images(prompt, image_paths)),
        agent_session_id=agent_sid,
        opts={"model": model, "permission_mode": permission_mode, "effort": effort},
        on_spawn=lambda conn: threading.Thread(target=_watchdog, args=(job, conn),
                                               daemon=True).start(),
        # Never claude_session_id: Claude-only readers must not follow an agent's id.
        on_session=lambda sid: job.store_session_id and store.set_session_field(
            job.store_session_id, "agent_session_id", sid),
        cache=lambda opts, modes, models: acp_agents.remember_options(
            agent, job.acp_account, opts, modes, models))


def _run_streaming(job: Job, prompt: str, image_paths: list[str], cwd: str,
                   model: str | None = None, effort: str | None = None,
                   permission_mode: str | None = None, ponytail: str | None = None):
    proc = None
    mcp_dir = None
    job.cwd = cwd
    try:
        if job.refusal:
            job.error_msg = job.refusal
            job.add({"type": "error", "message": job.refusal})
            job.status = "error"
            return
        if (job.runtime or "").startswith("acp:"):
            _consume_acp(job, prompt, image_paths, cwd, model, effort, permission_mode)
            return
        full_prompt = _with_images(prompt, image_paths)
        # The gap before the first token is two waits, and an empty stream makes
        # both read as a hang. Name whichever one we are actually in: the health
        # check only blocks while the cache is still cold (see toolsets.warm).
        from bridge import toolsets  # local: toolsets imports runner
        job.boot = ("checking configured MCP servers"
                    if job.store_session_id and not toolsets.ready() else None)
        denied = (profiles.tools_for(store.get_session(job.store_session_id))
                  if job.store_session_id else None)
        if job.mcp_on:
            # On for this turn only — the session's own toggles are not written.
            denied = [r for r in (store.default_disabled_tools() if denied is None else denied)
                      if r != f"mcp__{job.mcp_on}"]
        cmd = _base_cmd(full_prompt, job.chat_id, stream=True, interactive=True,
                        model=model, effort=effort, permission_mode=permission_mode,
                        claude_session_id=job.resume_id, cwd=cwd,
                        new_session=job.new_session, disabled_tools=denied,
                        autocompact=store.get_autocompact(job.store_session_id)
                        if job.store_session_id else None, project=job.project,
                        skip_pack=job.skip_pack)
        if "--mcp-config" in cmd:
            # Its file holds tokens (see _mcp_config); it goes with the child.
            mcp_dir = os.path.dirname(cmd[cmd.index("--mcp-config") + 1])
        cmd = _one_settings(cmd + job.extra_args)
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
        # A model/mode pick made while the argv was being built: ahead of the
        # prompt, so the turn starts on it.
        job.release_held()
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

        # Watchdog: kill the run only if it goes *silent* for RUN_TIMEOUT — no
        # event from the child while nothing waits on you. Work never counts,
        # however long; a hang does.
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
            if d.get("type") == "result" and (d.get("num_turns") or d.get("result")):
                # Turn finished; close stdin so the stream-json process exits
                # (it otherwise stays alive awaiting more input). Not on the
                # empty no-op a replayed notice gets (see _handle_event's init):
                # our prompt runs after it and answers its cards over stdin.
                # A lone one is ended by _watchdog's shell grace instead.
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
            # Unless the bridge's own stop took the child down: then say nothing,
            # so the turn boot recovery resumes reads INTERRUPTED, not CRASHED.
            if job.timed_out or not _stopping(proc.returncode):
                err = "".join(stderr_tail).strip()
                if job.timed_out:
                    msg = f"⏱️ No output for {(job.hang_timeout or config.RUN_TIMEOUT) // 60} min — killed as hung."
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
        # Read back off argv, so held to the one shape _mcp_config makes: nothing
        # else on a command line is ever rmtree'd.
        if mcp_dir and os.path.basename(mcp_dir).startswith("mystical-mcp-"):
            # ponytail: a run cut off by the bridge's own death (killed outright,
            # or its interpreter exiting before this thread gets here) leaves its
            # dir in /tmp: 0700, readable only by this user, wiped at boot. Sweep
            # mystical-mcp-* at startup if that ever matters.
            shutil.rmtree(mcp_dir, ignore_errors=True)
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
            # Not for a turn a restart killed: its item must reach the persisted
            # queue still "running", which the reload re-queues (PreviewQueue._load).
            if not restart_killed:
                try:
                    from bridge import queue_manager
                    queue_manager.notify_job_done(
                        job.store_session_id, job.id, job.status,
                        job.result, job.cost, job.elapsed, error=job.error_msg)
                except Exception:  # noqa: BLE001 — never let the queue break a run
                    pass
        job.exited.set()
        # job.model, not `model`: a live switch (Job.set_run_settings) moves it,
        # and the resume and a limit park must run what the turn ended on, not
        # what it started on.
        resumed = not restart_killed and _maybe_auto_resume(job, cwd, job.model, effort)
        if not resumed and not restart_killed:
            # An active goal queues its own next turn. After auto-resume, so a
            # limit-parked turn is picked up by the ladder rather than raced by
            # a nudge that would run against the same exhausted account. The
            # nudge reads the session's model and mode when it starts.
            from bridge import goals  # local import: runner<->* cycle
            resumed = goals.continue_after_turn(job, effort) or resumed
        if not job.interrupted and job.status == "done" and job.store_session_id:
            _graph_refresh_after_turn(job.chat_id, cwd)
        if not job.interrupted and not resumed and not restart_killed:
            # In a thread: a ping can sit on the network, and teardown shouldn't wait.
            threading.Thread(target=_announce_end, args=(job,), daemon=True).start()
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
    surface's permission posture and its project's Claude profile (it is new
    to the bridge, and its history is Claude's), and mark it bridge-origin.
    Resume continuity (claude_session_id) and cwd are preserved."""
    path = transcript_jsonl.find_transcript(session.get("claude_session_id"))
    if path:
        data = transcript_jsonl.parse_jsonl(path)
        store.import_transcript(session["id"], data["turns"], data["events"])
    if not session.get("permission_mode"):
        store.set_permission_mode(session["id"], _surface_default_permission(origin))
    if not session.get("profile_id"):
        store.set_session_field(session["id"], "profile_id",
                                profiles.claude_default(session["project"]))
    store.set_origin(session["id"], "bridge")


def _resolve_session(chat_id: int, project_dir: str, *, session_id: str | None,
                     permission_mode: str | None, origin: str | None,
                     profile_id: str | None = None) -> dict:
    """Resolve/create the session row. A new one is bound to the profile the
    caller named, else its project's default; a bound one gets no seeded mode,
    so the profile's applies (spec: Creation and switching)."""
    project = rel(project_dir)
    pid = profile_id if profiles.get(profile_id) else profiles.project_default(project)
    return store.ensure_session(
        chat_id, project, session_id, origin=origin, cwd=project_dir,
        permission_mode=permission_mode or (None if pid else _surface_default_permission(origin)),
        profile_id=pid)


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
    return session, cwd, permission_mode or profiles.effective(session)["permission_mode"]


def start_streaming_job(chat_id: int, prompt: str, image_paths: list[str],
                        project: str | None = None, job_id: str | None = None,
                        model: str | None = None, effort: str | None = None,
                        permission_mode: str | None = None,
                        session_id: str | None = None,
                        profile_id: str | None = None,
                        origin: str | None = None, ponytail: str | None = None,
                        account_slot: int | None = None,
                        runtime: str | None = None,
                        mcp_on: str | None = None,
                        extra_args: list[str] | None = None,
                        hang_timeout: float | None = None,
                        skip_pack: bool = False) -> Job | None:
    """Acquire the busy lock and start a streaming run. Returns None if busy.

    Resolves (or creates) the store session and runs it in the session's own cwd
    with its own model and permission posture (an explicit model/permission_mode
    wins for this run and is not written back); --resume continuity comes from
    that session's claude_session_id. `origin` marks where a newly-created
    session started; `profile_id` binds a newly-created session to that profile
    (else its project's default). A bound session's model/effort/permission and
    Claude account follow the profile wherever the caller leaves them unset; a
    profile whose account slot is gone or disabled refuses the run (job.refusal)
    instead of silently running on another login.

    account_slot picks which Claude login runs the turn (None = the ambient one,
    or the bound profile's); another login than the profile's moves the session
    to that login's profile (profiles.follow_account), so the next turn stays
    there. runtime is set instead when a fallback-ladder free
    agent takes over. Both are recorded on the turn so the transcript shows what
    produced it. A profile on another agent makes it runtime 'acp:<agent>': an
    AcpJob with that profile's account in job.acp_account, and no claude
    session id minted for it. Such a session never runs on a Claude account,
    even one the caller names: that refuses the run.

    hang_timeout caps the silence the watchdog allows this run (None = RUN_TIMEOUT).

    skip_pack runs it as _base_cmd's internal one-shot: no context pack, no tools and
    no MCP servers at all, for a prompt that carries untrusted text and needs no tools
    (a Rivendell meeting's notes). Such a turn that dies is not resumed: the resume
    would run with tools, and its caller has already taken the failure.

    Claims only THIS session's run slot, so a run in another project/session keeps
    going; returns None only if this very session already has an in-flight turn,
    or once the bridge is going down."""
    if state.shutting_down:
        # _shutdown stops the children it can see: a claude spawned now would
        # miss that, and outlive an in-place re-exec beside its resumed session.
        return None
    project_dir = project or state.project_dir(chat_id)
    session = _resolve_session(chat_id, project_dir, session_id=session_id,
                               permission_mode=permission_mode, origin=origin,
                               profile_id=profile_id)
    if not state.acquire_run(session["id"], chat_id):
        return None
    try:
        session, cwd, perm = _finalize_run_context(
            session, project_dir, permission_mode=permission_mode, origin=origin)
        # The session's own model unless the caller brought one: the /run routes
        # save theirs to the row; internal callers (Rivendell, trackers, goals)
        # run theirs without writing it. Neither = no --model, the CLI default.
        # Same for effort/account: the profile only fills what the caller didn't
        # bring, and never overrides an explicit account_slot/runtime (an agent
        # session refuses one instead, below).
        eff = profiles.effective(session)
        model = model or eff["model"]
        effort = effort or eff["effort"]
        refusal = profiles.refusal(eff, chat_id) if account_slot is None and runtime is None else None
        if account_slot is None and runtime is None and not refusal:
            account_slot = profiles.claude_slot(eff)
        if eff["agent"] != profiles.CLAUDE:
            # Its own agent or nothing: a caller's Claude account (or another
            # runtime) would mint a claude id beside the agent's history.
            if account_slot is not None or runtime not in (None, f"acp:{eff['agent']}"):
                refusal = profiles.claude_account_refusal(eff["agent"])
            account_slot, runtime = None, f"acp:{eff['agent']}"
        if team.refusal(session.get("origin")):
            # A teammate's device run or a session a teammate sent (bridge/device_view.py,
            # bridge/team.py): read only, on every account.
            refusal, account_slot = team.refusal(session.get("origin")), None
        if account_slot is not None:
            profiles.follow_account(session, account_slot)
        is_acp = (runtime or "").startswith("acp:")
        job = (AcpJob if is_acp else Job)(job_id or uuid.uuid4().hex, chat_id, session["id"])
        job.model = model
        job.refusal = refusal
        if is_acp:
            job.acp_account = eff["account"]   # and never a minted claude id
        elif not refusal:
            # A brand-new session's id is minted and PERSISTED here (before the
            # child spawns). Skipped on a refusal: nothing will ever adopt it, so
            # persisting it would brick the next (post-fix) attempt into
            # --resume-ing a transcript that was never created.
            job.resume_id, job.new_session, job.fork = _claim_session_id(
                session["id"], session["claude_session_id"])
        job.account_slot = account_slot
        job.project = session.get("project")
        # A tree an earlier turn moved onto, while it is still there (_session_brief's rule).
        wt = session.get("work_cwd")
        job.work_cwd = wt if wt and os.path.isdir(wt) else None
        job.mcp_on, job.extra_args = mcp_on, list(extra_args or [])
        job.skip_pack = skip_pack
        if runtime is None and account_slot and account_slot != accounts.DEFAULT_SLOT:
            runtime = f"claude:{account_slot}"
        job.runtime = runtime
        job.hang_timeout = hang_timeout
        _register(job)
        store.start_turn(session["id"], job.id, prompt,
                         [os.path.basename(p) for p in image_paths], model=model,
                         runtime=runtime, sha=git.head_sha(cwd),
                         effort=effort or "auto", permission_mode=perm)
        from bridge import titler  # local import: runner<->* cycle
        titler.kick(chat_id, session, job.id)
        waits.drop(session["id"])   # a new turn here ends its wait; Claude can wait again
        _ensure_journal_thread()
        threading.Thread(target=_run_streaming,
                         args=(job, prompt, image_paths, cwd, model, effort, perm,
                               ponytail),
                         daemon=True).start()
        return job
    except BaseException:
        state.release_run(session["id"])
        raise
