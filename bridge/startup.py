"""Does the bridge come up at login, and does the dashboard window come up with it?

Two host-side pieces, neither of them in this repo — which is exactly why they need
a switch that can also *report* on them:

  1. a systemd **user unit** that runs run.sh, enabled + lingering, and
  2. a launcher that opens the window: a **.cmd in the Windows Startup folder**
     under WSL, a **~/.config/autostart entry** on a plain Linux desktop.

Under WSL the second is what makes the first fire at all: nothing on the Linux side
runs until Windows touches the distro, so the .cmd's real job is booting it, and
opening the window afterwards is the optional half. Off WSL there is nothing to
wake — the unit already came up at boot — so the launcher is only the window.

Everything here is best-effort and reversible, and `state()` never raises — a machine
with no /mnt/c, several Windows profiles, or no systemd just reports
`supported: False` with a reason, and the UI hides the switches.
"""
from __future__ import annotations

import getpass
import glob
import json
import os
import platform
import shutil
import subprocess

UNIT = "mystical-assistant.service"
CMD_NAME = "mystical-assistant.cmd"
# The native-Linux counterpart of the .cmd's second half: every desktop honours
# ~/.config/autostart, whereas systemd's graphical-session.target only exists on
# the desktops that bothered to wire it up.
_AUTOSTART = os.path.expanduser("~/.config/autostart/mystical-assistant.desktop")
_UNIT_DIR = os.path.expanduser("~/.config/systemd/user")
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Chrome first, Edge as the fallback: both render the PWA, but an installed app
# lives in whichever one installed it, and Chrome is the common case.
_BROWSERS = (
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
)
_LINUX_BROWSERS = ("google-chrome", "google-chrome-stable", "chromium",
                   "chromium-browser", "microsoft-edge")
_SKIP_PROFILES = {"Public", "Default", "Default User", "All Users"}


# --- host probing -------------------------------------------------------------
def _win_path(p: str) -> str:
    """/mnt/c/Program Files/x -> C:\\Program Files\\x (what cmd.exe needs)."""
    if not p.startswith("/mnt/") or len(p) < 7:
        return p
    return p[5].upper() + ":" + p[6:].replace("/", "\\")


def _startup_dir() -> str | None:
    """The one Windows profile's Startup folder, or None if that is ambiguous.

    More than one real profile means we cannot know which one logs in, and writing
    to the wrong one would be a switch that silently does nothing — so we decline
    instead of guessing."""
    hits = []
    for d in glob.glob(
            "/mnt/c/Users/*/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"):
        who = d.split("/Users/", 1)[1].split("/", 1)[0]
        if os.path.isdir(d) and who not in _SKIP_PROFILES:
            hits.append(d)
    return hits[0] if len(hits) == 1 else None


def _wsl() -> bool:
    """WSL needs the Windows side to wake the distro; native Linux does not."""
    return "microsoft" in platform.release().lower()


def _browser() -> str | None:
    if not _wsl():
        return next(filter(None, map(shutil.which, _LINUX_BROWSERS)), None)
    return next((p for p in _BROWSERS if os.path.exists(p)), None)


def _profile(browser: str, port: int) -> str | None:
    """Which browser profile to open the dashboard in, or None to let it choose.

    Without --profile-directory Chrome opens whichever profile it last felt like,
    so on a machine with four of them the login window is a coin flip. The tell is
    the dashboard's own origin in a profile's Preferences; newest-written profile
    wins, and last_used stands in when nothing has visited the dashboard yet."""
    if browser.startswith("/mnt/"):
        d = _startup_dir()
        if not d:
            return None
        vendor = "Microsoft/Edge" if "msedge" in browser else "Google/Chrome"
        root = f"{d.split('/AppData/', 1)[0]}/AppData/Local/{vendor}/User Data"
    else:
        name = os.path.basename(browser)
        vendor = ("microsoft-edge" if "edge" in name else
                  "chromium" if "chromium" in name else "google-chrome")
        root = os.path.expanduser(f"~/.config/{vendor}")
    for prefs in sorted(glob.glob(os.path.join(root, "*", "Preferences")),
                        key=os.path.getmtime, reverse=True):
        try:
            with open(prefs, encoding="utf-8", errors="replace") as f:
                if f"localhost:{port}" in f.read():
                    return os.path.basename(os.path.dirname(prefs))
        except OSError:
            continue
    try:
        with open(os.path.join(root, "Local State"), encoding="utf-8",
                  errors="replace") as f:
            return json.load(f)["profile"].get("last_used")
    except (OSError, ValueError, KeyError):
        return None


def _distro() -> str:
    return os.environ.get("WSL_DISTRO_NAME") or "Ubuntu"


def _systemctl(*args: str) -> subprocess.CompletedProcess:
    # A bridge launched from a bare context (cron, a stripped service) can be
    # missing these; systemctl --user then cannot find the bus at all.
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    return subprocess.run(["systemctl", "--user", *args], env=env,
                          capture_output=True, text=True, timeout=20)


def _has_systemd() -> bool:
    return bool(shutil.which("systemctl")) and os.path.isdir("/run/systemd/system")


# --- the two artefacts --------------------------------------------------------
def _unit_text() -> str:
    """The unit, with PATH pinned. A user unit inherits a minimal PATH that finds
    neither `claude` nor node's MCP servers, and the pyenv shims have to stay OUT
    or python3 stops resolving to the system interpreter the bridge runs on."""
    parts = [os.path.dirname(p) for p in
             (shutil.which("claude"), shutil.which("node")) if p]
    parts += ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin",
              "/sbin", "/bin", "/usr/lib/wsl/lib"]
    path, seen = [], set()
    for p in parts:
        if p not in seen and "/.pyenv/shims" not in p:
            seen.add(p)
            path.append(p)
    return f"""[Unit]
Description=mystical//assistant bridge (Telegram + dashboard)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={_REPO}
Environment=PATH={":".join(path)}
ExecStart={_REPO}/run.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"""


def _script(open_window: bool) -> str:
    from bridge import config
    port = config.DASH_PORT
    distro, user = _distro(), getpass.getuser()
    lines = [
        "@echo off",
        "REM mystical//assistant - written by the dashboard's SYSTEM tab. Toggle it",
        "REM there rather than editing here; this file is rewritten on every change.",
        "REM Booting the WSL distro is the whole trick: systemd + linger bring the",
        "REM bridge up on their own once Windows touches the distro. Then wait for",
        "REM the port to actually answer, because WSL boot plus bridge start takes",
        "REM several seconds and a blind sleep races it.",
        "",
        f'wsl.exe -d {distro} -u {user} -e bash -c "for i in $(seq 1 60); do '
        f'curl -sf -o /dev/null http://127.0.0.1:{port}/ && exit 0; sleep 1; done; exit 1"',
        "",
        "if errorlevel 1 (",
        f"  echo mystical//assistant did not answer on :{port} within 60s.",
        f"  echo Check it with:  wsl -d {distro} -- systemctl --user status {UNIT}",
        "  pause",
        "  exit /b 1",
        ")",
    ]
    browser = _browser()
    if open_window and browser:
        prof = _profile(browser, port)
        pick = f' --profile-directory="{prof}"' if prof else ""
        lines += ["", f'start "" "{_win_path(browser)}"{pick} '
                      f'--app=http://localhost:{port}/']
    # CRLF: a .cmd with bare LFs breaks cmd.exe's parsing of multi-line if blocks.
    return "\r\n".join(lines) + "\r\n"


def _desktop() -> str:
    """The autostart entry for a Linux desktop. No distro to boot here — the unit
    already started at boot under linger — so this is only the window."""
    from bridge import config
    port, browser = config.DASH_PORT, _browser()
    prof = _profile(browser, port)
    pick = f" '--profile-directory={prof}'" if prof else ""
    # Quoting: the Desktop Entry spec only makes ", `, $ and \ special inside a
    # quoted Exec, so a $-free shell line needs no escaping at all.
    # ponytail: the wait is unbounded — one sh and a curl a second if the bridge
    # never answers. Bound it if that ever turns up in a process list.
    return ("[Desktop Entry]\n"
            "Type=Application\n"
            "Name=mystical//assistant\n"
            "Comment=Opens the dashboard once the bridge answers\n"
            f'Exec=sh -c "until curl -sf -o /dev/null http://127.0.0.1:{port}/; '
            f'do sleep 1; done; exec {browser}{pick} --app=http://localhost:{port}/"\n'
            "X-GNOME-Autostart-enabled=true\n")


# --- public API ---------------------------------------------------------------
def state() -> dict:
    """Never raises — the UI needs something to render on every host."""
    if not _has_systemd():
        return {"supported": False, "reason": "no systemd on this machine",
                "login": False, "window": False, "supervised": False, "browser": None}
    browser = _browser()
    base = {
        "supported": True,
        "reason": None,
        # Is the bridge running under the unit *right now*? A `mystical restart`
        # from before the launcher learned about systemd leaves this false.
        "supervised": _systemctl("is-active", UNIT).stdout.strip() == "active",
        "browser": os.path.basename(browser) if browser else None,
    }
    enabled = _systemctl("is-enabled", UNIT).stdout.strip() == "enabled"
    if not _wsl():
        # Nothing to wake: the unit starts at boot and the window comes from
        # ~/.config/autostart, both of them ours.
        return {**base, "login": enabled, "window": os.path.isfile(_AUTOSTART)}
    d = _startup_dir()
    if not d:
        return {**base, "supported": False, "login": False, "window": False,
                "browser": None,
                "reason": "no single Windows Startup folder found (several profiles?)"}
    text = ""
    try:
        with open(os.path.join(d, CMD_NAME), encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        pass
    # Both halves have to be in place; if they drift apart the switch reads
    # off, and turning it on writes both back.
    return {**base, "login": bool(text) and enabled, "window": "--app=" in text}


def apply(login: bool, window: bool) -> dict:
    """Write or remove both artefacts. Raises RuntimeError with something worth
    showing the user; the caller turns that into a 400."""
    st = state()
    if not st["supported"]:
        raise RuntimeError(st["reason"] or "not supported on this machine")
    cmd = os.path.join(_startup_dir(), CMD_NAME) if _wsl() else None
    if login:
        os.makedirs(_UNIT_DIR, exist_ok=True)
        unit = os.path.join(_UNIT_DIR, UNIT)
        text = _unit_text()
        # Only rewrite when it differs, so a hand-tuned unit survives a window toggle.
        if not os.path.isfile(unit) or open(unit, encoding="utf-8").read() != text:
            with open(unit, "w", encoding="utf-8") as f:
                f.write(text)
            _systemctl("daemon-reload")
        r = _systemctl("enable", UNIT)
        if r.returncode:
            raise RuntimeError((r.stderr or r.stdout).strip() or "systemctl enable failed")
        # Linger, or the unit only starts once something logs in interactively.
        subprocess.run(["loginctl", "enable-linger", getpass.getuser()],
                       capture_output=True, text=True, timeout=20)
        if cmd:
            with open(cmd, "w", encoding="utf-8", newline="") as f:
                f.write(_script(window))
        elif window and _browser():
            os.makedirs(os.path.dirname(_AUTOSTART), exist_ok=True)
            with open(_AUTOSTART, "w", encoding="utf-8") as f:
                f.write(_desktop())
        elif os.path.isfile(_AUTOSTART):
            os.remove(_AUTOSTART)
    else:
        r = _systemctl("disable", UNIT)
        if r.returncode:
            raise RuntimeError((r.stderr or r.stdout).strip() or "systemctl disable failed")
        # Deliberately NOT `systemctl stop`: whoever flicked this switch is almost
        # certainly talking to us through the bridge it would kill.
        for f in (cmd, None if cmd else _AUTOSTART):
            if f and os.path.isfile(f):
                os.remove(f)
    return state()
