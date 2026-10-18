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

import fcntl
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

@pytest.fixture(autouse=True)
def no_real_process():
    """main()'s own popen is subprocess.Popen, which as root is right. Here every
    command must go through a Runner: one that slipped past it would run for
    real, as you, and on 2026-10-16 a stop called without one ran launchctl
    bootout on the developer's own domains and logged them out. So main's
    default refuses every command, and a test that reaches it fails."""
    reached = []

    def refuse(argv, **kw):
        reached.append(list(argv))
        raise AssertionError("a command reached a real process without a Runner: %r" % (argv,))
    saved = h.main.__defaults__
    h.main.__defaults__ = (None, refuse)
    Runner.refused = []
    try:
        yield
    finally:
        h.main.__defaults__ = saved
    assert not reached, "a command reached a real process without a Runner: %r" % reached
    assert not Runner.refused, "a command no Runner would run for real: %r" % Runner.refused


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
    """A fresh home for every run, and only root's folders ahead of the tools on
    PATH: nothing a run leaves in the hidden user's home reaches the next run."""
    monkeypatch.setenv("SSH_AUTH_SOCK", "/private/tmp/the-owners-agent")   # what sudo carries over
    monkeypatch.setenv("ANTHROPIC_API_KEY", "the-owners-key")
    run = "/Users/mysticalruns/runs/" + RUN_ID
    assert h.claude_env(JOB, TOKEN, run) == {
        "HOME": run + "/home",
        "PATH": "/usr/local/libexec/mystical-runs:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "CLAUDE_CODE_OAUTH_TOKEN": TOKEN,
        "CLAUDE_CONFIG_DIR": run + "/config",
        "MYSTICAL_RUN_OUT": run + "/out",
        "DEVELOPER_DIR": "/Applications/Xcode.app/Contents/Developer",
        "GIT_AUTHOR_NAME": "Mahdi",
        "GIT_AUTHOR_EMAIL": "mahdi@example.com",
        "GIT_COMMITTER_NAME": "Mahdi",
        "GIT_COMMITTER_EMAIL": "mahdi@example.com",
        "LANG": "en_US.UTF-8",
        "DISABLE_AUTOUPDATER": "1",   # a run never updates Claude, nor downloads one into its fresh home
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
    # the token never has to be spelled out in an argument list. No -H: it would
    # reset HOME to the hidden user's own home, which every run shares.
    assert h.launch_argv("sudo", 502, inner) == ["/usr/bin/sudo", "-E", "-u", "mysticalruns", *inner]
    assert h.launch_argv("asuser", 502, inner) == [
        "/bin/launchctl", "asuser", "502", "/usr/bin/sudo", "-E", "-u", "mysticalruns", *inner]
    for bad in ("root", "", None, "SUDO", "asuser "):
        with pytest.raises(ValueError):
            h.launch_argv(bad, 502, inner)


# --- check_root_path, on os.lstat fakes ---------------------------------------------

CLAUDE = "/usr/local/libexec/mystical-runs/claude"
CONFIG = "/usr/local/etc/mystical-runs.json"
CHAIN = {**{p: _st(stat.S_IFDIR, 0o755, uid=0) for p in
            ("/", "/usr", "/usr/local", "/usr/local/libexec", "/usr/local/libexec/mystical-runs", "/usr/local/etc")},
         CLAUDE: _st(stat.S_IFREG, 0o755, uid=0), CONFIG: _st(stat.S_IFREG, 0o644, uid=0)}


@pytest.mark.parametrize("path", [CLAUDE, CONFIG, "/usr/local/etc", "/"])
def test_a_path_only_root_can_change_passes(path):
    assert h.check_root_path(path, lstat=_lstat(CHAIN)) is None


@pytest.mark.parametrize("why, path, bad, change", [
    ("the binary is group-writable", CLAUDE, CLAUDE, _st(stat.S_IFREG, 0o775, uid=0)),
    ("the binary is anyone's to write", CLAUDE, CLAUDE, _st(stat.S_IFREG, 0o757, uid=0)),
    ("the binary is someone else's", CLAUDE, CLAUDE, _st(stat.S_IFREG, 0o755, uid=501)),
    ("the binary is a link", CLAUDE, CLAUDE, _st(stat.S_IFLNK, 0o755, uid=0)),
    ("its folder is group-writable", CLAUDE, "/usr/local/libexec/mystical-runs", _st(stat.S_IFDIR, 0o775, uid=0)),
    ("an Intel Mac's Homebrew owns /usr/local", CLAUDE, "/usr/local", _st(stat.S_IFDIR, 0o755, uid=501)),
    ("the config's folder is group-writable", CONFIG, "/usr/local/etc", _st(stat.S_IFDIR, 0o775, uid=0)),
    ("the config's folder is someone else's", CONFIG, "/usr/local/etc", _st(stat.S_IFDIR, 0o755, uid=501)),
    ("a folder on the way is a link", CONFIG, "/usr", _st(stat.S_IFLNK, 0o755, uid=0)),
])
def test_a_path_anyone_but_root_could_change_is_refused_naming_the_culprit(why, path, bad, change):
    err = h.check_root_path(path, lstat=_lstat({**CHAIN, bad: change}))
    assert err and err.startswith(bad + " "), (why, err)


def test_a_missing_part_of_the_path_is_refused():
    assert h.check_root_path(CLAUDE, lstat=_lstat({k: v for k, v in CHAIN.items() if k != CLAUDE}))


def test_the_user_running_the_helper_counts_as_root_which_outside_tests_it_is():
    mine = {**CHAIN, CLAUDE: _st(stat.S_IFREG, 0o755, uid=501)}
    assert h.check_root_path(CLAUDE, lstat=_lstat(mine), uid=501) is None
    assert h.check_root_path(CLAUDE, lstat=_lstat(mine), uid=0)


# --- start and stop, against temp dirs --------------------------------------------------

RUN_UID = 4242    # mysticalruns here: never yours, so a fake that is missed targets nobody
WALLED = [8787, 8790, 8791]     # the bridge's ports Set up walled the hidden user off
WALL = [["/usr/bin/sudo", "-u", "mysticalruns", "/usr/bin/nc", "-z", "-G", "2", "127.0.0.1", str(p)] for p in WALLED]
WALL_DOWN = "This device's wall is down: its runs could reach your dashboard. Run Set up again."
KILL_ALL = ["/usr/bin/pkill", "-KILL", "-u", "mysticalruns"]
ANY_LEFT = ["/usr/bin/pgrep", "-u", "mysticalruns"]
CRONTAB = ["/usr/bin/crontab", "-r", "-u", "mysticalruns"]
BOOTOUT = [["/bin/launchctl", "bootout", "user/%d" % RUN_UID], ["/bin/launchctl", "bootout", "gui/%d" % RUN_UID]]
OTHER = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"     # another requester's run


class _Done:
    """A faked command's process: its exit code at once, or, when it `hangs`, a
    wait that times out until it is killed. The timeouts it was given are kept."""

    def __init__(self, rc, hangs=False):
        self.rc, self.hangs, self.killed, self.timeouts = rc, hangs, False, []

    def wait(self, timeout=None):
        self.timeouts.append(timeout)
        if self.hangs and not self.killed:
            raise subprocess.TimeoutExpired("launchctl", timeout)
        return self.rc

    def kill(self):
        self.killed = True


def _inside(path, root):
    root = os.path.realpath(root)
    return os.path.commonpath([os.path.realpath(path), root]) == root


class Runner:
    """subprocess.Popen as the helper calls it, failing closed. Every command is
    recorded.

    pkill, pgrep, crontab, launchctl and nc are faked and never run. pgrep answers
    from `left` (0: some are left, 2: an error) and then 1 (none are); crontab
    exits `cron_rc` (1, as when there is none); launchctl exits 3 (no such
    domain), or with `launchd_hangs` never answers until it is killed; nc exits 0
    (it connected) for a port in `open_ports`, else 1, as against the wall. At each
    kill, `kills` notes what `on_kill()` says then. `hooks` maps a command (after
    the sudo) to a function of its argv: a number it returns is that command's
    exit code instead of running it, None lets it run.

    Only tar, install, python3, rm and the test's own fake Claude run for real,
    as you, without the `/usr/bin/sudo [-E] -u <user>` in front, and only on
    paths inside the test's temp dir (`root`, which the box fixture sets).
    Anything else is refused (and fails the test, see no_real_process): nothing
    falls through to a real command."""

    FAKED = ("/usr/bin/pkill", "/usr/bin/pgrep", "/usr/bin/crontab", "/bin/launchctl", "/usr/bin/nc")
    REAL = ("/usr/bin/tar", "/usr/bin/install", "/usr/bin/python3", "/bin/rm")
    root = claude = None          # the box's temp dir and fake Claude
    refused: list = []            # what no Runner would run, this test (no_real_process checks it)

    def __init__(self, left=(), on_kill=lambda: None, cron_rc=1, hooks=None, launchd_hangs=False, open_ports=()):
        self.calls, self.procs, self.kills, self.faked, self.cwds = [], [], [], [], []
        self.left, self.on_kill, self.cron_rc, self.hooks = list(left), on_kill, cron_rc, hooks or {}
        self.launchd_hangs, self.open_ports = launchd_hangs, {str(p) for p in open_ports}

    def __call__(self, argv, **kw):
        self.calls.append(list(argv))
        self.cwds.append(kw.get("cwd"))
        cmd = list(argv)
        if cmd and cmd[0] == "/usr/bin/sudo":
            cmd = cmd[1:]
            while cmd and cmd[0].startswith("-"):
                cmd = cmd[2:] if cmd[0] == "-u" else cmd[1:]
        exe = cmd[0] if cmd else ""
        if exe in self.FAKED:
            if exe == "/usr/bin/pkill":
                self.kills.append(self.on_kill())
            rc = {"/usr/bin/pkill": 0, "/usr/bin/crontab": self.cron_rc, "/bin/launchctl": 3}.get(exe)
            if exe == "/usr/bin/pgrep":
                rc = self.left.pop(0) if self.left else 1
            if exe == "/usr/bin/nc":
                rc = 0 if cmd[-1] in self.open_ports else 1
            done = _Done(rc, hangs=exe == "/bin/launchctl" and self.launchd_hangs)
            self.faked.append((exe, done))
            return done
        if exe in self.hooks:
            rc = self.hooks[exe](cmd)
            if rc is not None:
                return _Done(rc)
        outside = [a for a in cmd[1:] if a.startswith("/") and Runner.root and not _inside(a, Runner.root)]
        if (exe not in self.REAL and exe != Runner.claude) or Runner.root is None or outside:
            Runner.refused.append(list(argv))
            raise AssertionError("the Runner won't run %r for real" % (argv,))
        p = subprocess.Popen(cmd, **kw)
        self.procs.append(p)
        return p


def _killed_around_the_run(run):
    """Every mysticalruns process was stopped before the launch, and again after
    the run, while its folder was still there (so before it was cleaned up)."""
    kills = [i for i, c in enumerate(run.calls) if c == KILL_ALL]
    launch = next(i for i, c in enumerate(run.calls) if "-p" in c)
    assert len(kills) == 2 and kills[0] < launch < kills[1], run.calls
    assert run.kills == [False, True], "the second kill comes before the run folder is removed"
    assert all(run.calls[i + 1] == ANY_LEFT for i in kills), "each kill waits until none is left"
    assert all(run.calls[i - 2:i] == BOOTOUT for i in kills), \
        "the hidden user's launchd domains go first: a KeepAlive job would be started again after any kill"


def _watching(b):
    """A Runner that notes, at each kill by user, whether the run's folder is there."""
    return Runner(on_kill=lambda: os.path.lexists(b.runs / RUN_ID))


def _group_alive(pgid):
    try:
        os.killpg(pgid, 0)
    except (ProcessLookupError, PermissionError):   # macOS: EPERM while only exited members are left
        return False
    return True


def _hold(b, run_id=RUN_ID):
    """The lock, held the way a start for `run_id` holds it. A second open of the
    file is a second lock owner, even in this process (flock is per open file)."""
    fd = os.open(b.lock, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    os.ftruncate(fd, 0)
    os.write(fd, run_id.encode())
    return fd


@pytest.fixture
def bystander():
    """A live process group that is nobody's run: a stop must never signal it."""
    p = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    yield p
    p.kill()
    p.wait()


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
    """The real paths, in a temp dir: the runs folder, the stage root, the config
    and the lock. mysticalruns is RUN_UID, an account that isn't you: the run's
    commands run as you through the Runner, and chowning to RUN_UID is faked
    (b.fchowns), so a fake that is missed targets nobody."""
    if h.check_root_path(str(tmp_path), uid=ME):
        pytest.skip("the temp dir has a folder above it that others can change (a world-writable /tmp?), "
                    "so the helper rightly refuses to run from it")
    if _system_python() is None:
        pytest.skip("no system python3 for the launch agents clean-up")
    b = types.SimpleNamespace(tmp=tmp_path, runs=tmp_path / "runs", stages=tmp_path / "stages",
                              cfg=tmp_path / "etc" / "mystical-runs.json", claude=tmp_path / "claude",
                              lock=tmp_path / "run" / "mystical-runs.lock")
    b.runs.mkdir(mode=0o700)
    b.stages.mkdir()
    b.cfg.parent.mkdir()
    b.lock.parent.mkdir()
    b.cfg.write_text(json.dumps({"owner": "me", "uid": ME, "launch": "sudo", "claude": str(b.claude), "walled": WALLED}))
    b.cfg.chmod(0o644)
    monkeypatch.setattr(h, "RUNS_HOME", str(b.runs))
    monkeypatch.setattr(h, "STAGE_ROOT", str(b.stages))
    monkeypatch.setattr(h, "LOCK", str(b.lock))
    monkeypatch.setenv("MYSTICAL_RUNS_CONFIG", str(b.cfg))
    monkeypatch.setenv("SUDO_UID", str(ME))
    real = pwd.getpwnam
    monkeypatch.setattr(pwd, "getpwnam",
                        lambda n: types.SimpleNamespace(pw_uid=RUN_UID) if n == "mysticalruns" else real(n))
    b.fchowns = []
    monkeypatch.setattr(h.os, "fchown", lambda fd, uid, gid: b.fchowns.append((uid, gid)))
    monkeypatch.setattr(Runner, "root", str(tmp_path))
    monkeypatch.setattr(Runner, "claude", str(b.claude))
    _claude(b, "printf '{}'\n")
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
touch "$HOME/.npmrc" && home_ok=yes
printf 'warning: something to diagnose\\n' >&2
printf 'png' > "$MYSTICAL_RUN_OUT/screens/01-home.png"
printf 'x' > "$MYSTICAL_RUN_OUT/screens/.hidden.png"
ln -s /etc/hosts "$MYSTICAL_RUN_OUT/screens/02-link.png"
mkdir "$MYSTICAL_RUN_OUT/screens/deeper" && printf 'x' > "$MYSTICAL_RUN_OUT/screens/deeper/03.png"
printf 'mine' > "$MYSTICAL_RUN_OUT/exit.json"
printf '{"result": "%s", "cwd": "%s", "token": "%s", "config": "%s", "home": "%s", "home_ok": "%s"}' \\
  "$cd_ok" "$PWD" "$CLAUDE_CODE_OAUTH_TOKEN" "$CLAUDE_CONFIG_DIR" "$HOME" "$home_ok"
""")
    st = _stage(box)
    run = _watching(box)
    assert h.main(["start", RUN_ID], popen=run) == 0
    _killed_around_the_run(run)

    report = json.loads((st / "out" / "claude.json").read_text())
    assert report["result"] == "hello" and report["cwd"].endswith("/runs/" + RUN_ID + "/code")
    assert report["token"] == TOKEN and report["config"] == str(box.runs / RUN_ID / "config")
    assert report["home"] == str(box.runs / RUN_ID / "home") and report["home_ok"] == "yes", \
        "a fresh home of its own, which goes with the run"
    assert (st / "out" / "claude.err").read_text() == "warning: something to diagnose\n"
    assert json.loads((st / "out" / "exit.json").read_text()) == {"code": 0, "timedOut": False}, \
        "exit.json is the helper's, whatever the run wrote under that name"
    # Only plain files with plain names come back: no link, no hidden file, no subfolder.
    assert sorted(os.listdir(st / "out" / "screens")) == ["01-home.png"]
    assert (st / "out" / "screens" / "01-home.png").read_bytes() == b"png"
    assert _left_behind(box, st) == []
    assert (st / "job.json").exists(), "the rest of the stage is the bridge's to remove"

    (bootout_user, bootout_gui, kill, wait, cron, clear, *wall, install, untar, launch, writer, reader,
     bootout_user_again, bootout_gui_again, kill_again, wait_again, cron_again) = run.calls
    assert wall == WALL, "the wall is proved as the hidden user, before its code is unpacked"
    assert [bootout_user, bootout_gui] == BOOTOUT == [bootout_user_again, bootout_gui_again], "as root, fixed argv"
    assert cron == CRONTAB == cron_again, "as root, with its fixed argv, before the run and after its processes are gone"
    assert clear[:3] == ["/usr/bin/sudo", "-u", "mysticalruns"] and clear[-1] == str(box.tmp)
    code = str(box.runs / RUN_ID / "code")
    assert install[:3] == ["/usr/bin/sudo", "-u", "mysticalruns"] and install[3:6] == ["/usr/bin/install", "-d", "-m"]
    assert str(box.runs / RUN_ID / "home") in install, "the fresh home is made as mysticalruns, 0700"
    assert untar == ["/usr/bin/sudo", "-u", "mysticalruns", "/usr/bin/tar", "-xzf", "-", "-C", code, "--no-same-owner"]
    assert launch == h.launch_argv("sudo", RUN_UID, h.claude_argv(JOB["prompt"], str(box.claude)))
    assert reader[:3] == ["/usr/bin/sudo", "-u", "mysticalruns"], "the screens are read as the run's user"
    assert reader[-2:] == ["out/screens", "out/claude.err"]
    assert writer[:3] == ["/usr/bin/sudo", "-u", "#%d" % ME], "and written as the owner"
    assert not [a for c in run.calls for a in c if TOKEN in a], "the token is never in a command line (ps shows those)"


def test_a_run_starts_with_no_launch_agent_an_earlier_run_left(box):
    """Before each run the hidden user's LaunchAgents loses everything launchd
    could start later: plain files, and links, which are removed and never
    followed. Folders stay; launchd doesn't load from them. ("Home" is the temp
    folder holding RUNS_HOME, as /Users/mysticalruns holds runs/.)"""
    agents = box.tmp / "Library" / "LaunchAgents"
    agents.mkdir(parents=True)
    (agents / "persist.plist").write_text("<plist/>")
    elsewhere = box.tmp / "elsewhere.plist"
    elsewhere.write_text("<plist/>")
    (agents / "linked.plist").symlink_to(elsewhere)
    (box.tmp / "a-folder").mkdir()
    (agents / "linked-folder").symlink_to(box.tmp / "a-folder")
    (agents / "folder").mkdir()
    (agents / "folder" / "inside.plist").write_text("<plist/>")
    _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 0
    assert sorted(os.listdir(agents)) == ["folder"]
    assert elsewhere.read_text() == "<plist/>" and (box.tmp / "a-folder").is_dir()
    assert (agents / "folder" / "inside.plist").exists()
    clear = next(c for c in run.calls if "-c" in c)
    launch = next(c for c in run.calls if "-p" in c)
    assert clear[:3] == ["/usr/bin/sudo", "-u", "mysticalruns"], "emptied as the hidden user, not as root"
    assert run.calls.index(clear) < run.calls.index(launch), "before the run starts"


@pytest.mark.parametrize("plant", ["missing", "LaunchAgents is a link", "LaunchAgents is a file", "Library is a link"])
def test_launch_agents_that_is_missing_or_a_link_becomes_a_real_empty_folder(box, plant):
    library, planted = box.tmp / "Library", box.tmp / "planted"
    (planted / "LaunchAgents").mkdir(parents=True)
    (planted / "persist.plist").write_text("<plist/>")
    (planted / "LaunchAgents" / "persist.plist").write_text("<plist/>")
    if plant == "Library is a link":
        library.symlink_to(planted)
    elif plant != "missing":
        library.mkdir()
        if plant == "LaunchAgents is a link":
            (library / "LaunchAgents").symlink_to(planted)
        else:
            (library / "LaunchAgents").write_text("x")
    _stage(box)
    assert h.main(["start", RUN_ID], popen=Runner()) == 0
    agents = library / "LaunchAgents"
    assert not library.is_symlink() and not agents.is_symlink() and agents.is_dir()
    assert os.listdir(agents) == []
    assert (planted / "persist.plist").exists() and (planted / "LaunchAgents" / "persist.plist").exists(), \
        "no link was followed"


def test_claudes_errors_come_back_capped_at_a_megabyte(box):
    _claude(box, "head -c 1572864 /dev/zero | tr '\\0' e >&2\nprintf '{}'\n")
    st = _stage(box)
    assert h.main(["start", RUN_ID], popen=Runner()) == 0
    err = (st / "out" / "claude.err").read_bytes()
    assert len(err) == 1 << 20 and set(err) == {ord("e")}


def test_claudes_stderr_file_is_mysticalruns_so_its_own_tar_can_read_it_back(box):
    """Root makes out/claude.err before the run exists, then gives it to the run's
    user. Left root's, the tar that reads results as that user couldn't read it.
    (Here that chown is faked, so the hand-over is checked as a call.)"""
    _stage(box)
    assert h.main(["start", RUN_ID], popen=Runner()) == 0
    assert box.fchowns == [(RUN_UID, -1)]


def test_a_claude_binary_others_can_change_is_never_run(box, capsys):
    _claude(box, "printf '{}'\n")
    box.claude.chmod(0o775)
    st = _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert run.calls == [] and (st / "token").exists()
    assert str(box.claude) in capsys.readouterr().err, "the refusal names what is wrong"


def test_a_config_in_a_folder_others_can_change_is_not_trusted(box, capsys):
    box.cfg.parent.chmod(0o775)
    _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert run.calls == [] and str(box.cfg.parent) in capsys.readouterr().err


def test_a_run_that_times_out_is_killed_and_still_cleaned_up(box):
    _claude(box, "sleep 30\n")
    st = _stage(box, job={**JOB, "timeoutSeconds": 1})
    run = _watching(box)
    began = time.monotonic()
    assert h.main(["start", RUN_ID], popen=run) == 0
    _killed_around_the_run(run)
    assert time.monotonic() - began < h.GRACE + 5, "killed at the timeout, not left to run its 30 s"
    done = json.loads((st / "out" / "exit.json").read_text())
    assert done["timedOut"] is True and done["code"] != 0
    # Nothing of the run's process group is left alive (macOS answers EPERM, not
    # ESRCH, while an exited member waits to be reaped).
    launch = next(p for p in run.procs if "-p" in p.args)
    with pytest.raises((ProcessLookupError, PermissionError)):
        os.killpg(launch.pid, 0)
    assert _left_behind(box, st) == []


def test_stop_ends_a_running_run_and_start_still_reports_and_cleans_up(box):
    _claude(box, "sleep 30\n")
    st = _stage(box)
    run, rc = _watching(box), []
    t = threading.Thread(target=lambda: rc.append(h.main(["start", RUN_ID], popen=run)))
    t.start()
    pid = box.runs / RUN_ID / "pid"
    deadline = time.monotonic() + 10
    while not (pid.exists() and pid.read_text().strip()) and time.monotonic() < deadline:
        time.sleep(0.05)
    pgid = int(pid.read_text())
    stopper = Runner(on_kill=lambda: _group_alive(pgid))
    assert h.main(["stop", RUN_ID], popen=stopper) == 0
    t.join(15)
    assert rc == [0]
    assert stopper.calls == BOOTOUT + [KILL_ALL, ANY_LEFT], "after the group, whatever setsid() out of it"
    assert stopper.kills == [False], "the group is stopped first, then everything else of the user's"
    _killed_around_the_run(run)
    assert json.loads((st / "out" / "exit.json").read_text()) == {"code": -15, "timedOut": False}
    assert _left_behind(box, st) == []


def test_the_kill_by_user_kills_again_on_each_pass_until_none_is_left(box):
    """One that respawns, or a fork that raced the first kill, can't outlive a
    single sweep: every pass kills again before it asks whether any is left."""
    run = Runner(left=[0, 0, 0])
    _stage(box)
    assert h.main(["start", RUN_ID], popen=run) == 0
    assert run.calls[:2] == BOOTOUT
    assert run.calls[2:10] == [KILL_ALL, ANY_LEFT] * 4, "killed and asked until pgrep said none"
    assert run.calls[10] not in (KILL_ALL, ANY_LEFT)


def test_a_process_still_there_at_the_deadline_refuses_the_run(box, monkeypatch, capsys):
    """One that won't die, or one launchd keeps starting again past the bootout:
    the run never starts beside it, nothing is handed back in its place, and the
    wait for it is bounded."""
    monkeypatch.setattr(h, "GRACE", 0.3)
    run = Runner(left=[0] * 1000)
    st = _stage(box)
    began = time.monotonic()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert time.monotonic() - began < 5
    assert not [c for c in run.calls if "-p" in c], "Claude never started"
    assert len(capsys.readouterr().err.strip().splitlines()) == 1
    assert not (st / "out").exists() and _left_behind(box, st) == []


@pytest.mark.parametrize("who", ["the caller", "root"])
def test_the_helper_acts_on_no_account_but_the_hidden_one(box, monkeypatch, capsys, bystander, who):
    """A mysticalruns that resolves to root's uid, or to the caller's: a bootout,
    a kill by user or a chown would land on that account. Refused before any of
    it, in start and in stop alike."""
    uid = ME if who == "the caller" else 0
    real = pwd.getpwnam
    monkeypatch.setattr(pwd, "getpwnam", lambda n: types.SimpleNamespace(pw_uid=uid) if n == "mysticalruns" else real(n))
    st = _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert run.calls == [] and box.fchowns == [] and _left_behind(box, st) == []
    (box.runs / RUN_ID).mkdir()
    (box.runs / RUN_ID / "pid").write_text("%d\n" % bystander.pid)
    held = _hold(box)                       # a run of that id holds the lock
    try:
        assert h.main(["stop", RUN_ID], popen=run) == 2
    finally:
        os.close(held)
    assert run.calls == [] and _group_alive(bystander.pid)
    assert len(capsys.readouterr().err.strip().splitlines()) == 2, "one line each"


def test_a_process_check_that_fails_counts_as_something_left(box, monkeypatch, capsys):
    """Only pgrep's 1 says nobody is left. Its 2 or 3 is an error that proves
    nothing, so the run is refused, as one with a process still there would be."""
    monkeypatch.setattr(h, "GRACE", 0.3)
    run = Runner(left=[2] * 1000)
    st = _stage(box)
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert not [c for c in run.calls if "-p" in c] and not (st / "out").exists()
    assert len(capsys.readouterr().err.strip().splitlines()) == 1


def test_a_bootout_that_never_answers_is_killed_and_the_run_refused(box, capsys):
    """Each bootout gets 30 s. One still going then is killed, and whatever
    launchd keeps alive may still be there, so the run doesn't start."""
    run = Runner(launchd_hangs=True)
    st = _stage(box)
    assert h.main(["start", RUN_ID], popen=run) == 2
    bootouts = [done for exe, done in run.faked if exe == "/bin/launchctl"]
    assert bootouts and all(d.killed and d.timeouts[0] == 30 for d in bootouts), "waited 30 s at most, then killed"
    assert not [c for c in run.calls if "-p" in c] and not (st / "out").exists()
    assert len(capsys.readouterr().err.strip().splitlines()) == 1


def test_the_runner_runs_nothing_it_does_not_know(box):
    """The harness itself fails closed: a command no Runner fakes or allows, or a
    path outside the test's temp dir, is refused, never run."""
    run = Runner()
    for argv in (["/usr/bin/osascript", "-e", "beep"], ["/bin/rm", "-rf", "--", os.path.expanduser("~")],
                 ["/usr/bin/sudo", "-u", "mysticalruns", "/usr/bin/tar", "-xf", "-", "-C", "/Users/Shared"],
                 ["launchctl", "bootout", "gui/%d" % ME]):
        with pytest.raises(AssertionError):
            run(argv)
    assert Runner.refused == [list(a) for a in run.calls]
    Runner.refused.clear()                  # refused on purpose here; anywhere else it fails the test


def test_the_token_leaves_the_disk_once_read_before_the_run_starts(box):
    """Claude gets it in its environment; the stage's copy has no reason to stay."""
    st = _stage(box)
    at_launch = []
    run = Runner(hooks={str(box.claude): lambda argv: at_launch.append(os.path.lexists(st / "token"))})
    assert h.main(["start", RUN_ID], popen=run) == 0
    assert at_launch == [False]


def test_stopping_a_run_that_is_not_running_is_no_error_and_kills_nothing(box):
    """A stop that arrives after its run ended must not touch the next requester's run."""
    run = Runner()
    assert h.main(["stop", RUN_ID], popen=run) == 0
    assert run.calls == []


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
    held = _hold(box)      # as while that run's start goes on: only then is a pid file read at all
    try:
        assert h.main(["stop", RUN_ID]) != 0
    finally:
        os.close(held)
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


def test_a_stage_that_is_a_symlink_is_refused(box, capsys):
    real = _stage(box, where=box.tmp / "somewhere-else")
    (box.stages / RUN_ID).symlink_to(real)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert run.calls == [] and (real / "token").exists()
    assert "symlink" in capsys.readouterr().err


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


def test_every_run_proves_the_wall_first_as_the_hidden_user_from_the_root_folder(box):
    """None of the bridge's ports may answer the hidden user: the dashboard
    hands out its token, and with it comes an owner's shell."""
    _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 0
    at = [i for i, c in enumerate(run.calls) if c in WALL]
    assert [run.calls[i] for i in at] == WALL and all(run.cwds[i] == "/" for i in at), \
        "each walled port, as mysticalruns, started in / (never past the deny rule on your home)"
    untar = next(i for i, c in enumerate(run.calls) if "-xzf" in c)
    assert at[-1] < untar, "before the run's code is unpacked, so before it runs"


@pytest.mark.parametrize("port", WALLED)
def test_a_run_never_starts_while_the_wall_is_down(box, capsys, port):
    """A VPN or a tool that turned pf off, or a pf.conf changed since Set up: the
    run fails with the reason, and its code is never unpacked."""
    st = _stage(box)
    run = Runner(open_ports=[port])
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert capsys.readouterr().err == "mystical-run-helper: %s\n" % WALL_DOWN
    assert not [c for c in run.calls if "-p" in c or "-xzf" in c], "nothing was unpacked or run"
    assert run.calls.count(KILL_ALL) == 2 and _left_behind(box, st) == []


@pytest.mark.parametrize("walled", [None, [], [8790, "8791"], [0], [8790, 70000], [True], "8790"])
def test_a_device_set_up_without_a_wall_on_record_refuses_its_runs(box, capsys, walled):
    """Set up from before the wall, or a record that isn't one: Set up again."""
    cfg = json.loads(box.cfg.read_text())
    if walled is None:
        del cfg["walled"]
    else:
        cfg["walled"] = walled
    box.cfg.write_text(json.dumps(cfg))
    st = _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert run.calls == [] and (st / "token").exists(), "refused before anything is touched"
    assert capsys.readouterr().err == "mystical-run-helper: %s\n" % WALL_DOWN


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
    assert not [c for c in run.calls if "-p" in c], "Claude never started"
    assert run.calls.count(KILL_ALL) == 2, "one kill by user before, and one in the clean-up"
    assert _left_behind(box, st) == []


# --- one run at a time, and nothing an earlier run left -------------------------------------

def test_one_run_at_a_time_a_second_start_waits_for_the_first(box):
    """Two runs never overlap, since each one's kill by user would take the other
    down: a second start touches nothing until the first lets go of the lock."""
    _stage(box)
    first = _hold(box, OTHER)
    run, rc = Runner(), []
    t = threading.Thread(target=lambda: rc.append(h.main(["start", RUN_ID], popen=run)))
    t.start()
    try:
        time.sleep(0.5)
        assert run.calls == [] and t.is_alive(), "it waits, and does nothing meanwhile"
    finally:
        os.close(first)
    t.join(15)
    assert rc == [0] and [c for c in run.calls if "-p" in c], "then it runs"


def test_the_lock_is_a_root_only_file(box):
    """Anyone who could open it could take it, and hold up every run."""
    _stage(box)
    assert h.main(["start", RUN_ID], popen=Runner()) == 0
    st = os.lstat(box.lock)
    assert stat.S_ISREG(st.st_mode) and st.st_uid == ME and stat.S_IMODE(st.st_mode) == 0o600


def test_a_lock_in_a_folder_others_can_change_is_not_trusted(box, capsys):
    box.lock.parent.chmod(0o775)
    _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert h.main(["stop", RUN_ID], popen=run) == 2
    assert run.calls == [] and str(box.lock.parent) in capsys.readouterr().err


def test_a_stop_while_no_run_holds_the_lock_signals_nothing(box, bystander):
    """A helper that died leaves its pid file, and the lock still naming its run;
    that number can come back as somebody else's process group. With the lock
    free nothing is running, so no pid file is read at all."""
    (box.runs / RUN_ID).mkdir()
    (box.runs / RUN_ID / "pid").write_text("%d\n" % bystander.pid)
    box.lock.write_text(RUN_ID)
    box.lock.chmod(0o600)
    run = Runner()
    assert h.main(["stop", RUN_ID], popen=run) == 0
    assert _group_alive(bystander.pid) and run.calls == []


def test_a_lock_that_is_a_link_is_never_opened_through(box):
    elsewhere = box.tmp / "elsewhere"
    elsewhere.write_text("keep\n")
    box.lock.symlink_to(elsewhere)
    _stage(box)
    run = Runner()
    assert h.main(["start", RUN_ID], popen=run) != 0
    assert h.main(["stop", RUN_ID], popen=run) != 0
    assert run.calls == [] and elsewhere.read_text() == "keep\n"


def test_a_stop_for_another_run_than_the_one_going_signals_nothing(box, bystander):
    """Only the run holding the lock can be stopped: a late stop for an earlier
    run never reaches the requester whose run is going now."""
    (box.runs / RUN_ID).mkdir()
    (box.runs / RUN_ID / "pid").write_text("%d\n" % bystander.pid)
    held = _hold(box, OTHER)
    try:
        assert h.main(["stop", RUN_ID], popen=Runner()) == 0
    finally:
        os.close(held)
    assert _group_alive(bystander.pid)


def test_start_clears_what_a_run_whose_helper_died_left(box):
    """A helper killed outright (no finally) leaves its run's folder: one
    requester's code, .env files and home, and a pid file. The next start takes
    it all away before its own run: root removes each pid file first, so none can
    ever name a process group, and mysticalruns removes the rest."""
    old = box.runs / OTHER
    (old / "code").mkdir(parents=True)
    (old / "code" / ".env").write_text("SECRET=1\n")
    (old / "pid").write_text("99999\n")
    (box.runs / "stray").write_text("x")
    at_rm = []
    run = Runner(hooks={"/bin/rm": lambda argv: at_rm.append(os.path.lexists(old / "pid"))})
    _stage(box)
    assert h.main(["start", RUN_ID], popen=run) == 0
    assert not os.path.lexists(old) and not os.path.lexists(box.runs / "stray")
    rm = next(c for c in run.calls if "/bin/rm" in c)
    assert rm[:6] == ["/usr/bin/sudo", "-u", "mysticalruns", "/bin/rm", "-rf", "--"], "as mysticalruns"
    assert sorted(rm[6:]) == sorted([str(old), str(box.runs / "stray")])
    assert at_rm == [False], "root took the pid file out before the rest went"
    first_kill = run.calls.index(KILL_ALL)
    launch = next(i for i, c in enumerate(run.calls) if "-p" in c)
    assert first_kill < run.calls.index(rm) < launch, "with nothing of it running, before the new run"


def test_a_leftover_that_will_not_go_refuses_the_run(box, capsys):
    """Fail closed: a run never starts beside an earlier requester's code."""
    (box.runs / OTHER / "code").mkdir(parents=True)
    (box.runs / OTHER / "pid").write_text("99999\n")
    run = Runner(hooks={"/bin/rm": lambda argv: 1})
    st = _stage(box)
    assert h.main(["start", RUN_ID], popen=run) == 2
    assert not [c for c in run.calls if "-p" in c], "Claude never started"
    assert not os.path.lexists(box.runs / OTHER / "pid"), "the pid file went all the same"
    assert _left_behind(box, st) == [] and len(capsys.readouterr().err.strip().splitlines()) == 1


def test_the_hidden_users_crontab_goes_before_and_after_each_run_and_none_is_no_error(box):
    """macOS 26 no longer lets Set up write the cron deny list, so this takes away
    any crontab the hidden user had before the run and any it left after. Having
    none (crontab exits 1) is the usual case, not a failure."""
    run = Runner(cron_rc=1)
    _stage(box)
    assert h.main(["start", RUN_ID], popen=run) == 0
    launch = next(i for i, c in enumerate(run.calls) if "-p" in c)
    at = [i for i, c in enumerate(run.calls) if c == CRONTAB]
    assert len(at) == 2 and at[0] < launch < at[1]


def test_set_up_makes_the_locks_folder_and_remove_takes_the_lock():
    with open(os.path.join(ROOT, "bridge", "device_setup", "setup.sh"), encoding="utf-8") as f:
        setup = f.read()
    with open(os.path.join(ROOT, "bridge", "device_setup", "remove.sh"), encoding="utf-8") as f:
        remove = f.read()
    assert os.path.dirname(h.LOCK) in setup and h.LOCK in remove


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
