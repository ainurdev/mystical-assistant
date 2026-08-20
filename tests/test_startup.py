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
    """A fixed sleep races WSL boot; the loop is the whole point of the file.
    Quarter-second polls, so the window opens the moment the port answers."""
    text = startup._script(True)
    assert "for i in $(seq 1 240)" in text
    assert "sleep 0.25" in text
    assert "errorlevel 1" in text


def test_script_takes_an_explicit_profile_over_the_guess(monkeypatch):
    monkeypatch.setattr(startup, "_browser",
                        lambda: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe")
    monkeypatch.setattr(startup, "_profile", lambda *_: "Profile 2")
    assert '--profile-directory="Profile 4"' in startup._script(True, "Profile 4")
    # No choice made: the guess still decides, as it always has.
    assert '--profile-directory="Profile 2"' in startup._script(True)


def test_profiles_lists_what_the_browser_knows(tmp_path, monkeypatch):
    """The selector needs every profile with its human name, not just the guess."""
    win = tmp_path / "Users/me"
    startup_dir = win / "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"
    startup_dir.mkdir(parents=True)
    data = win / "AppData/Local/Google/Chrome/User Data"
    data.mkdir(parents=True)
    (data / "Local State").write_text(
        '{"profile":{"info_cache":{"Default":{"name":"Alice"},'
        '"Profile 2":{"name":"Work"},"Profile 3":{}}}}')
    monkeypatch.setattr(startup, "_startup_dir", lambda: str(startup_dir))
    chrome = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
    assert startup._profiles(chrome) == [
        {"dir": "Default", "name": "Alice"},
        {"dir": "Profile 2", "name": "Work"},
        {"dir": "Profile 3", "name": "Profile 3"},   # no name recorded: the dir stands in
    ]
    # No Local State at all — an empty list, never a raise.
    monkeypatch.setattr(startup, "_startup_dir", lambda: str(tmp_path / "no/x"))
    assert startup._profiles(chrome) == []


def test_state_reports_the_profile_written_into_the_launcher(tmp_path, monkeypatch):
    """What the selector shows must be what the .cmd will actually do."""
    (tmp_path / startup.CMD_NAME).write_text(
        'wsl.exe ...\r\nstart "" "C:\\chrome.exe" --profile-directory="Profile 2" '
        '--app=http://localhost:8790/\r\n')
    monkeypatch.setattr(startup, "_wsl", lambda: True)
    monkeypatch.setattr(startup, "_has_systemd", lambda: True)
    monkeypatch.setattr(startup, "_startup_dir", lambda: str(tmp_path))
    monkeypatch.setattr(startup, "_systemctl", _fake_systemctl([]))
    monkeypatch.setattr(startup, "_browser", lambda: "/mnt/c/x/chrome.exe")
    monkeypatch.setattr(startup, "_profiles",
                        lambda _b: [{"dir": "Profile 2", "name": "Work"}])
    st = startup.state()
    assert st["profile"] == "Profile 2"
    assert st["profiles"] == [{"dir": "Profile 2", "name": "Work"}]


def test_state_reports_why_when_there_is_no_windows_side(monkeypatch):
    monkeypatch.setattr(startup, "_wsl", lambda: True)   # holds off WSL too
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
    monkeypatch.setattr(startup, "_wsl", lambda: True)
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


def test_profile_picks_the_one_that_has_used_the_dashboard(tmp_path, monkeypatch):
    """Four Chrome profiles, one of them ours: the launcher must name it, or the
    window is a coin flip."""
    win = tmp_path / "Users/me"
    startup_dir = win / "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"
    startup_dir.mkdir(parents=True)
    data = win / "AppData/Local/Google/Chrome/User Data"
    for i, (name, text) in enumerate([("Default", "{}"),
                                      ("Profile 2", '{"x":"http://localhost:8790,*"}'),
                                      ("Profile 3", "{}")]):
        (data / name).mkdir(parents=True)
        prefs = data / name / "Preferences"
        prefs.write_text(text)
        os.utime(prefs, (0, 100 - i))          # Default is the most recently written
    monkeypatch.setattr(startup, "_startup_dir", lambda: str(startup_dir))
    chrome = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
    assert startup._profile(chrome, 8790) == "Profile 2"

    # Nothing has visited it yet — fall back to whatever Chrome last had open.
    (data / "Profile 2" / "Preferences").write_text("{}")
    (data / "Local State").write_text('{"profile":{"last_used":"Profile 3"}}')
    assert startup._profile(chrome, 8790) == "Profile 3"

    # No Chrome data at all: no flag, and Chrome picks as it does today.
    monkeypatch.setattr(startup, "_startup_dir", lambda: str(tmp_path / "no/AppData/x"))
    assert startup._profile(chrome, 8790) is None


def test_profile_reads_the_linux_chrome_dir(tmp_path, monkeypatch):
    """Same idea off WSL, where Chrome keeps its profiles under ~/.config."""
    monkeypatch.setenv("HOME", str(tmp_path))
    prof = tmp_path / ".config/google-chrome/Profile 5"
    prof.mkdir(parents=True)
    (prof / "Preferences").write_text('{"x":"http://localhost:8790,*"}')
    assert startup._profile("/usr/bin/google-chrome", 8790) == "Profile 5"
    assert startup._profile("/usr/bin/chromium", 8790) is None   # different dir


def test_linux_gets_an_autostart_entry_instead_of_a_windows_launcher(tmp_path, monkeypatch):
    """No distro to wake here, so start-at-login is the unit plus a .desktop —
    and a machine without /mnt/c must not be told it is unsupported."""
    entry = tmp_path / "autostart/mystical-assistant.desktop"
    monkeypatch.setattr(startup, "_wsl", lambda: False)
    monkeypatch.setattr(startup, "_AUTOSTART", str(entry))
    monkeypatch.setattr(startup, "_has_systemd", lambda: True)
    monkeypatch.setattr(startup, "_browser", lambda: "/usr/bin/google-chrome")
    monkeypatch.setattr(startup, "_profile", lambda *_: "Profile 5")
    monkeypatch.setattr(startup, "_unit_text", lambda: "[Unit]\n")
    monkeypatch.setattr(startup, "_systemctl", _fake_systemctl([]))
    monkeypatch.setattr(startup.subprocess, "run", lambda *a, **k: None)
    monkeypatch.setattr(startup, "_UNIT_DIR", str(tmp_path / "systemd"))

    st = startup.apply(True, True)
    assert st["supported"] is True
    text = entry.read_text()
    assert "Exec=sh -c" in text and "--app=http://localhost:" in text
    assert "'--profile-directory=Profile 5'" in text
    assert "sleep 0.25" in text
    assert "$" not in text, "a $ in Exec needs escaping the spec makes fiddly"

    # An explicit choice beats the guess, and state() reads it back out of the
    # entry — the artifact is the persistence.
    monkeypatch.setattr(startup, "_profiles", lambda _b: [])
    st = startup.apply(True, True, "Profile 7")
    assert "'--profile-directory=Profile 7'" in entry.read_text()
    assert st["profile"] == "Profile 7"

    startup.apply(True, False)          # window off, login still on
    assert not entry.exists()


def _fake_systemctl(calls):
    class R:
        returncode = 0
        stdout = "enabled"
        stderr = ""

    def run(*args):
        calls.append(args)
        return R()
    return run
