"""The tray companion's logic (linux/tray.py) and the seams between the trays
and bridge/startup.py, which writes their login entries. The GTK half runs in
a Linux desktop container instead (the plan's Task 8); windows/tray.ps1's pure
half is asserted by windows/tray.check.ps1 under pwsh.
Run: python3 -m pytest tests/test_tray.py -q"""

import importlib.util
import io
import os
import re
import shutil
import subprocess

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "linux_tray", os.path.join(_ROOT, "linux", "tray.py"))
tray = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tray)


def _run(status, jobs=(), watched=False):
    return {"status": status, "jobs": list(jobs), "watched": watched}


def test_the_first_poll_is_a_baseline():
    assert tray.alerts(None, {"a": {"state": "awaiting", "label": "Which DB?"}}, {}) == []


def test_a_session_that_starts_waiting_alerts_once():
    prev = {"a": {"state": "working", "label": "running Bash"}}
    cur = {"a": {"state": "awaiting", "label": "Which DB?"}}
    assert tray.alerts(prev, cur, {"a": "fix login"}) == [
        {"id": "a", "title": "⏸ fix login", "body": "Which DB?"}]
    assert tray.alerts(cur, cur, {"a": "fix login"}) == []      # still waiting: not news


def test_parked_on_a_limit_alerts():
    cur = {"a": {"state": "parked", "label": "usage limit — resuming ~14:00"}}
    assert tray.alerts({}, cur, {"a": "x"}) == [
        {"id": "a", "title": "⏳ x", "body": "usage limit — resuming ~14:00"}]


def test_a_working_session_that_leaves_is_done():
    prev = {"a": {"state": "working", "label": "running Bash"}}
    assert tray.alerts(prev, {}, {"a": "fix login"}) == [
        {"id": "a", "title": "✓ fix login", "body": "finished"}]
    # No title known: "session", never the activity label.
    assert tray.alerts(prev, {}, {})[0]["title"] == "✓ session"


def test_working_into_awaiting_or_parked_is_not_done():
    prev = {"a": {"state": "working"}, "b": {"state": "working"}}
    cur = {"a": {"state": "awaiting"}, "b": {"state": "parked"}}
    assert sorted(n["title"][0] for n in tray.alerts(prev, cur, {})) == ["⏳", "⏸"]


def test_titles_outlive_the_job_that_carried_them():
    titles = {}
    _, prev, _ = tray.step(None, _run({"a": {"state": "working"}},
                                      [{"session_id": "a", "title": "fix login"}]), titles)
    news, _, rows = tray.step(
        prev, _run({"a": {"state": "awaiting", "label": "Which DB?"}}), titles)
    assert news[0]["title"] == "⏸ fix login"
    assert rows == [("a", "fix login")]


def test_waiting_rows_fall_back_to_the_label_and_sort_by_title():
    status = {"b": {"state": "awaiting", "label": "Zed?"}, "a": {"state": "awaiting"},
              "c": {"state": "working"}}
    assert tray.waiting(status, {"b": "alpha"}) == [("b", "alpha"), ("a", "waiting on you")]


def test_watched_moves_state_on_without_alerting():
    titles = {}
    _, prev, _ = tray.step(None, _run({"a": {"state": "working"}}), titles)
    news, prev, _ = tray.step(prev, _run({"a": {"state": "awaiting"}}, watched=True), titles)
    assert news == []
    # The window closes: the question it already rang for must not ring again.
    news, _, _ = tray.step(prev, _run({"a": {"state": "awaiting"}}), titles)
    assert news == []


def test_a_bridge_that_comes_back_starts_a_fresh_baseline():
    titles = {}
    _, prev, _ = tray.step(None, _run({"a": {"state": "working"}}), titles)
    assert tray.step(prev, None, titles) == ([], None, [])               # down
    news, _, _ = tray.step(None, _run({"a": {"state": "awaiting"}}), titles)  # back up
    assert news == []


def test_session_url_carries_the_token_only_when_there_is_one():
    assert tray.session_url(8790, "/?token=abc", "s 1") == \
        "http://localhost:8790/?token=abc&s=s%201&skipboot"
    assert tray.session_url(8790, "/", "s1") == "http://localhost:8790/?s=s1&skipboot"
    assert tray.session_url(8790, None) == "http://localhost:8790/"      # manifest unreachable
    assert tray.session_url(8790, "/?token=abc") == "http://localhost:8790/?token=abc"


def test_a_second_tray_backs_off(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    first = tray.single_instance()
    assert first is not None
    assert tray.single_instance() is None
    first.close()
    again = tray.single_instance()
    assert again is not None
    again.close()


def test_missing_bindings_name_the_packages(monkeypatch):
    def gone():
        raise ImportError("No module named 'gi'")
    monkeypatch.setattr(tray, "bindings", gone)
    why = tray.missing()
    assert "gir1.2-ayatanaappindicator3-0.1" in why and "libayatana-appindicator-gtk3" in why


def test_check_exits_1_and_names_the_packages(monkeypatch, capsys):
    def gone():
        raise ValueError("Namespace AyatanaAppIndicator3 not available")
    monkeypatch.setattr(tray, "bindings", gone)
    assert tray.main(["--check"]) == 1
    assert "gir1.2-notify-0.7" in capsys.readouterr().err


def test_the_windows_tray_stays_readable_by_windows_powershell_5_1():
    """5.1 reads a BOM-less script as ANSI, so the file stays ASCII (glyphs come
    from code points); and it has none of PowerShell 7's operators."""
    raw = open(os.path.join(_ROOT, "windows", "tray.ps1"), "rb").read()
    assert raw.isascii(), "build glyphs from code points: [char]0x23F8"
    code = [ln for ln in raw.decode("ascii").splitlines() if not ln.lstrip().startswith("#")]
    for op in ("??", "?.", "&&", "||"):
        assert not any(op in ln for ln in code), f"{op} is PowerShell 7 only"


def test_startup_passes_only_arguments_the_linux_tray_takes():
    from bridge import startup
    argv = startup._tray_argv(False, "/usr/bin/google-chrome", "Profile 5")
    assert argv[:2] == ["/usr/bin/python3", os.path.join(startup._REPO, "linux", "tray.py")]
    a = tray.parser().parse_args(argv[2:])
    assert (a.browser, a.profile) == ("/usr/bin/google-chrome", "Profile 5")


def test_startup_passes_only_parameters_the_windows_tray_declares():
    from bridge import startup
    argv = startup._tray_argv(
        True, "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe", "Profile 2")
    passed = {name[1:] for name in argv[argv.index("-File") + 2:][::2]}
    text = open(os.path.join(_ROOT, "windows", "tray.ps1"), encoding="ascii").read()
    declared = set(re.findall(r"\$(\w+)", text.split("param(", 1)[1].split("\n)", 1)[0]))
    assert passed == {"Port", "Distro", "User", "Repo", "Browser", "BrowserProfile"}
    assert passed <= declared, passed - declared


def test_a_native_session_pausing_is_not_done():
    """A VS Code or terminal session reads `working` only within 3 s of its last
    transcript write (native_activity.WORKING_WINDOW), so every long tool call
    flips it to `live`. Counting that as done would alert on every pause."""
    prev = {"n": {"state": "working", "source": "native", "label": "working…"}}
    assert tray.alerts(prev, {"n": {"state": "live", "source": "native"}}, {}) == []
    assert tray.alerts(prev, {}, {}) == []


def test_the_trays_call_the_bridge_on_the_address_it_binds(monkeypatch):
    """The server binds 127.0.0.1, while `localhost` can try ::1 first, and on
    Windows a refused ::1 costs about two seconds before the fallback. Windows
    still open on localhost: that's the installed app's origin."""
    seen = []

    class Answer:
        def __enter__(self):
            return io.BytesIO(b'{"ok": 1}')

        def __exit__(self, *exc):
            return False
    monkeypatch.setattr(tray._HTTP, "open",
                        lambda url, timeout: seen.append(url) or Answer())
    assert tray.fetch(8790, "/local/running") == {"ok": 1}
    assert seen == ["http://127.0.0.1:8790/local/running"]


def test_mystical_app_hands_the_tray_the_port_from_env(tmp_path):
    """bridge.config reads DASH_PORT from the environment, which run.sh fills from
    .env; `mystical app` has to load .env too, or a custom port gets a tray
    polling 8790. The real script, with uname saying Linux and a python3 that
    reports the port it was handed."""
    repo = tmp_path / "repo"
    (repo / "bin").mkdir(parents=True)
    shutil.copy(os.path.join(_ROOT, "bin", "mystical"), repo / "bin" / "mystical")
    (repo / ".env").write_text('DASH_PORT="8899"\n')
    fake = tmp_path / "fakebin"
    fake.mkdir()
    for name, body in (("uname", "echo Linux"), ("python3", 'echo "port=$DASH_PORT"')):
        (fake / name).write_text(f"#!/bin/bash\n{body}\n")
        (fake / name).chmod(0o755)
    env = {**os.environ, "PATH": f"{fake}:/usr/bin:/bin", "HOME": str(tmp_path / "home")}
    env.pop("DASH_PORT", None)
    p = subprocess.run([str(repo / "bin" / "mystical"), "app"], capture_output=True,
                       text=True, env=env, timeout=30)
    assert "port=8899" in p.stdout, p.stdout + p.stderr


def test_open_window_carries_the_manifest_token(monkeypatch):
    """The launcher's window must land with ?token= — without it the dashboard
    only shows "Missing token"."""
    opened = []
    monkeypatch.setattr(tray, "fetch", lambda port, path: {"start_url": "/?token=abc"})
    monkeypatch.setattr(tray, "open_url", lambda *a: opened.append(a))
    monkeypatch.setattr(tray.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(AssertionError("up already")))
    assert tray.open_window(8790, "chrome", "Default") is True
    assert opened == [("http://localhost:8790/?token=abc", "chrome", "Default")]


def test_open_window_starts_the_unit_and_still_opens_when_it_never_answers(monkeypatch):
    opened, ran = [], []
    monkeypatch.setattr(tray, "fetch", lambda port, path: None)
    monkeypatch.setattr(tray, "open_url", lambda *a: opened.append(a))
    monkeypatch.setattr(tray.subprocess, "run", lambda argv, **k: ran.append(argv))
    monkeypatch.setattr(tray.time, "sleep", lambda _s: None)
    assert tray.open_window(8790, None, None, wait_s=0) is False
    assert ran == [["systemctl", "--user", "start", "mystical-assistant.service"]]
    assert opened == [("http://localhost:8790/", None, None)]
