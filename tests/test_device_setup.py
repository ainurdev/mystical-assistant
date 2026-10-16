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
import plistlib
import re
import shlex
import stat
import subprocess
import types

import pytest

from bridge import device_setup, device_share

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bridge", "device_setup")
PREFIX, SUFFIX = "do shell script ", " with administrator privileges"


@pytest.fixture(autouse=True)
def no_real_prompt(monkeypatch):
    """device_setup.run's own runner is subprocess.run, which in production raises
    the admin password prompt and runs the script as root. Here it refuses, and a
    test that reaches it fails: every test hands run= its own fake."""
    reached = []

    def refuse(argv, **kw):
        reached.append(list(argv))
        raise AssertionError("device_setup.run reached a real command: %r" % (argv,))
    monkeypatch.setattr(device_setup.run, "__defaults__", (device_setup.run.__defaults__[0], refuse))
    yield
    assert not reached, "device_setup.run reached a real command: %r" % reached


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
    """Set up also gets the bridge's ports, to wall the hidden user off them;
    Remove takes down whatever wall there is."""
    run = fake(out='{"ok": true}\n')
    device_setup.run(action, owner, run=run)
    (cmd, kw), = run.calls
    assert cmd[:2] == ["osascript", "-e"] and len(cmd) == 3
    assert kw["timeout"] == 900
    assert cmd[2].startswith(PREFIX) and cmd[2].endswith(SUFFIX)
    shell = _read_applescript(cmd[2][len(PREFIX):-len(SUFFIX)])
    ports = [str(p) for p in device_share.wall_ports()] if action == "setup" else []
    assert shlex.split(shell) == ["/bin/bash", os.path.join(SCRIPTS, script), owner, *ports]
    assert os.path.isfile(os.path.join(SCRIPTS, script))


def test_the_owner_defaults_to_this_account():
    run = fake(out='{"ok": true}\n')
    device_setup.run("setup", run=run)
    shell = _read_applescript(run.calls[0][0][2][len(PREFIX):-len(SUFFIX)])
    assert shlex.split(shell)[2] == getpass.getuser(), "the first argument after the script"


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


# --- the wall: the hidden user can't reach this bridge's own ports -------------------------
# Set up puts one pf rule in the com.apple/mysticalruns anchor, turns pf on with a
# reference of its own, installs a boot job that does both again, and proves the
# wall as the hidden user; Remove undoes it all. The functions run here on a PATH
# of fake binaries and nothing else: pfctl, launchctl and sudo log each call and
# act it out, never running anything; chmod, mv and rm run for real, but only on
# paths inside the test's temp dir. Any other command is "not found".

WALLED = [str(p) for p in device_share.wall_ports()]
RULE = "block drop out quick proto tcp from any to any port { %s } user mysticalruns\n" % ", ".join(WALLED)
LABEL = "cloud.ainurhq.mystical-runs.pf"
REAL_PATHS = {"PF_ANCHOR": "com.apple/mysticalruns", "PF_LABEL": LABEL,
              "PF_RULES": "/usr/local/etc/mystical-runs.pf", "PF_TOKEN": "/usr/local/etc/mystical-runs.pf.token",
              "PF_DAEMON": "/Library/LaunchDaemons/%s.plist" % LABEL}

_LOG = 'printf "%s\\t" "${0##*/}" "$@" >>"$FAKE_LOG"; echo >>"$FAKE_LOG"\n'
_FAKES = {
    # -E prints what macOS's pfctl prints, its reference last; PFCTL_FAIL makes the
    # call carrying that flag fail; PF_TOKEN_OUT="" turns pf on without a reference.
    "pfctl": _LOG + 'for a; do [ "$a" != "${PFCTL_FAIL:-}" ] || exit 1; done\n'
                    'if [ "$1" = -E ]; then echo "No ALTQ support in kernel" >&2; echo "pf enabled" >&2\n'
                    '  [ -z "${PF_TOKEN_OUT-4242}" ] || echo "Token : ${PF_TOKEN_OUT-4242}" >&2; fi\n',
    "launchctl": _LOG + "exit 3\n",              # "no such service": not loaded until the next boot
    # Only the wall's own check is acted out: it connects (0) to OPEN_PORTS, else not (1).
    "sudo": _LOG + 'if [ "$1 $2 $3 $4 $5 $6 $7" = "-u mysticalruns /usr/bin/nc -z -G 2 127.0.0.1" ]; then\n'
                   '  case " ${OPEN_PORTS:-} " in *" $8 "*) exit 0 ;; esac; exit 1; fi\n'
                   'echo "REFUSED" >>"$FAKE_LOG"; exit 97\n',
}
for _real in ("chmod", "mv", "rm"):
    _FAKES[_real] = _LOG + ('for a; do case "$a" in -*|[0-9]*|"$FAKE_ROOT"/*) ;; *) echo "REFUSED $a" >>"$FAKE_LOG"; '
                            'exit 98 ;; esac; done\nexec /bin/%s "$@"\n' % _real)


def _functions(script):
    """Every multi-line function `script` defines, as source (a one-line one,
    like `fail`, stays out: the tests stub it)."""
    with open(os.path.join(SCRIPTS, script), encoding="utf-8") as f:
        text = f.read()
    out, at = [], 0
    while True:
        m = re.search(r"^[a-z_]+\(\) \{(?![^\n]*\}$)[^\n]*\n", text[at:], re.M)
        if not m:
            return "".join(out)
        start = at + m.start()
        end = text.index("\n}\n", start) + 3
        out.append(text[start:end])
        at = end


def _assignments(script, prefix="PF_"):
    with open(os.path.join(SCRIPTS, script), encoding="utf-8") as f:
        return dict(line.split("=", 1) for line in f.read().splitlines() if line.startswith(prefix))


@pytest.fixture
def fb(tmp_path):
    """The fake binaries, the wall's files in the temp dir, and run(): the
    script's functions under its own set -euo pipefail, `fail` stubbed (it prints
    and exits 1)."""
    b = types.SimpleNamespace(bin=tmp_path / "bin", log=tmp_path / "log", rules=tmp_path / "etc" / "mystical-runs.pf",
                              token=tmp_path / "etc" / "mystical-runs.pf.token", config=tmp_path / "etc" / "mystical-runs.json",
                              daemon=tmp_path / "LaunchDaemons" / (LABEL + ".plist"))
    for d in (b.bin, b.rules.parent, b.daemon.parent):
        d.mkdir()
    for name, body in _FAKES.items():
        (b.bin / name).write_text("#!/bin/sh\n" + body)
        (b.bin / name).chmod(0o755)
    b.log.write_text("")

    def run(call, *args, script="setup.sh", **env):
        head = ("set -euo pipefail\nRUN_USER=mysticalruns\nPF_ANCHOR=com.apple/mysticalruns\nPF_LABEL=%s\n"
                "PF_RULES=%s\nPF_TOKEN=%s\nPF_DAEMON=%s\nCONFIG=%s\nfail() { echo \"$1\"; exit 1; }\n"
                % (LABEL, b.rules, b.token, b.daemon, b.config))
        return subprocess.run(["/bin/bash", "-c", head + _functions(script) + call + ' "$@"', "_", *args],
                              env={"PATH": str(b.bin), "FAKE_LOG": str(b.log), "FAKE_ROOT": str(tmp_path), **env},
                              capture_output=True, text=True, timeout=30)

    def calls(name=None):
        rows = [line.rstrip("\t").split("\t") for line in b.log.read_text().splitlines() if line]
        return [r[1:] for r in rows if name is None or r[0] == name]

    b.run, b.calls = run, calls
    yield b
    assert not [r for r in calls() if r[0].startswith("REFUSED")], "a fake refused a call: %r" % calls()


def _mode(path):
    return stat.S_IMODE(os.lstat(path).st_mode)


def test_set_up_walls_the_hidden_user_off_the_bridges_ports_and_proves_it(fb):
    r = fb.run("wall", *WALLED)
    assert r.returncode == 0, r.stdout + r.stderr
    assert fb.rules.read_text() == RULE and _mode(fb.rules) == 0o644, "exactly one rule"
    assert fb.token.read_text() == "4242\n" and _mode(fb.token) == 0o600, "the reference, kept for Remove"
    job = plistlib.loads(fb.daemon.read_bytes())
    assert _mode(fb.daemon) == 0o644 and job["Label"] == LABEL and job["RunAtLoad"] is True
    assert job["ProgramArguments"][:2] == ["/bin/sh", "-c"]
    assert fb.calls("pfctl") == [["-a", "com.apple/mysticalruns", "-f", str(fb.rules)], ["-E"]]
    assert fb.calls("sudo") == [["-u", "mysticalruns", "/usr/bin/nc", "-z", "-G", "2", "127.0.0.1", p] for p in WALLED], \
        "every walled port is tried, as the hidden user"
    assert fb.calls("launchctl") == [], "the boot job loads at the next boot: pf holds the rule now"


def test_a_wall_set_up_again_lets_go_of_the_reference_it_held_before(fb):
    fb.token.write_text("1111\n")
    assert fb.run("wall", *WALLED).returncode == 0
    assert fb.calls("pfctl") == [["-a", "com.apple/mysticalruns", "-f", str(fb.rules)], ["-X", "1111"], ["-E"]]
    assert fb.token.read_text() == "4242\n", "this device holds one reference, not one per Set up"


@pytest.mark.parametrize("leak", WALLED)
def test_a_wall_the_hidden_user_gets_through_comes_down_and_set_up_fails_closed(fb, leak):
    """A customised pf.conf, or a skip on lo0, lets the connect through: Set up
    undoes the wall, drops the record that says the device is set up, and names why."""
    fb.config.write_text('{"walled": []}')       # an earlier Set up's record
    r = fb.run("wall", *WALLED, OPEN_PORTS=leak)
    assert r.returncode == 1
    assert ("port %s" % leak) in r.stdout and "pf.conf" in r.stdout and "lo0" in r.stdout, r.stdout
    assert not [p for p in (fb.rules, fb.token, fb.daemon, fb.config) if os.path.lexists(p)]
    assert ["-a", "com.apple/mysticalruns", "-F", "all"] in fb.calls("pfctl")
    assert ["-X", "4242"] in fb.calls("pfctl"), "the reference this run took is let go"
    assert ["bootout", "system/" + LABEL] in fb.calls("launchctl")


@pytest.mark.parametrize("why, env", [
    ("pf won't load the rule", {"PFCTL_FAIL": "-f"}),
    ("pf turns on without a reference to keep", {"PF_TOKEN_OUT": ""}),
])
def test_a_packet_filter_that_refuses_fails_set_up_with_nothing_of_the_wall_left(fb, why, env):
    fb.config.write_text("{}")
    r = fb.run("wall", *WALLED, **env)
    assert r.returncode == 1 and r.stdout.strip(), why
    assert not [p for p in (fb.rules, fb.token, fb.daemon, fb.config) if os.path.lexists(p)], why
    assert fb.calls("sudo") == [], "no check of a wall that never went up"


@pytest.mark.parametrize("script", ["setup.sh", "remove.sh"])
def test_taking_the_wall_down_undoes_every_part_and_minds_none_already_gone(fb, script):
    fb.rules.write_text(RULE)
    fb.token.write_text("4242\n")
    fb.daemon.write_text("<plist/>")
    assert fb.run("unwall", script=script).returncode == 0
    assert fb.calls("launchctl") == [["bootout", "system/" + LABEL]]
    assert fb.calls("pfctl") == [["-a", "com.apple/mysticalruns", "-F", "all"], ["-X", "4242"]]
    assert not [p for p in (fb.rules, fb.token, fb.daemon) if os.path.lexists(p)]
    fb.log.write_text("")
    assert fb.run("unwall", script=script).returncode == 0, "again, with nothing left"
    assert ["-X"] not in [c[:1] for c in fb.calls("pfctl")], "no reference to let go of"


def test_set_up_and_remove_name_the_wall_the_same_and_where_the_ruling_puts_it():
    assert _assignments("setup.sh") == REAL_PATHS
    assert _assignments("remove.sh") == REAL_PATHS
    assert _functions("setup.sh").count("unwall() {") == _functions("remove.sh").count("unwall() {") == 1
    with open(os.path.join(SCRIPTS, "setup.sh"), encoding="utf-8") as f:
        setup = f.read()
    with open(os.path.join(SCRIPTS, "remove.sh"), encoding="utf-8") as f:
        remove = f.read()
    cut = lambda text: text[text.index("unwall() {"):text.index("\n}\n", text.index("unwall() {"))]   # noqa: E731
    assert cut(setup) == cut(remove), "one way to take it down"


def test_the_boot_job_puts_the_rule_back_turns_pf_on_and_keeps_the_new_reference():
    head = "".join("%s=%s\n" % kv for kv in REAL_PATHS.items())
    r = subprocess.run(["/bin/bash", "-c", "set -euo pipefail\n" + head + _functions("setup.sh") + "daemon_plist"],
                       env={"PATH": "/nonexistent"}, capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    job = plistlib.loads(r.stdout.encode())
    assert job == {"Label": LABEL, "RunAtLoad": True, "ProgramArguments": [
        "/bin/sh", "-c",
        "umask 077; /sbin/pfctl -a com.apple/mysticalruns -f /usr/local/etc/mystical-runs.pf && "
        "/sbin/pfctl -E 2>&1 | /usr/bin/sed -n 's/^Token : //p' >/usr/local/etc/mystical-runs.pf.token"]}


@pytest.mark.parametrize("ports, ok", [
    (["8787", "8790", "8791"], True), (["1"], True), (["65535"], True),
    ([], False), ([""], False), (["0"], False), (["65536"], False), (["08790"], False), (["8790x"], False),
    (["-1"], False), (["8790; rm -rf /"], False), (["99999999999999999999"], False),
])
def test_set_up_takes_only_real_ports(ports, ok):
    r = _run_function("setup.sh", "check_ports", *ports)
    assert (r.returncode == 0) is ok, (ports, r.stdout + r.stderr)


def test_set_up_walls_the_user_before_anything_runs_as_it_and_records_the_ports():
    with open(os.path.join(SCRIPTS, "setup.sh"), encoding="utf-8") as f:
        text = f.read()
    created, walled = text.index("sysadminctl -addUser"), text.index('\nwall "${ports[@]}"\n')
    assert created < walled < text.index("claude.ai/install.sh") < text.index('"walled": [%s]'), \
        "after the user exists (pf resolves its name), before anything runs as it, and recorded with the setup"
    assert "root_only /Library/LaunchDaemons" in text, "the boot job's folder is root's alone too"


def test_remove_takes_the_wall_down_once_the_user_is_gone():
    with open(os.path.join(SCRIPTS, "remove.sh"), encoding="utf-8") as f:
        text = f.read()
    assert text.index("sysadminctl -deleteUser") < text.index("\nunwall\n"), \
        "while the hidden user still exists, the wall stays up"
