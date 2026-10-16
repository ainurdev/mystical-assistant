"""The root helper (bridge/device_setup/mystical_run_helper.py), imported by path.

Root runs it through sudo, so nothing here runs it for real. Its pure functions
are checked on their own. `start` and `stop` go through `main` with `popen=` set
to a Runner, which records each command and runs it without the `sudo …` in
front, as you. Temp dirs stand in for the real paths: the helper's RUNS_HOME
and STAGE_ROOT, and a temp config through MYSTICAL_RUNS_CONFIG (which the helper
reads only when it is not root). "Claude" is a shell script that does what a run
would: saves screenshots and prints its report.
Run: python -m pytest tests/test_run_helper.py -v
"""

import importlib.util
import io
import json
import os
import pwd
import stat
import subprocess
import sys
import tarfile
import threading
import time
import types

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, "bridge", "device_setup", "mystical_run_helper.py")

_spec = importlib.util.spec_from_file_location("mystical_run_helper", HELPER)
h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(h)

RUN_ID = "0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19"
TOKEN = "sk-ant-oat01-a-teammates-token"
ME = os.getuid()
JOB = {"prompt": "Test the app on the iOS simulator for RIV-42.", "gitAuthorName": "Mahdi",
       "gitAuthorEmail": "mahdi@example.com", "developerDir": "/Applications/Xcode.app/Contents/Developer",
       "timeoutSeconds": 60}


# --- valid_run_id -------------------------------------------------------------------

@pytest.mark.parametrize("s", [RUN_ID, "00000000-0000-0000-0000-000000000000"])
def test_a_run_id_is_a_lowercase_uuid(s):
    assert h.valid_run_id(s)


@pytest.mark.parametrize("s", ["", "..", "../x", "../" + RUN_ID, RUN_ID + "/..", RUN_ID.upper(),
                               RUN_ID + "\n", RUN_ID[:-1], "g" + RUN_ID[1:], None, 7])
def test_anything_else_is_not_a_run_id(s):
    assert not h.valid_run_id(s)


# --- check_stage, on os.lstat fakes ---------------------------------------------------

STAGE = "/Users/Shared/Mystical Runs/" + RUN_ID
OWNER = 501


def _st(kind, mode, uid=OWNER):
    return types.SimpleNamespace(st_mode=kind | mode, st_uid=uid)


GOOD = {STAGE: _st(stat.S_IFDIR, 0o700),
        **{STAGE + "/" + n: _st(stat.S_IFREG, 0o600) for n in ("job.json", "token", "code.tar.gz")}}


def _lstat(table):
    def lstat(path):
        if path not in table:
            raise FileNotFoundError(path)
        return table[path]
    return lstat


def test_the_owners_private_stage_with_its_three_files_passes():
    assert h.check_stage(STAGE, OWNER, lstat=_lstat(GOOD)) is None


@pytest.mark.parametrize("why, change", [
    ("a symlink", {STAGE: _st(stat.S_IFLNK, 0o755)}),
    ("a stranger's folder", {STAGE: _st(stat.S_IFDIR, 0o700, uid=502)}),
    ("root's folder", {STAGE: _st(stat.S_IFDIR, 0o700, uid=0)}),
    ("open to everyone (0755)", {STAGE: _st(stat.S_IFDIR, 0o755)}),
    ("open to the group (0750)", {STAGE: _st(stat.S_IFDIR, 0o750)}),
    ("a file, not a folder", {STAGE: _st(stat.S_IFREG, 0o700)}),
    ("the token is a symlink", {STAGE + "/token": _st(stat.S_IFLNK, 0o777)}),
    ("the snapshot is root's", {STAGE + "/code.tar.gz": _st(stat.S_IFREG, 0o600, uid=0)}),
    ("the job is a fifo", {STAGE + "/job.json": _st(stat.S_IFIFO, 0o600)}),
])
def test_a_stage_that_cannot_be_trusted_is_refused(why, change):
    assert h.check_stage(STAGE, OWNER, lstat=_lstat({**GOOD, **change})), why


@pytest.mark.parametrize("gone", [STAGE, STAGE + "/job.json", STAGE + "/token", STAGE + "/code.tar.gz"])
def test_a_missing_stage_or_stage_file_is_refused(gone):
    assert h.check_stage(STAGE, OWNER, lstat=_lstat({k: v for k, v in GOOD.items() if k != gone}))


# --- claude_env, claude_argv, launch_argv -----------------------------------------------

def test_claude_gets_exactly_its_own_environment(monkeypatch):
    monkeypatch.setenv("SSH_AUTH_SOCK", "/private/tmp/the-owners-agent")   # what sudo carries over
    monkeypatch.setenv("ANTHROPIC_API_KEY", "the-owners-key")
    run = "/Users/mysticalruns/runs/" + RUN_ID
    assert h.claude_env(JOB, TOKEN, run) == {
        "HOME": "/Users/mysticalruns",
        "PATH": "/Users/mysticalruns/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "CLAUDE_CODE_OAUTH_TOKEN": TOKEN,
        "CLAUDE_CONFIG_DIR": run + "/config",
        "MYSTICAL_RUN_OUT": run + "/out",
        "DEVELOPER_DIR": "/Applications/Xcode.app/Contents/Developer",
        "GIT_AUTHOR_NAME": "Mahdi",
        "GIT_AUTHOR_EMAIL": "mahdi@example.com",
        "GIT_COMMITTER_NAME": "Mahdi",
        "GIT_COMMITTER_EMAIL": "mahdi@example.com",
        "LANG": "en_US.UTF-8",
    }


@pytest.mark.parametrize("dev", [None, ""])
def test_no_developer_dir_in_the_job_is_none_in_the_environment(dev):
    assert "DEVELOPER_DIR" not in h.claude_env({**JOB, "developerDir": dev}, TOKEN, "/r")


def test_claude_runs_headless_with_every_tool_and_no_mcp_server():
    assert h.claude_argv("hi") == [
        "/Users/mysticalruns/.local/bin/claude", "-p", "hi", "--output-format", "json",
        "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
    assert h.claude_argv("hi", "/opt/elsewhere/claude")[0] == "/opt/elsewhere/claude"


def test_a_run_launches_through_sudo_or_launchctl_asuser_and_nothing_else():
    inner = ["/x/claude", "-p", "hi"]
    # -E: sudo hands the command the environment it was given (claude_env), so
    # the token never has to be spelled out in an argument list.
    assert h.launch_argv("sudo", 502, inner) == ["/usr/bin/sudo", "-E", "-u", "mysticalruns", "-H", *inner]
    assert h.launch_argv("asuser", 502, inner) == [
        "/bin/launchctl", "asuser", "502", "/usr/bin/sudo", "-E", "-u", "mysticalruns", "-H", *inner]
    for bad in ("root", "", None, "SUDO", "asuser "):
        with pytest.raises(ValueError):
            h.launch_argv(bad, 502, inner)


# --- start and stop, against temp dirs --------------------------------------------------

class Runner:
    """subprocess.Popen, minus the user switch: records each command, then runs it
    without the `/usr/bin/sudo [-E] -u <user> [-H]` in front, as you."""

    def __init__(self):
        self.calls, self.procs = [], []

    def __call__(self, argv, **kw):
        self.calls.append(list(argv))
        if argv[0] == "/usr/bin/sudo":
            argv = argv[1:]
            while argv[0].startswith("-"):
                argv = argv[2:] if argv[0] == "-u" else argv[1:]
        p = subprocess.Popen(argv, **kw)
        self.procs.append(p)
        return p


def _snapshot(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, text in files.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(text.encode()), 0o644
            t.addfile(info, io.BytesIO(text.encode()))
    return buf.getvalue()


@pytest.fixture
def box(tmp_path, monkeypatch):
    """The real paths, in a temp dir: the runs folder, the stage root, the config,
    and mysticalruns, who is you here."""
    b = types.SimpleNamespace(tmp=tmp_path, runs=tmp_path / "runs", stages=tmp_path / "stages",
                              cfg=tmp_path / "mystical-runs.json", claude=tmp_path / "claude")
    b.runs.mkdir(mode=0o700)
    b.stages.mkdir()
    b.cfg.write_text(json.dumps({"owner": "me", "uid": ME, "launch": "sudo", "claude": str(b.claude)}))
    b.cfg.chmod(0o644)
    monkeypatch.setattr(h, "RUNS_HOME", str(b.runs))
    monkeypatch.setattr(h, "STAGE_ROOT", str(b.stages))
    monkeypatch.setenv("MYSTICAL_RUNS_CONFIG", str(b.cfg))
    monkeypatch.setenv("SUDO_UID", str(ME))
    real = pwd.getpwnam
    monkeypatch.setattr(pwd, "getpwnam", lambda n: types.SimpleNamespace(pw_uid=ME) if n == "mysticalruns" else real(n))
    return b


def _claude(b, body):
    b.claude.write_text("#!/bin/sh\n" + body)
    b.claude.chmod(0o755)


def _stage(b, job=JOB, where=None):
    """What the owner's bridge leaves for a run: a 0700 folder with job.json, token and code.tar.gz."""
    d = where or b.stages / RUN_ID
    d.mkdir()
    d.chmod(0o700)
    (d / "job.json").write_text(json.dumps(job))
    (d / "token").write_text(TOKEN + "\n")
    (d / "code.tar.gz").write_bytes(_snapshot({"README.md": "hello\n", "app/main.swift": "print(1)\n"}))
    return d


def _left_behind(b, st):
    """What a finished run must not leave: the stage's token, or the run's folder."""
    return [str(p) for p in (st / "token", b.runs / RUN_ID) if os.path.lexists(p)]


def test_a_run_comes_back_with_its_report_and_screens_and_leaves_no_token(box):
    _claude(box, """
cd_ok=$(cat README.md)
printf 'png' > "$MYSTICAL_RUN_OUT/screens/01-home.png"
printf 'x' > "$MYSTICAL_RUN_OUT/screens/.hidden.png"
ln -s /etc/hosts "$MYSTICAL_RUN_OUT/screens/02-link.png"
mkdir "$MYSTICAL_RUN_OUT/screens/deeper" && printf 'x' > "$MYSTICAL_RUN_OUT/screens/deeper/03.png"
printf 'mine' > "$MYSTICAL_RUN_OUT/exit.json"
printf '{"result": "%s", "cwd": "%s", "token": "%s", "config": "%s"}' \\
  "$cd_ok" "$PWD" "$CLAUDE_CODE_OAUTH_TOKEN" "$CLAUDE_CONFIG_DIR"
""")
    st = _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 0

    report = json.loads((st / "out" / "claude.json").read_text())
    assert report["result"] == "hello" and report["cwd"].endswith("/runs/" + RUN_ID + "/code")
    assert report["token"] == TOKEN and report["config"] == str(box.runs / RUN_ID / "config")
    assert json.loads((st / "out" / "exit.json").read_text()) == {"code": 0, "timedOut": False}, \
        "exit.json is the helper's, whatever the run wrote under that name"
    # Only plain files with plain names come back: no link, no hidden file, no subfolder.
    assert sorted(os.listdir(st / "out" / "screens")) == ["01-home.png"]
    assert (st / "out" / "screens" / "01-home.png").read_bytes() == b"png"
    assert _left_behind(box, st) == []
    assert (st / "job.json").exists(), "the rest of the stage is the bridge's to remove"

    install, untar, launch, writer, reader = run.calls
    code = str(box.runs / RUN_ID / "code")
    assert install[:3] == ["/usr/bin/sudo", "-u", "mysticalruns"] and install[3:6] == ["/usr/bin/install", "-d", "-m"]
    assert untar == ["/usr/bin/sudo", "-u", "mysticalruns", "/usr/bin/tar", "-xzf", "-", "-C", code, "--no-same-owner"]
    assert launch == h.launch_argv("sudo", ME, h.claude_argv(JOB["prompt"], str(box.claude)))
    assert reader[:3] == ["/usr/bin/sudo", "-u", "mysticalruns"], "the screens are read as the run's user"
    assert writer[:3] == ["/usr/bin/sudo", "-u", "#%d" % ME], "and written as the owner"
    assert not [a for c in run.calls for a in c if TOKEN in a], "the token is never in a command line (ps shows those)"


def test_a_run_that_times_out_is_killed_and_still_cleaned_up(box):
    _claude(box, "sleep 30\n")
    st = _stage(box, job={**JOB, "timeoutSeconds": 1})
    run = Runner()
    began = time.monotonic()
    assert h.main(["start", RUN_ID], popen=run) == 0
    assert time.monotonic() - began < h.GRACE + 5, "killed at the timeout, not left to run its 30 s"
    done = json.loads((st / "out" / "exit.json").read_text())
    assert done["timedOut"] is True and done["code"] != 0
    # Nothing of the run's process group is left alive (macOS answers EPERM, not
    # ESRCH, while an exited member waits to be reaped).
    with pytest.raises((ProcessLookupError, PermissionError)):
        os.killpg(run.procs[2].pid, 0)
    assert _left_behind(box, st) == []


def test_stop_ends_a_running_run_and_start_still_reports_and_cleans_up(box):
    _claude(box, "sleep 30\n")
    st = _stage(box)
    run, rc = Runner(), []
    t = threading.Thread(target=lambda: rc.append(h.main(["start", RUN_ID], popen=run)))
    t.start()
    pid = box.runs / RUN_ID / "pid"
    deadline = time.monotonic() + 10
    while not (pid.exists() and pid.read_text().strip()) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert h.main(["stop", RUN_ID]) == 0
    t.join(15)
    assert rc == [0]
    assert json.loads((st / "out" / "exit.json").read_text()) == {"code": -15, "timedOut": False}
    assert _left_behind(box, st) == []


def test_stopping_a_run_that_is_not_running_is_no_error(box):
    assert h.main(["stop", RUN_ID]) == 0


@pytest.mark.parametrize("plant", ["symlink", "hard link"])
def test_stop_trusts_only_the_pid_file_start_wrote(box, plant, capsys):
    """The run's folder is the run's to fill: a pid file it planted names no process group."""
    (box.runs / RUN_ID).mkdir()
    planted = box.tmp / "planted"
    planted.write_text("99999\n")
    if plant == "symlink":
        (box.runs / RUN_ID / "pid").symlink_to(planted)
    else:
        os.link(planted, box.runs / RUN_ID / "pid")
    assert h.main(["stop", RUN_ID]) != 0
    assert len(capsys.readouterr().err.strip().splitlines()) == 1


@pytest.mark.parametrize("sudo_uid", [str(ME + 1), "0", "", None])
def test_only_the_recorded_owner_may_start_or_stop(box, monkeypatch, capsys, sudo_uid):
    if sudo_uid is None:
        monkeypatch.delenv("SUDO_UID")
    else:
        monkeypatch.setenv("SUDO_UID", sudo_uid)
    st = _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert h.main(["stop", RUN_ID], popen=run) == 2
    assert run.calls == [] and (st / "token").exists(), "refused before anything is touched"
    assert len(capsys.readouterr().err.strip().splitlines()) == 2, "one stderr line each"


@pytest.mark.parametrize("rid", ["../x", "..", RUN_ID.upper(), "", "../" + RUN_ID])
def test_a_run_id_that_is_not_a_uuid_touches_nothing(box, rid):
    run = Runner()
    assert h.main(["start", rid], popen=run) == 2
    assert h.main(["stop", rid], popen=run) == 2
    assert run.calls == []


def test_a_stage_that_is_a_symlink_is_refused(box):
    real = _stage(box, where=box.tmp / "somewhere-else")
    (box.stages / RUN_ID).symlink_to(real)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert run.calls == [] and (real / "token").exists()


@pytest.mark.parametrize("swap", ["the folder", "the token"])
def test_what_start_opens_is_checked_again_so_a_late_swap_is_refused(box, swap):
    """check_stage looks first; the files start actually reads are opened without
    following a link and checked again, so a link swapped in between gets nowhere."""
    real = _stage(box, where=box.tmp / "real")
    if swap == "the folder":
        (box.stages / RUN_ID).symlink_to(real)
    else:
        st = _stage(box)
        (st / "token").unlink()
        (st / "token").symlink_to(real / "token")
    with pytest.raises(h.Refused):
        h._open_stage(str(box.stages / RUN_ID), ME)


def test_a_config_others_can_change_is_not_trusted(box):
    box.cfg.chmod(0o664)
    _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert run.calls == []


def test_a_config_without_claude_means_set_up_has_not_finished(box, capsys):
    box.cfg.write_text(json.dumps({"owner": "me", "uid": ME, "launch": "sudo"}))
    _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert run.calls == [] and "Set up" in capsys.readouterr().err


def test_a_snapshot_that_will_not_unpack_fails_in_one_line_and_cleans_up(box, capsys):
    st = _stage(box)
    (st / "code.tar.gz").write_bytes(b"not a tarball")
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) not in (0, None)
    assert len(capsys.readouterr().err.strip().splitlines()) == 1
    assert len(run.calls) == 2, "Claude never started"
    assert _left_behind(box, st) == []


# --- the interpreter root runs it with ------------------------------------------------------

def _system_python():
    """/usr/bin/python3, unless on a Mac without developer tools, where it is a
    shim that pops up an installer instead of running."""
    if not os.path.exists("/usr/bin/python3"):
        return None
    if sys.platform == "darwin" and not (os.path.isdir("/Library/Developer/CommandLineTools")
                                         or os.path.isdir("/Applications/Xcode.app")):
        return None
    return "/usr/bin/python3"


@pytest.mark.skipif(_system_python() is None, reason="no system python3 to check against")
def test_the_helper_is_isolated_and_parses_under_the_system_python():
    """Root runs it as `/usr/bin/python3 -I`, which can be as old as 3.9."""
    with open(HELPER, encoding="utf-8") as f:
        assert f.readline() == "#!/usr/bin/python3 -I\n"
    r = subprocess.run([_system_python(), "-I", "-c",
                        "import sys; compile(open(sys.argv[1]).read(), sys.argv[1], 'exec')", HELPER],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
