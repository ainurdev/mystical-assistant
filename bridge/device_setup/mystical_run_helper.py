#!/usr/bin/python3 -I
"""mystical-run-helper: run a teammate's device run as the hidden user mysticalruns.

Set up (setup.sh) installs this file as /usr/local/libexec/mystical-run-helper,
root:wheel 0755, with a sudoers rule that lets the device's owner, and nobody
else, run it as root without a password:

    sudo -n mystical-run-helper start <run-id>   # run it; the results land in the stage's out/
    sudo -n mystical-run-helper stop <run-id>    # TERM the run, KILL it 10 s later

The owner's bridge stages a run in /Users/Shared/Mystical Runs/<run-id>/, a 0700
folder of the owner's holding job.json, token and code.tar.gz. `start` unpacks
the code in /Users/mysticalruns/runs/<run-id>/ and runs Claude Code there as
mysticalruns, with the asker's token, then hands back out/exit.json,
out/claude.json and out/screens/. It exits 0 on a finished run, whatever Claude
made of it. Anything it won't or can't do is one stderr line and a non-zero exit.

Root sits between two parties it must not trust. One is the owner, who fills
the stage. The other is the run: a teammate's prompt plus their repository's
code, with every tool allowed. So root never follows a link either could plant:
- Stage files are opened without following links, then checked on the opened
  file: a plain file of the owner's, in the owner's own 0700 folder.
- Work inside the run's tree is done as mysticalruns: making its folders,
  unpacking the code (from a pipe, so root writes no copy there) and reading the
  screenshots back. Root itself only creates the pid file and enters the code
  folder, through folder handles opened without following links. At the end it
  deletes the tree with shutil's link-safe rmtree.
- Results reach the stage through the owner's own tar, so nothing root writes
  lands where a link points. Only plain files with plain names get through.
- Claude gets the token in its environment only (sudo -E), never in an argument
  list, which any account on the Mac can read with ps.
- Every process started as mysticalruns starts in / or in the run's own code
  folder, never somewhere past the deny rule Set up put on the owner's home.
- Nothing carries over from one requester's run to the next. Claude runs from
  the root-owned copy Set up made, never updates itself, and only root's folders
  come first on PATH. Each run gets a fresh HOME inside its own folder, which
  goes with the run. Before each run, the hidden user's LaunchAgents is emptied,
  so nothing a run left there can start later.
- The config and the Claude copy, and every folder above them, must be root's
  alone (check_root_path; setup.sh checks the same before it writes anything).
  Otherwise the owner's passwordless sudo would run whatever replaced them.
- Claude's stderr is kept as out/claude.err (the first megabyte), so a failed
  run says why.
Cleanup always runs: on success, failure, timeout, stop, and when a bridge
restart TERMs this helper. It stops the run's process group and deletes its
folder and the stage's token.

Root runs this with the system /usr/bin/python3, which can be as old as 3.9. So
the code sticks to 3.9: no `match`, no `X | Y` types, no Popen(process_group=).
"""

import io
import json
import os
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

RUN_USER = "mysticalruns"
CONFIG = "/usr/local/etc/mystical-runs.json"
RUNS_HOME = "/Users/mysticalruns/runs"        # test seam: tests point it at a temp dir
STAGE_ROOT = "/Users/Shared/Mystical Runs"    # test seam: tests point it at a temp dir
STAGE_FILES = ("job.json", "token", "code.tar.gz")
RUN_PATH = "/usr/local/libexec/mystical-runs:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
GRACE = 10                                     # seconds between TERM and KILL
ERR_CAP = 1 << 20                              # bytes of Claude's stderr handed back
_RUN_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_SCREEN = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_. -]{0,127}")   # a screenshot's name: no folder, not hidden

# Run as mysticalruns on <home>: Library/LaunchAgents becomes a real folder, made
# if missing or a link, and loses everything but folders. A link is removed and
# never followed.
_EMPTY_AGENTS = """
import os, sys
nofollow = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open(sys.argv[1], nofollow)
for name in ("Library", "LaunchAgents"):
    try:
        sub = os.open(name, nofollow, dir_fd=fd)
    except OSError:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.mkdir(name, 0o700, dir_fd=fd)
        sub = os.open(name, nofollow, dir_fd=fd)
    os.close(fd)
    fd = sub
for entry in os.scandir(fd):
    if not entry.is_dir(follow_symlinks=False):
        os.unlink(entry.name, dir_fd=fd)
"""


class Refused(Exception):
    """A request this helper won't carry out; the message is its one stderr line."""


# ---------------------------------------------------------------------------
# Pure parts
# ---------------------------------------------------------------------------

def valid_run_id(s):
    """A run id is a lowercase UUID; nothing else ever becomes part of a path."""
    return isinstance(s, str) and _RUN_ID.fullmatch(s) is not None


def check_stage(path, owner_uid, lstat=os.lstat):
    """Why the stage can't be trusted, or None. It must be the owner's own folder,
    not a link, 0700, with job.json, token and code.tar.gz as plain files of theirs."""
    try:
        st = lstat(path)
    except OSError:
        return "The run has no stage."
    if stat.S_ISLNK(st.st_mode):
        return "The stage is a symlink."
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != owner_uid:
        return "The stage isn't a folder of the owner's."
    if stat.S_IMODE(st.st_mode) != 0o700:
        return "The stage isn't private to the owner (0700)."
    for name in STAGE_FILES:
        try:
            f = lstat(os.path.join(path, name))
        except OSError:
            return "The stage has no %s." % name
        if not stat.S_ISREG(f.st_mode) or f.st_uid != owner_uid:
            return "The stage's %s isn't a plain file of the owner's." % name
    return None


def check_root_path(path, lstat=os.lstat, uid=0):
    """Why `path` can't be trusted as root's, or None. It and every folder above
    it must be owned by root, writable by no one else, and not a link. `uid`, the
    user this helper runs as, also counts as root: it is root, except in tests."""
    parts = [p for p in path.split("/") if p]
    for i in range(len(parts) + 1):
        p = "/" + "/".join(parts[:i])
        try:
            st = lstat(p)
        except OSError:
            return "%s doesn't exist." % p
        if stat.S_ISLNK(st.st_mode):
            return "%s is a link." % p
        if st.st_uid not in (0, uid) or st.st_mode & 0o022:
            return "%s can be changed by someone other than root." % p
    return None


def claude_env(job, token, run_dir):
    """Claude's whole environment. Nothing of the owner's or root's comes along."""
    name, email = job.get("gitAuthorName") or "", job.get("gitAuthorEmail") or ""
    env = {
        "HOME": os.path.join(run_dir, "home"),
        "PATH": RUN_PATH,
        "CLAUDE_CODE_OAUTH_TOKEN": token,
        "CLAUDE_CONFIG_DIR": os.path.join(run_dir, "config"),
        "MYSTICAL_RUN_OUT": os.path.join(run_dir, "out"),
        "GIT_AUTHOR_NAME": name,
        "GIT_AUTHOR_EMAIL": email,
        "GIT_COMMITTER_NAME": name,
        "GIT_COMMITTER_EMAIL": email,
        "LANG": "en_US.UTF-8",
        "DISABLE_AUTOUPDATER": "1",
    }
    if job.get("developerDir"):
        env["DEVELOPER_DIR"] = job["developerDir"]
    return env


def claude_argv(prompt, claude_path="/Users/mysticalruns/.local/bin/claude"):
    """Claude Code, headless, with every tool allowed and no MCP server at all."""
    return [claude_path, "-p", prompt, "--output-format", "json", "--dangerously-skip-permissions",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']


def launch_argv(launch, uid, inner):
    """`inner` as mysticalruns: through sudo (the default), or inside that user's
    launchd session ("asuser"), the one alternative, for a Simulator that needs
    it. -E hands the command the environment sudo was given, which is claude_env
    and nothing else. There is no -H, which would reset HOME to the hidden user's
    own home, shared by every run."""
    as_runs = ["/usr/bin/sudo", "-E", "-u", RUN_USER]
    if launch == "sudo":
        return as_runs + list(inner)
    if launch == "asuser":
        return ["/bin/launchctl", "asuser", str(uid)] + as_runs + list(inner)
    raise ValueError("launch must be sudo or asuser, not %r" % (launch,))


# ---------------------------------------------------------------------------
# Doing it
# ---------------------------------------------------------------------------

def _config():
    """setup.sh's record of this device: {owner, uid, launch, claude}. Trusted only
    when it and every folder above it are root's alone."""
    # test seam: a test (never root) points MYSTICAL_RUNS_CONFIG at a temp file
    path = os.environ.get("MYSTICAL_RUNS_CONFIG", CONFIG) if os.geteuid() else CONFIG
    if not os.path.lexists(path):
        raise Refused("This device isn't set up for device runs.")
    err = check_root_path(path, uid=os.geteuid())
    if err:
        raise Refused(err)
    with open(path, encoding="utf-8") as f:   # only root can change it now
        return json.load(f)


def _as(user, popen, argv, failure, stdin=subprocess.DEVNULL):
    """`argv` as `user`, started in / (never in a folder that user couldn't reach)."""
    p = popen(["/usr/bin/sudo", "-u", user] + argv, stdin=stdin, stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL, cwd="/")
    if p.wait():
        raise Refused(failure)


def _open_stage(stage, uid):
    """The stage and its three files, opened without following a link and checked
    again on what was opened, so nothing can be swapped in after check_stage."""
    fds = []
    try:
        fds.append(os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        for name in STAGE_FILES:
            fds.append(os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fds[0]))
        opened = dict(zip([stage] + [os.path.join(stage, n) for n in STAGE_FILES], map(os.fstat, fds)))
        err = check_stage(stage, uid, lstat=opened.__getitem__)
    except OSError:
        err = "The stage changed while it was being read."
    if err:
        for fd in fds:
            os.close(fd)
        raise Refused(err)
    return fds


def _kill_group(pgid, leader=None):
    """TERM the process group, then KILL whatever is left after GRACE seconds.
    `leader`, when this helper started it, is reaped on the way, so its zombie
    doesn't look like a process still running."""
    try:
        os.killpg(pgid, signal.SIGTERM)
        deadline = time.monotonic() + GRACE
        while time.monotonic() < deadline:
            if leader is not None:
                leader.poll()
            os.killpg(pgid, 0)
            time.sleep(0.1)
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass  # the group is gone: macOS says EPERM while only exited processes are left in it


def _launch(argv, env, run_dir, run_uid, timeout, popen, out):
    """Claude as mysticalruns, in its own session, for at most `timeout` seconds.
    Returns (exit code, timed out)."""
    new = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    run_fd = os.open(run_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        code_fd = os.open("code", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=run_fd)
        # Made before the run exists, so the run can't plant one first; `stop` reads it.
        pid_fd = os.open("pid", new, 0o600, dir_fd=run_fd)
        out_fd = os.open("out", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=run_fd)
        try:
            err_fd = os.open("claude.err", new, 0o600, dir_fd=out_fd)
        finally:
            os.close(out_fd)
        os.fchown(err_fd, run_uid, -1)   # the run's to write, and mysticalruns's tar's to read back
    finally:
        os.close(run_fd)
    # Without a terminal (a new session) sudo uses no pty, so Claude stays in
    # sudo's process group and _kill_group reaches all of it. Entering code/
    # through its handle means a link swapped in can't start Claude elsewhere.
    p = popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err_fd,
              start_new_session=True, preexec_fn=lambda: os.fchdir(code_fd))
    os.close(code_fd)
    os.close(err_fd)
    timed_out = False
    try:
        os.write(pid_fd, b"%d\n" % p.pid)
        os.close(pid_fd)
        p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        _kill_group(p.pid, p)   # what the run left running, or all of it
    return p.wait(), timed_out


def _put(tar, name, f=None, size=0):
    """One entry for the owner's tar: a folder (no `f`), or `size` bytes of `f`."""
    info = tarfile.TarInfo(name)
    info.mtime = int(time.time())
    if f is None:
        info.type, info.mode = tarfile.DIRTYPE, 0o700
    else:
        info.size, info.mode = size, 0o600
    tar.addfile(info, f)


def _hand_back(popen, run_dir, stage, owner_uid, claude_out, exit_info):
    """The results, into the stage's out/: exit.json and claude.json from this
    helper, plus Claude's stderr (its first ERR_CAP bytes) and the screenshots
    the run saved. mysticalruns's own tar reads those two, so a link reaches
    nothing that user couldn't read. The owner's own tar writes everything, so
    nothing lands where a link points."""
    exit_json = json.dumps(exit_info).encode()
    writer = popen(["/usr/bin/sudo", "-u", "#%d" % owner_uid, "/usr/bin/tar", "-xf", "-", "-C", stage],
                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd="/")
    try:
        with tarfile.open(fileobj=writer.stdin, mode="w|") as dst:
            _put(dst, "out/screens")
            _put(dst, "out/exit.json", io.BytesIO(exit_json), len(exit_json))
            size = os.fstat(claude_out.fileno()).st_size
            claude_out.seek(0)
            _put(dst, "out/claude.json", claude_out, size)
            reader = popen(["/usr/bin/sudo", "-u", RUN_USER, "/usr/bin/tar", "-cf", "-", "-C", run_dir,
                            "out/screens", "out/claude.err"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd="/")
            try:
                with tarfile.open(fileobj=reader.stdout, mode="r|") as src:
                    for m in src:
                        name = m.name[len("out/screens/"):] if m.name.startswith("out/screens/") else ""
                        if not m.isreg():
                            continue
                        if m.name == "out/claude.err":
                            _put(dst, m.name, src.extractfile(m), min(m.size, ERR_CAP))
                        elif _SCREEN.fullmatch(name):
                            _put(dst, "out/screens/" + name, src.extractfile(m), m.size)
            except tarfile.TarError:
                pass  # nothing came back to read; the report still goes
            finally:
                reader.stdout.close()
                reader.wait()
    finally:
        writer.stdin.close()
        if writer.wait():
            raise Refused("The run finished, but its results couldn't be copied into the stage.")


def start(run_id, cfg, popen):
    """Run one device run as mysticalruns and hand its results to the stage."""
    claude = cfg.get("claude")
    if not isinstance(claude, str) or not claude:
        raise Refused("Claude Code isn't installed for device runs yet; run Set up again.")
    err = check_root_path(claude, uid=os.geteuid())   # the copy Set up made, which no run can change
    if err:
        raise Refused(err)
    stage = os.path.join(STAGE_ROOT, run_id)
    err = check_stage(stage, cfg["uid"])
    if err:
        raise Refused(err)
    stage_fd, job_fd, token_fd, tar_fd = _open_stage(stage, cfg["uid"])
    run_dir = os.path.join(RUNS_HOME, run_id)
    try:
        with os.fdopen(job_fd, encoding="utf-8") as f:
            job = json.load(f)
        with os.fdopen(token_fd, encoding="utf-8") as f:
            token = f.read().strip()
        prompt, timeout = job.get("prompt"), job.get("timeoutSeconds")
        if not isinstance(prompt, str) or not prompt or not token or type(timeout) is not int or timeout <= 0:
            raise Refused("The stage's job.json or token is incomplete.")
        run_uid = pwd.getpwnam(RUN_USER).pw_uid
        argv = launch_argv(cfg.get("launch"), run_uid, claude_argv(prompt, claude))
        _as(RUN_USER, popen, ["/usr/bin/python3", "-I", "-c", _EMPTY_AGENTS, os.path.dirname(RUNS_HOME)],
            "The hidden user's launch agents couldn't be cleared.")
        code = os.path.join(run_dir, "code")
        _as(RUN_USER, popen, ["/usr/bin/install", "-d", "-m", "0700", run_dir, code, os.path.join(run_dir, "out"),
                              os.path.join(run_dir, "out", "screens"), os.path.join(run_dir, "config"),
                              os.path.join(run_dir, "home")],
            "The run's folders couldn't be made.")
        _as(RUN_USER, popen, ["/usr/bin/tar", "-xzf", "-", "-C", code, "--no-same-owner"],
            "The code snapshot didn't unpack.", stdin=tar_fd)
        with tempfile.TemporaryFile() as out:   # Claude's stdout stays in root's hands
            rc, timed_out = _launch(argv, claude_env(job, token, run_dir), run_dir, run_uid, timeout, popen, out)
            _hand_back(popen, run_dir, stage, cfg["uid"], out, {"code": rc, "timedOut": timed_out})
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)   # never follows a link (rmtree.avoids_symlink_attacks)
        try:
            os.unlink("token", dir_fd=stage_fd)
        except FileNotFoundError:
            pass
        os.close(stage_fd)
        os.close(tar_fd)


def stop(run_id):
    """Stop the run `start` is running. Nothing running is no error."""
    try:
        fd = os.open(os.path.join(RUNS_HOME, run_id, "pid"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(fd)
        # The run's folder is the run's to fill: only the file start() made counts.
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1:
            raise Refused("That run's pid file isn't the helper's own.")
        pgid = int(f.read(32) or 0)
    if pgid > 1:
        _kill_group(pgid)


def main(argv=None, popen=subprocess.Popen):
    """mystical-run-helper start|stop <run-id>, for the owner recorded at Set up only."""
    argv = sys.argv[1:] if argv is None else argv
    try:
        if len(argv) != 2 or argv[0] not in ("start", "stop"):
            raise Refused("usage: mystical-run-helper start|stop <run-id>")
        cfg = _config()
        if os.environ.get("SUDO_UID") != str(cfg.get("uid")):
            raise Refused("Only this device's owner can start or stop a device run.")
        if not valid_run_id(argv[1]):
            raise Refused("That isn't a run id.")
        if argv[0] == "start":
            start(argv[1], cfg, popen)
        else:
            stop(argv[1])
        return 0
    except Refused as e:
        print("mystical-run-helper: %s" % e, file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 — one line, never a traceback
        print("mystical-run-helper: %s: %s" % (type(e).__name__, " ".join(str(e).split())), file=sys.stderr)
        return 1


if __name__ == "__main__":
    # A bridge restart TERMs this helper with it: unwinding runs the finally
    # blocks, which stop the run and take its token and folder with it.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(129))
    sys.exit(main())
