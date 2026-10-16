"""Set up and Remove (bridge/device_setup.py): one macOS admin-password prompt runs
bridge/device_setup/setup.sh or remove.sh as root through osascript.

Nothing here runs a script or osascript: `run=` is a fake that records the
command and answers the way osascript does, and the scripts only go through
`bash -n`, which parses without running. setup.sh's root_only, the bash twin of
the helper's check_root_path, runs on its own with `fail` stubbed; it only reads.
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


def _root_only(path):
    """What setup.sh's root_only says about `path`: "ok", or the line it fails with."""
    with open(os.path.join(SCRIPTS, "setup.sh"), encoding="utf-8") as f:
        text = f.read()
    start = text.index("root_only() {")
    fn = text[start:text.index("\n}\n", start) + 3]
    r = subprocess.run(["/bin/bash", "-c", 'fail() { echo "$1"; exit 1; }\n' + fn + 'root_only "$1"; echo ok', "_", path],
                       capture_output=True, text=True, timeout=30)
    return r.stdout.strip()


def test_set_up_refuses_a_folder_anyone_but_root_could_change_as_the_helper_does(tmp_path):
    assert _root_only("/usr/bin") == "ok"
    # A link on a Mac, world-writable elsewhere: either way /tmp is the one named.
    assert _root_only("/tmp/helper").startswith("/tmp ")
    world = os.path.realpath("/tmp")   # root's own, but anyone can write in it
    assert _root_only(world + "/helper").startswith(world + " can be changed by someone other than root")
    # The temp dir is yours: the first folder on the way down that isn't root's is named.
    culprit = _root_only(str(tmp_path)).split(" ")[0]
    assert culprit != "ok" and str(tmp_path).startswith(culprit) and os.stat(culprit).st_uid != 0


@pytest.mark.parametrize("script", ["setup.sh", "remove.sh"])
def test_the_scripts_and_the_bridge_name_the_same_paths(script):
    with open(os.path.join(SCRIPTS, script), encoding="utf-8") as f:
        text = f.read()
    for path in (device_share.HELPER, device_share.RUNS_CONFIG, "/etc/sudoers.d/mystical-runs",
                 "/Users/Shared/Mystical Runs", "/usr/local/libexec/mystical-runs",
                 "/usr/lib/cron/cron.deny", "/usr/lib/cron/at.deny"):
        assert path in text, path


def _run_function(script, name, *args):
    """The bash function `name`, cut out of `script` and run on `args` alone under
    the script's own `set -euo pipefail` and ERR trap, with its RUN_USER, and
    `fail` stubbed (it prints and exits 1)."""
    with open(os.path.join(SCRIPTS, script), encoding="utf-8") as f:
        text = f.read()
    start = text.index(name + "() {")
    fn = text[start:text.index("\n}\n", start) + 3]
    head = 'set -euo pipefail\nRUN_USER=mysticalruns\nfail() { echo "$1"; exit 1; }\ntrap \'fail trapped\' ERR\n'
    return subprocess.run(["/bin/bash", "-c", head + fn + name + ' "$@"', "_", *args],
                          capture_output=True, text=True, timeout=30)


def test_set_up_keeps_the_hidden_user_out_of_cron_and_at_once(tmp_path):
    """Nothing a run schedules starts later. Run twice, it adds the name once; a
    deny file whose last line has no newline keeps that line as it was."""
    cron, at, bare = tmp_path / "cron.deny", tmp_path / "at.deny", tmp_path / "bare.deny"
    cron.write_text("Guest\n")
    at.write_text("")
    bare.write_text("Guest")
    for _ in range(2):
        r = _run_function("setup.sh", "deny_cron", str(cron), str(at), str(bare))
        assert r.returncode == 0, r.stdout + r.stderr
    assert cron.read_text() == "Guest\nmysticalruns\n" and at.read_text() == "mysticalruns\n"
    assert bare.read_text() == "Guest\nmysticalruns\n", "Guest stays denied: the name isn't glued onto its line"


def test_set_up_makes_no_deny_file_that_was_not_there(tmp_path):
    """With neither at.allow nor at.deny only root may use at: a deny file made
    here would let every other user in."""
    r = _run_function("setup.sh", "deny_cron", str(tmp_path / "at.deny"))
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (tmp_path / "at.deny").exists()


def test_set_up_wont_write_through_a_deny_file_that_is_a_link(tmp_path):
    target = tmp_path / "elsewhere"
    target.write_text("x\n")
    (tmp_path / "cron.deny").symlink_to(target)
    r = _run_function("setup.sh", "deny_cron", str(tmp_path / "cron.deny"))
    assert r.returncode != 0 and target.read_text() == "x\n"


def test_remove_takes_only_the_hidden_users_line_out_and_keeps_the_file(tmp_path):
    cron, at = tmp_path / "cron.deny", tmp_path / "at.deny"
    cron.write_text("Guest\nmysticalruns\nmysticalrunsx\n")
    cron.chmod(0o640)
    at.write_text("mysticalruns\n")
    r = _run_function("remove.sh", "allow_cron", str(cron), str(at), str(tmp_path / "missing"))
    assert r.returncode == 0, r.stdout + r.stderr
    assert cron.read_text() == "Guest\nmysticalrunsx\n" and at.read_text() == ""
    assert (cron.stat().st_mode & 0o777) == 0o640, "the same file, not a new one"
    assert not (tmp_path / "missing").exists()
