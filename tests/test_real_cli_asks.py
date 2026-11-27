"""The asks the runner answers by itself (runner._own_memory_write), checked against
the real `claude`: a memory note written through a login's projects/ symlink lands
with no card in every mode that asks, and the writes it must leave to you still raise
one. The runner keys on the exact fields of the CLI's can_use_tool (2.1.329: a
safetyCheck, plus matched_ask_rule when an ask rule matched too), and claude updates
itself, so re-run this after an update or a change to the runner's permission code.

Opt-in: it signs in and spends tokens (5 short haiku turns, about 25 s). Name a login
past the first, whose projects/ links into ~/.claude/projects:

    MYSTICAL_REAL_CLI=3 python3 -m pytest tests/test_real_cli_asks.py -q
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid

import pytest

from bridge import runner

SLOT = os.environ.get("MYSTICAL_REAL_CLI", "")
CFG = os.path.expanduser(f"~/.mystical/accounts/{SLOT}")   # conftest moves ACCOUNTS_DIR off the real one
CLAUDE = shutil.which("claude")                          # ...and CLAUDE_BIN, so runner.claude_bin() can't
pytestmark = pytest.mark.skipif(
    not (SLOT.isdigit() and int(SLOT) != runner.accounts.DEFAULT_SLOT
         and os.path.islink(os.path.join(CFG, "projects")) and CLAUDE),
    reason="opt-in: MYSTICAL_REAL_CLI=<a login past the first> and claude on PATH")


@pytest.fixture
def project(monkeypatch):
    """A throwaway project folder and its memory folder in the login; both go after."""
    cwd = os.path.realpath(tempfile.mkdtemp(prefix="realcli-"))
    folder = os.path.join(CFG, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd))
    monkeypatch.setattr(runner.accounts, "profile_dir", lambda slot: CFG if str(slot) == SLOT else "/nowhere")
    monkeypatch.setattr(runner, "notify_awaiting", lambda *a, **k: None)
    yield cwd, os.path.join(folder, "memory")
    shutil.rmtree(cwd, ignore_errors=True)
    shutil.rmtree(folder, ignore_errors=True)


def _turn(mode: str, cwd: str, path: str, settings: "dict | None" = None):
    """One haiku turn told to Write `path`, its asks answered by the runner's own
    _handle_control_request; a card it leaves is refused, as you might.
    Returns the cards as (tool, file_path) and whether the file landed."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDECODE", "CLAUDE_CODE_"))}
    env["CLAUDE_CONFIG_DIR"] = CFG
    proc = subprocess.Popen(
        [CLAUDE, "-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
         "--permission-mode", mode, "--permission-prompt-tool", "stdio",
         "--allow-dangerously-skip-permissions", "--model", "haiku", "--strict-mcp-config",
         "--no-session-persistence", "--settings", json.dumps({"disableAllHooks": True, **(settings or {})})],
        cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1)
    hung = threading.Timer(120, proc.kill)
    hung.start()
    job = runner.Job("realcli", 555, "realcli")
    job.proc, job.account_slot, job.cwd = proc, int(SLOT), cwd
    job._write_stdin({"type": "user", "message": {"role": "user", "content":
        f"Use the Write tool exactly once to create the file {path} with the content 'probe'. "
        "Use no other tool. If the write is refused, reply 'refused' and stop."}})
    cards = []
    try:
        for line in proc.stdout:
            o = json.loads(line) if line.startswith("{") else {}
            if o.get("type") == "control_request":
                runner._handle_control_request(job, o)
                for p in list(job.pending):
                    cards.append((p["tool_name"], p["input"].get("file_path")))
                    job.respond(p["request_id"], behavior="deny")
            elif o.get("type") == "result":
                break
    finally:
        hung.cancel()
        proc.stdin.close()
        proc.wait(timeout=30)
    landed = os.path.exists(path)
    if landed:
        os.remove(path)
    return cards, landed


@pytest.mark.parametrize("mode", ["auto", "default", "acceptEdits"])
def test_a_memory_note_lands_with_no_card(project, mode):
    cwd, mem = project
    assert _turn(mode, cwd, os.path.join(mem, "realcli-probe.md")) == ([], True)


def test_an_ask_rule_for_write_still_asks_for_a_memory_note(project):
    """2.1.329 reports this as the symlink's safetyCheck, the rule only in
    matched_ask_rule; plain ~/.claude asks here too."""
    cwd, mem = project
    path = os.path.join(mem, "realcli-probe.md")
    assert _turn("auto", cwd, path, {"permissions": {"ask": ["Write"]}}) == ([("Write", path)], False)


def test_another_projects_memory_still_asks(project):
    cwd, _mem = project
    other = os.path.join(CFG, "projects", f"-realcli-elsewhere-{uuid.uuid4().hex[:8]}")
    path = os.path.join(other, "memory", "realcli-probe.md")
    os.makedirs(os.path.dirname(path))
    try:
        assert _turn("auto", cwd, path) == ([("Write", path)], False)
    finally:
        shutil.rmtree(other, ignore_errors=True)
