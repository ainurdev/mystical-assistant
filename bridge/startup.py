"""Does the bridge come up at login, and does the dashboard window come up with it?

Two host-side pieces, neither of them in this repo — which is exactly why they need
a switch that can also *report* on them:

  1. a systemd **user unit** that runs run.sh, enabled + lingering, and
  2. a **.cmd in the Windows Startup folder**.

Under WSL the second is what makes the first fire at all: nothing on the Linux side
runs until Windows touches the distro, so the .cmd's real job is booting it. Opening
the dashboard window afterwards is the optional half.

Everything here is best-effort and reversible, and `state()` never raises — a machine
with no /mnt/c, several Windows profiles, or no systemd just reports
`supported: False` with a reason, and the UI hides the switches.
"""
from __future__ import annotations

import getpass
import glob
import os
import shutil
import subprocess

UNIT = "mystical-assistant.service"
CMD_NAME = "mystical-assistant.cmd"
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


def _browser() -> str | None:
    return next((p for p in _BROWSERS if os.path.exists(p)), None)


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
        lines += ["", f'start "" "{_win_path(browser)}" --app=http://localhost:{port}/']
    # CRLF: a .cmd with bare LFs breaks cmd.exe's parsing of multi-line if blocks.
    return "\r\n".join(lines) + "\r\n"


# --- public API ---------------------------------------------------------------
def state() -> dict:
    """Never raises — the UI needs something to render on every host."""
    if not _has_systemd():
        return {"supported": False, "reason": "no systemd on this machine",
                "login": False, "window": False, "supervised": False, "browser": None}
    d = _startup_dir()
    if not d:
        return {"supported": False,
                "reason": "no single Windows Startup folder found (not WSL, or several profiles)",
                "login": False, "window": False,
                "supervised": _systemctl("is-active", UNIT).stdout.strip() == "active",
                "browser": None}
    cmd = os.path.join(d, CMD_NAME)
    text = ""
    if os.path.isfile(cmd):
        try:
            with open(cmd, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            text = ""
    enabled = _systemctl("is-enabled", UNIT).stdout.strip() == "enabled"
    browser = _browser()
    return {
        "supported": True,
        "reason": None,
        # Both halves have to be in place; if they drift apart the switch reads
        # off, and turning it on writes both back.
        "login": bool(text) and enabled,
        "window": "--app=" in text,
        # Is the bridge running under the unit *right now*? A `mystical restart`
        # from before the launcher learned about systemd leaves this false.
        "supervised": _systemctl("is-active", UNIT).stdout.strip() == "active",
        "browser": os.path.basename(browser) if browser else None,
    }


def apply(login: bool, window: bool) -> dict:
    """Write or remove both artefacts. Raises RuntimeError with something worth
    showing the user; the caller turns that into a 400."""
    st = state()
    if not st["supported"]:
        raise RuntimeError(st["reason"] or "not supported on this machine")
    cmd = os.path.join(_startup_dir(), CMD_NAME)
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
        with open(cmd, "w", encoding="utf-8", newline="") as f:
            f.write(_script(window))
    else:
        r = _systemctl("disable", UNIT)
        if r.returncode:
            raise RuntimeError((r.stderr or r.stdout).strip() or "systemctl disable failed")
        # Deliberately NOT `systemctl stop`: whoever flicked this switch is almost
        # certainly talking to us through the bridge it would kill.
        if os.path.isfile(cmd):
            os.remove(cmd)
    return state()
