"""Set up and Remove (bridge/device_setup.py): one macOS admin-password prompt runs
bridge/device_setup/setup.sh or remove.sh as root through osascript.

Nothing here runs a script or osascript: `run=` is a fake that records the
command and answers the way osascript does, and the scripts only go through
`bash -n`, which parses without running.
Run: python -m pytest tests/test_device_setup.py -v
"""

import getpass
import os
import shlex
import subprocess

import pytest

from bridge import device_setup, device_share

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bridge", "device_setup")
PREFIX, SUFFIX = "do shell script ", " with administrator privileges"


def fake(rc=0, out="", err=""):
    calls = []

    def run(cmd, **kw):
        calls.append((cmd, kw))
        if isinstance(rc, BaseException):
            raise rc
        return subprocess.CompletedProcess(cmd, rc, out, err)

    run.calls = calls
    return run


def _read_applescript(literal):
    """An AppleScript string literal read back the way AppleScript reads it:
    a backslash takes the next character as it is, and a bare quote would end it."""
    assert literal[0] == literal[-1] == '"'
    body, out, i = literal[1:-1], [], 0
    while i < len(body):
        if body[i] == "\\":
            out.append(body[i + 1])
            i += 2
            continue
        assert body[i] != '"', "an unescaped quote would end the string early"
        out.append(body[i])
        i += 1
    return "".join(out)


@pytest.mark.parametrize("action, script", [("setup", "setup.sh"), ("remove", "remove.sh")])
@pytest.mark.parametrize("owner", ["mahziyar", "o'brien \"x\" \\ $(rm -rf ~) `id` ;|&"])
def test_the_owner_reaches_the_script_as_one_argument_however_it_is_spelled(action, script, owner):
    run = fake(out='{"ok": true}\n')
    device_setup.run(action, owner, run=run)
    (cmd, kw), = run.calls
    assert cmd[:2] == ["osascript", "-e"] and len(cmd) == 3
    assert kw["timeout"] == 900
    assert cmd[2].startswith(PREFIX) and cmd[2].endswith(SUFFIX)
    shell = _read_applescript(cmd[2][len(PREFIX):-len(SUFFIX)])
    assert shlex.split(shell) == ["/bin/bash", os.path.join(SCRIPTS, script), owner]
    assert os.path.isfile(os.path.join(SCRIPTS, script))


def test_the_owner_defaults_to_this_account():
    run = fake(out='{"ok": true}\n')
    device_setup.run("setup", run=run)
    shell = _read_applescript(run.calls[0][0][2][len(PREFIX):-len(SUFFIX)])
    assert shlex.split(shell)[-1] == getpass.getuser()


def test_a_cancelled_password_prompt_is_cancelled():
    run = fake(rc=1, err="0:93: execution error: User canceled. (-128)\n")
    assert device_setup.run("setup", "me", run=run) == {"ok": False, "error": "Cancelled."}


def test_the_last_line_the_script_printed_is_the_answer():
    """`do shell script` hands the output back with \\r line endings."""
    out = ("creating home directories for (mysticalruns)\rinstalling Claude Code\r"
           '{"ok": true, "checks": [{"key": "xcode", "ok": true}, {"key": "pods", "ok": false}], "error": null}\n')
    assert device_setup.run("setup", "me", run=fake(out=out)) == {
        "ok": True, "checks": [{"key": "xcode", "ok": True}, {"key": "pods", "ok": False}], "error": None}
    out = 'chatter\n{"ok": false, "error": "Creating the hidden user failed."}\n'
    assert device_setup.run("remove", "me", run=fake(out=out)) == {"ok": False, "error": "Creating the hidden user failed."}


@pytest.mark.parametrize("why, run", [
    ("osascript failed", fake(rc=1, err="0:12: execution error: /bin/bash: no such file (127)\n")),
    ("no JSON came back", fake(out="half an answer\n")),
    ("the prompt sat for 15 minutes", fake(rc=subprocess.TimeoutExpired("osascript", 900))),
])
def test_no_answer_is_a_failure_not_a_crash(why, run):
    r = device_setup.run("setup", "me", run=run)
    assert r["ok"] is False and r["error"], why


@pytest.mark.parametrize("script", ["setup.sh", "remove.sh"])
def test_the_scripts_parse(script):
    r = subprocess.run(["/bin/bash", "-n", os.path.join(SCRIPTS, script)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr


@pytest.mark.parametrize("script", ["setup.sh", "remove.sh"])
def test_the_scripts_and_the_bridge_name_the_same_paths(script):
    with open(os.path.join(SCRIPTS, script), encoding="utf-8") as f:
        text = f.read()
    for path in (device_share.HELPER, device_share.RUNS_CONFIG, "/etc/sudoers.d/mystical-runs", "/Users/Shared/Mystical Runs"):
        assert path in text, path
