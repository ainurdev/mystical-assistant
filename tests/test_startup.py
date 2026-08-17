"""Start-at-login, which is two host-side files rather than a setting.

The interesting cases are all about *not* acting: a machine with no Windows side,
or with several Windows profiles, has to report why instead of writing a launcher
into a folder nobody logs into. And turning the switch off must never stop the
running bridge — the switch is almost always flicked from a browser talking to it.
"""

import os

import pytest

from bridge import startup


def test_win_path_converts_wsl_mounts():
    assert startup._win_path("/mnt/c/Program Files/Google/chrome.exe") == \
        r"C:\Program Files\Google\chrome.exe"
    # A drive other than C, and a path that is not a mount at all.
    assert startup._win_path("/mnt/d/tools/x.exe") == r"D:\tools\x.exe"
    assert startup._win_path("/usr/bin/curl") == "/usr/bin/curl"


def test_script_is_crlf_so_cmd_can_parse_the_if_block():
    # cmd.exe mis-parses a multi-line `if (...)` block written with bare LFs.
    text = startup._script(True)
    assert "\r\n" in text
    assert "\n" not in text.replace("\r\n", "")


def test_script_opens_a_window_only_when_asked():
    assert "--app=" in startup._script(True)
    assert "--app=" not in startup._script(False)
    # Either way it still has to boot WSL and wait for the port.
    for text in (startup._script(True), startup._script(False)):
        assert "wsl.exe" in text
        assert "curl -sf" in text


def test_script_waits_rather_than_sleeping():
    """A fixed sleep races WSL boot; the loop is the whole point of the file."""
    text = startup._script(True)
    assert "for i in $(seq 1 60)" in text
    assert "errorlevel 1" in text


def test_state_reports_why_when_there_is_no_windows_side(monkeypatch):
    monkeypatch.setattr(startup, "_has_systemd", lambda: True)
    monkeypatch.setattr(startup, "_startup_dir", lambda: None)
    st = startup.state()
    assert st["supported"] is False
    assert st["reason"]
    assert st["login"] is False


def test_state_reports_why_when_there_is_no_systemd(monkeypatch):
    monkeypatch.setattr(startup, "_has_systemd", lambda: False)
    st = startup.state()
    assert st["supported"] is False
    assert "systemd" in st["reason"]


def test_several_windows_profiles_is_declined_not_guessed(monkeypatch):
    monkeypatch.setattr(startup.glob, "glob", lambda _p: [
        "/mnt/c/Users/alice/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
        "/mnt/c/Users/bob/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
    ])
    monkeypatch.setattr(os.path, "isdir", lambda _p: True)
    assert startup._startup_dir() is None


def test_shared_windows_profiles_are_not_counted_as_a_second_user(monkeypatch):
    monkeypatch.setattr(startup.glob, "glob", lambda _p: [
        "/mnt/c/Users/alice/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
        "/mnt/c/Users/Public/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
        "/mnt/c/Users/Default/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
    ])
    monkeypatch.setattr(os.path, "isdir", lambda _p: True)
    assert startup._startup_dir().startswith("/mnt/c/Users/alice/")


def test_apply_refuses_when_unsupported(monkeypatch):
    monkeypatch.setattr(startup, "_has_systemd", lambda: False)
    with pytest.raises(RuntimeError):
        startup.apply(True, True)


def test_turning_login_off_never_stops_the_running_bridge(monkeypatch, tmp_path):
    """The switch is flicked from a browser served BY the bridge it governs."""
    calls = []

    def fake_systemctl(*args):
        calls.append(args)
        class R:
            returncode = 0
            stdout = ""
            stderr = ""
        return R()

    cmd = tmp_path / startup.CMD_NAME
    cmd.write_text("old launcher")
    monkeypatch.setattr(startup, "_has_systemd", lambda: True)
    monkeypatch.setattr(startup, "_startup_dir", lambda: str(tmp_path))
    monkeypatch.setattr(startup, "_systemctl", fake_systemctl)

    startup.apply(False, False)

    assert ("disable", startup.UNIT) in calls
    assert not any("stop" in c for c in calls), f"must not stop the bridge: {calls}"
    assert not cmd.exists(), "the Startup launcher should be gone"


def test_unit_pins_a_path_without_pyenv_shims(monkeypatch):
    """A user unit inherits a minimal PATH; the shims would move python3 off the
    system interpreter the bridge runs on."""
    monkeypatch.setattr(startup.shutil, "which", lambda exe: {
        "claude": "/home/u/.local/bin/claude",
        "node": "/home/u/.pyenv/shims/node",
    }.get(exe))
    text = startup._unit_text()
    path = next(ln for ln in text.splitlines() if ln.startswith("Environment=PATH="))
    assert "/home/u/.local/bin" in path
    assert ".pyenv/shims" not in path
    assert "/usr/bin" in path
    assert "Restart=on-failure" in text
