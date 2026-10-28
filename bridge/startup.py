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

On macOS both halves are **launchd LaunchAgents** in ~/Library/LaunchAgents: one
runs run.sh (the systemd unit's counterpart: up at login, restarted after a
crash), the other opens Mystical.app (macos/) — the window half. Same rules as
systemd: switching on never starts a second bridge beside a hand-launched one,
switching off never stops the one you are talking through.

The window half also starts the **tray companion** (windows/tray.ps1 under WSL,
linux/tray.py on a Linux desktop): Mystical.app's menu bar for these systems.
It runs from this checkout with what the OS ships, so there is nothing to
install; launch_tray() is `mystical app` for not waiting until the next login.

Under WSL, once `mystical app` has built **Mystical.exe** (windows/), the exe is
the window and the tray in one: the .cmd starts it instead of the browser
window and tray.ps1, launch_tray() opens it, and refresh_launcher() rewrites
the .cmd right after the install, so nobody has to toggle a switch to stop
getting two trays at the next login.
"""
from __future__ import annotations

import getpass
import glob
import json
import os
import platform
import plistlib
import re
import shutil
import subprocess

UNIT = "mystical-assistant.service"
CMD_NAME = "mystical-assistant.cmd"
# The native-Linux counterpart of the .cmd's second half: every desktop honours
# ~/.config/autostart, whereas systemd's graphical-session.target only exists on
# the desktops that bothered to wire it up.
_AUTOSTART = os.path.expanduser("~/.config/autostart/mystical-assistant.desktop")
# The tray's own entry beside the window's, so the desktop's startup-apps list
# shows, and can switch off, each one on its own.
_TRAY_AUTOSTART = os.path.expanduser("~/.config/autostart/mystical-tray.desktop")
# The app-launcher entry: the same window as _AUTOSTART's, on demand. Its file
# name is the window's app_id (_launcher_id), not this; this is the old name,
# removed on install so the menu doesn't list Mystical twice.
_APPS_DIR = os.path.expanduser("~/.local/share/applications")
_OLD_LAUNCHER = "mystical-assistant.desktop"
# Windows exes aren't on a WSL PATH; this one is on every Windows 10/11.
_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
_UNIT_DIR = os.path.expanduser("~/.config/systemd/user")
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# macOS: launchd agents. Labels are reverse-DNS of the project's domain; bin/mystical
# and macos/ name the same two, so a change here is a change there.
BRIDGE_LABEL = "cloud.ainurhq.mystical.bridge"
APP_LABEL = "cloud.ainurhq.mystical.app"
_AGENT_DIR = os.path.expanduser("~/Library/LaunchAgents")
_MAC_APP = os.path.expanduser("~/Applications/Mystical.app")

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


def _win_app() -> str | None:
    """Mystical.exe, once `mystical app` has installed it (windows/build.sh puts
    it under the one Windows profile's %LOCALAPPDATA%\\Programs\\Mystical)."""
    d = _startup_dir()
    if not d:
        return None
    exe = d.split("/AppData/", 1)[0] + "/AppData/Local/Programs/Mystical/Mystical.exe"
    return exe if os.path.isfile(exe) else None


def _browser() -> str | None:
    if not _wsl():
        return next(filter(None, map(shutil.which, _LINUX_BROWSERS)), None)
    return next((p for p in _BROWSERS if os.path.exists(p)), None)


def _chrome_root(browser: str) -> str | None:
    """The browser's User Data dir — where profiles and Local State live."""
    if browser.startswith("/mnt/"):
        d = _startup_dir()
        if not d:
            return None
        vendor = "Microsoft/Edge" if "msedge" in browser else "Google/Chrome"
        return f"{d.split('/AppData/', 1)[0]}/AppData/Local/{vendor}/User Data"
    name = os.path.basename(browser)
    vendor = ("microsoft-edge" if "edge" in name else
              "chromium" if "chromium" in name else "google-chrome")
    return os.path.expanduser(f"~/.config/{vendor}")


def _profile(browser: str, port: int) -> str | None:
    """Which browser profile to open the dashboard in, or None to let it choose.

    Without --profile-directory Chrome opens whichever profile it last felt like,
    so on a machine with four of them the login window is a coin flip. The tell is
    the dashboard's own origin in a profile's Preferences; newest-written profile
    wins, and last_used stands in when nothing has visited the dashboard yet."""
    root = _chrome_root(browser)
    if not root:
        return None
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


def _profiles(browser: str) -> list[dict]:
    """Every profile the browser knows, with its human name — the selector's list."""
    root = _chrome_root(browser)
    if not root:
        return []
    try:
        with open(os.path.join(root, "Local State"), encoding="utf-8",
                  errors="replace") as f:
            cache = json.load(f)["profile"]["info_cache"]
    except (OSError, ValueError, KeyError, TypeError):
        return []
    return [{"dir": d, "name": v.get("name") or d}
            for d, v in sorted(cache.items()) if isinstance(v, dict)]


# The .cmd quotes the value, the .desktop entry quotes the whole argument —
# match either, so state() can read a choice back out of whichever launcher.
_PROFILE_RE = re.compile(r"--profile-directory=(?:\"([^\"]+)\"|([^']+)')")


def _written_profile(text: str) -> str | None:
    m = _PROFILE_RE.search(text)
    return (m.group(1) or m.group(2)) if m else None


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
def _pinned_path(exes, tail) -> list[str]:
    """The dirs holding `exes`, then `tail` — de-duplicated, pyenv shims out."""
    parts = [os.path.dirname(p) for p in map(shutil.which, exes) if p] + list(tail)
    path, seen = [], set()
    for p in parts:
        if p not in seen and "/.pyenv/shims" not in p:
            seen.add(p)
            path.append(p)
    return path


def _unit_text() -> str:
    """The unit, with PATH pinned. A user unit inherits a minimal PATH that finds
    neither `claude` nor node's MCP servers, and the pyenv shims have to stay OUT
    or python3 stops resolving to the system interpreter the bridge runs on.

    KillMode=mixed: a stop SIGTERMs the bridge alone, then SIGKILLs whatever is
    left in the cgroup once it has exited. The default (control-group) SIGTERMs
    every Claude child in the same instant as the bridge, so a child could die
    before the bridge knew it was stopping and its turn read as a crash; the
    bridge's _shutdown stops its streaming runs' children itself, after raising
    the flag, and the rest get the SIGKILL. It also ends the 90s waits on a
    leftover that ignores SIGTERM (twice in the 30 days to 2026-10-06, a
    `docker` CLI). TimeoutStopSec stays at the 90s default: a stop takes about a
    second, and stop_children gives its children 10s in all."""
    path = _pinned_path(("claude", "node"),
                        ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin",
                         "/sbin", "/bin", "/usr/lib/wsl/lib"])
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
KillMode=mixed

[Install]
WantedBy=default.target
"""


def _script(open_window: bool, profile: str | None = None) -> str:
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
        "REM several seconds and a blind sleep races it. Quarter-second polls, so",
        "REM the window opens the moment it answers (same 60s ceiling).",
        "",
        f'wsl.exe -d {distro} -u {user} -e bash -c "for i in $(seq 1 240); do '
        f'curl -sf -o /dev/null http://127.0.0.1:{port}/ && exit 0; sleep 0.25; done; exit 1"',
        'set "UP=%errorlevel%"',
    ]
    browser = _browser()
    app = _win_app() if open_window else None
    if app:
        lines += ["", "REM Mystical.exe (windows/) is the window and the tray in one; it has",
                  "REM its own placeholder, so it starts whether or not the bridge answered.",
                  f'start "" "{_win_path(app)}"']
    elif open_window:
        prof = (profile or _profile(browser, port)) if browser else None
        lines += ["", "REM The tray icon comes up whether or not the bridge did,",
                  "REM so a failed start still leaves you a tray with Start in it.",
                  'start "" powershell.exe '
                  + " ".join(map(_cmd_arg, _tray_argv(True, browser, prof)))]
    lines += [
        "",
        'if not "%UP%"=="0" (',
        f"  echo mystical//assistant did not answer on :{port} within 60s.",
        f"  echo Check it with:  wsl -d {distro} -- systemctl --user status {UNIT}",
        "  pause",
        "  exit /b 1",
        ")",
    ]
    if open_window and browser and not app:
        pick = f' --profile-directory="{prof}"' if prof else ""
        lines += ["", f'start "" "{_win_path(browser)}"{pick} '
                      f'--app=http://localhost:{port}/']
    # CRLF: a .cmd with bare LFs breaks cmd.exe's parsing of multi-line if blocks.
    return "\r\n".join(lines) + "\r\n"


def _desktop(profile: str | None = None) -> str:
    """The autostart entry for a Linux desktop. No distro to boot here — the unit
    already started at boot under linger — so this is only the window."""
    from bridge import config
    port, browser = config.DASH_PORT, _browser()
    prof = profile or _profile(browser, port)
    pick = f" '--profile-directory={prof}'" if prof else ""
    # Quoting: the Desktop Entry spec only makes ", `, $ and \ special inside a
    # quoted Exec, so a $-free shell line needs no escaping at all.
    # ponytail: the wait is unbounded — one sh and four curls a second if the
    # bridge never answers. Bound it if that ever turns up in a process list.
    return ("[Desktop Entry]\n"
            "Type=Application\n"
            "Name=mystical//assistant\n"
            "Comment=Opens the dashboard once the bridge answers\n"
            f'Exec=sh -c "until curl -sf -o /dev/null http://127.0.0.1:{port}/; '
            f'do sleep 0.25; done; exec {browser}{pick} --app=http://localhost:{port}/"\n'
            "X-GNOME-Autostart-enabled=true\n")


def _launcher_id(prof: str | None) -> str:
    """The Wayland app_id Chrome gives an --app=http://localhost:<port>/ window:
    chrome-<host>__-<profile dir, spaces as _>; the port isn't in it. Read off a
    live window through KWin (2026-10-28). Panels that map a window to its icon
    by desktop-file name (quickshell, GNOME) need the entry *named* this;
    StartupWMClass covers the ones that read that instead.
    ponytail: the format is Chrome's, undocumented. If the window loses its icon
    after a Chrome update, read the real app_id and match it here."""
    return f"chrome-localhost__-{(prof or 'Default').replace(' ', '_')}"


def _launcher_desktop(prof: str | None = None) -> str:
    """The app-launcher entry for a Linux desktop: the dashboard in a Chrome --app
    window, the lightest real browser window there is. Notifications, audio and
    storage are Chrome's own, and with Chrome already running it's one more
    window of that process, not a second browser the way Electron would be.

    It runs `linux/tray.py --open` rather than the browser itself: the dashboard
    wants ?token= in its URL, and the tray reads it from the manifest at launch,
    so a rotated DASH_TOKEN never leaves a stale entry behind. Same script, same
    window the tray's Open dashboard gives you; the bridge-down case is there."""
    from bridge import config
    port, browser = config.DASH_PORT, _browser()
    argv = ["/usr/bin/python3", os.path.join(_REPO, "linux", "tray.py"), "--open",
            "--port", str(port), "--browser", browser]
    argv += ["--profile", prof] if prof else []
    icon = os.path.join(_REPO, "bridge", "dashboard", "web", "public", "icon-512.png")
    return ("[Desktop Entry]\n"
            "Type=Application\n"
            "Name=Mystical\n"
            "GenericName=mystical//assistant dashboard\n"
            "Comment=The dashboard in its own window\n"
            f"Exec={' '.join(map(_exec_arg, argv))}\n"
            f"Icon={icon}\n"
            "Terminal=false\n"
            "Categories=Development;\n"
            f"StartupWMClass={_launcher_id(prof)}\n")


def _pwa_entry() -> str | None:
    """The launcher entry Chrome wrote when the dashboard was installed as an
    app (chrome-<app id>-<profile>.desktop, Exec with --app-id=), or None. That
    window is the better one — its own app id and icon, and the manifest's
    window-controls-overlay, which a plain --app window never gets."""
    for path in sorted(glob.glob(os.path.join(_APPS_DIR, "chrome-*.desktop"))):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        if "--app-id=" in text and re.search(r"^Name=mystical//assistant$", text, re.M):
            return path
    return None


def install_launcher() -> str:
    """Write the app-launcher entry (native Linux; `mystical app`). Returns its
    path; raises RuntimeError when there is no Chromium-family browser. Once
    Chrome has installed the dashboard as an app, that entry is the launcher:
    ours goes, so the menu doesn't offer two windows, and its path comes back."""
    if _wsl() or _darwin():
        raise RuntimeError("the launcher entry is for a native Linux desktop")
    if not _browser():
        raise RuntimeError("no Chrome/Chromium/Edge on PATH — the window is a browser --app window")
    from bridge import config
    prof = _profile(_browser(), config.DASH_PORT)
    path = os.path.join(_APPS_DIR, _launcher_id(prof) + ".desktop")
    pwa = _pwa_entry()
    if pwa:
        _remove(path, os.path.join(_APPS_DIR, _OLD_LAUNCHER))
        return pwa
    os.makedirs(_APPS_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(_launcher_desktop(prof))
    _remove(os.path.join(_APPS_DIR, _OLD_LAUNCHER))
    # Launchers watch this dir; the cache refresh is for the ones that don't.
    for tool in ("update-desktop-database", "kbuildsycoca6", "kbuildsycoca5"):
        if shutil.which(tool):
            args = [tool, _APPS_DIR] if tool.startswith("update") else [tool]
            subprocess.run(args, capture_output=True, timeout=60)
    return path


def _tray_ps1() -> str:
    """Where Windows finds windows/tray.ps1: the distro's \\\\wsl$ share, or the
    drive path when the checkout lives on /mnt/<drive>."""
    p = os.path.join(_REPO, "windows", "tray.ps1")
    return _win_path(p) if p.startswith("/mnt/") else f"\\\\wsl$\\{_distro()}" + p.replace("/", "\\")


def _tray_argv(windows: bool, browser: str | None, profile: str | None) -> list[str]:
    """The tray's command line, with the same port, browser and profile as the
    window line beside it. `windows`: powershell.exe's arguments for
    windows/tray.ps1. Otherwise: linux/tray.py on the system interpreter,
    where the distro's PyGObject lives."""
    from bridge import config
    port = str(config.DASH_PORT)
    if windows:
        argv = ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
                "-File", _tray_ps1(), "-Port", port, "-Distro", _distro(),
                "-User", getpass.getuser(), "-Repo", _REPO]
        argv += ["-Browser", _win_path(browser)] if browser else []
        return argv + (["-BrowserProfile", profile] if profile else [])
    argv = ["/usr/bin/python3", os.path.join(_REPO, "linux", "tray.py"), "--port", port]
    argv += ["--browser", browser] if browser else []
    return argv + (["--profile", profile] if profile else [])


def _cmd_arg(a: str) -> str:
    """One argument of a .cmd line, quoted when it has a space (cmd.exe and
    PowerShell's own parser both split there)."""
    return f'"{a}"' if " " in a or not a else a


def _exec_arg(a: str) -> str:
    # shortcut: quotes spaces only. A path holding " ` $ or \ needs the Desktop
    # Entry spec's double escaping; none of ours do. Escape them if one must.
    return f'"{a}"' if " " in a else a


def _tray_desktop(profile: str | None = None) -> str:
    """The autostart entry for linux/tray.py."""
    from bridge import config
    browser = _browser()
    prof = (profile or _profile(browser, config.DASH_PORT)) if browser else None
    return ("[Desktop Entry]\n"
            "Type=Application\n"
            "Name=mystical//assistant tray\n"
            "Comment=What's waiting on you, and alerts while the window is closed\n"
            f"Exec={' '.join(map(_exec_arg, _tray_argv(False, browser, prof)))}\n"
            "X-GNOME-Autostart-enabled=true\n")


def _remove(*paths: str) -> None:
    for p in paths:
        if os.path.isfile(p):
            os.remove(p)


def launch_tray() -> None:
    """Start the tray now, detached: `mystical app` on Linux and WSL, so it
    doesn't wait for the next login. Raises RuntimeError with a line worth
    showing when it can't start."""
    from bridge import config
    win, browser = _wsl(), _browser()
    # shortcut: the profile is the auto-guess, not a pin from the SYSTEM tab;
    # they agree unless the pinned profile never opened the dashboard.
    prof = _profile(browser, config.DASH_PORT) if browser else None
    argv = _tray_argv(win, browser, prof)
    if win:
        if not os.path.isfile(_POWERSHELL):
            raise RuntimeError(f"no Windows PowerShell at {_POWERSHELL}")
        app = _win_app()
        if app:
            # The exe is the tray. Start-Process, not cmd's `start`: run from
            # WSL, that one waits for its GUI child to exit.
            argv = [_POWERSHELL, "-NoProfile", "-Command", f"Start-Process -FilePath '{_win_path(app)}'"]
        else:
            argv = [_POWERSHELL, *argv]
        # A Windows working dir: run from a WSL path, Windows sees a UNC cwd.
        cwd = os.path.dirname(_POWERSHELL)
    else:
        try:
            check = subprocess.run([*argv[:2], "--check"], capture_output=True,
                                   text=True, timeout=30)
        except (OSError, subprocess.SubprocessError) as e:
            raise RuntimeError(f"can't run {argv[0]}: {e}") from e
        if check.returncode:
            raise RuntimeError(check.stderr.strip() or "the tray's GTK bindings are missing")
        cwd = None
    # A tray started from inside a bridge session lives in the bridge unit's
    # cgroup and goes down with its next restart; the login entry's doesn't.
    subprocess.Popen(argv, cwd=cwd, start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def refresh_launcher() -> bool:
    """Rewrite the Startup .cmd from the current state — after `mystical app`
    installs Mystical.exe, the window line changes from a browser window plus
    the tray to the exe — and nothing else: no `systemctl enable`, no linger.
    True when it was rewritten; False off WSL, or with login off."""
    if not _wsl():
        return False
    st = state()
    if not st["supported"] or not st["login"]:
        return False
    with open(os.path.join(_startup_dir(), CMD_NAME), "w", encoding="utf-8", newline="") as f:
        f.write(_script(st["window"], st["profile"]))
    return True


# --- macOS: launchd -----------------------------------------------------------
def _darwin() -> bool:
    return platform.system() == "Darwin"


def _launchctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["launchctl", *args], capture_output=True, text=True,
                          timeout=20)


def _agent(label: str) -> str:
    return os.path.join(_AGENT_DIR, f"{label}.plist")


def _bridge_plist() -> bytes:
    """The agent that runs the bridge, with PATH pinned for the same reason as the
    systemd unit — and one more: launchd's default PATH resolves python3 to the
    system 3.9, which the bridge refuses. So python3's own dir rides along with
    claude's and node's, ahead of Homebrew and the system dirs.

    KeepAlive only on an unsuccessful exit: a crash comes back after
    ThrottleInterval, a clean stop stays stopped. `mystical stop` boots the agent
    out instead of signalling it, so this never fights a deliberate stop."""
    path = _pinned_path(("claude", "node", "python3"),
                        ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
                         "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    log = os.path.join(os.environ.get("BRIDGE_STATE_DIR")
                       or os.path.expanduser("~/.bridge_state"), "mystical.log")
    return plistlib.dumps({
        "Label": BRIDGE_LABEL,
        "ProgramArguments": [os.path.join(_REPO, "run.sh")],
        "WorkingDirectory": _REPO,
        "EnvironmentVariables": {
            "PATH": ":".join(path),
            "LANG": os.environ.get("LANG") or "en_US.UTF-8",
            "PYTHONUNBUFFERED": "1",
        },
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 5,
        "StandardOutPath": log,
        "StandardErrorPath": log,
    })


def _app_plist() -> bytes:
    """The window half: open the app at login. The app waits for the bridge itself,
    so there is no curl loop here."""
    return plistlib.dumps({
        "Label": APP_LABEL,
        "ProgramArguments": ["/usr/bin/open", "-a", _MAC_APP],
        "RunAtLoad": True,
    })


def _disabled_labels() -> set[str]:
    out = _launchctl("print-disabled", f"gui/{os.getuid()}").stdout
    return set(re.findall(r'"([^"]+)" => (?:disabled|true)', out))


def _write_if_changed(path: str, data: bytes) -> None:
    # Only rewrite when it differs, so a hand-tuned agent survives a window toggle.
    try:
        with open(path, "rb") as f:
            if f.read() == data:
                return
    except OSError:
        pass
    with open(path, "wb") as f:
        f.write(data)


def _mac_state() -> dict:
    printed = _launchctl("print", f"gui/{os.getuid()}/{BRIDGE_LABEL}")
    login = (os.path.isfile(_agent(BRIDGE_LABEL))
             and BRIDGE_LABEL not in _disabled_labels())
    return {
        "supported": True,
        "reason": None,
        "login": login,
        "window": login and os.path.isfile(_agent(APP_LABEL)),
        # Loaded AND holding a pid: the bridge running now is the agent's own.
        "supervised": printed.returncode == 0
                      and bool(re.search(r"^\s*pid = \d+", printed.stdout, re.M)),
        "browser": "Mystical.app" if os.path.isdir(_MAC_APP) else None,
        "profiles": [],
        "profile": None,
    }


def _mac_apply(login: bool, window: bool) -> dict:
    uid = os.getuid()
    if login:
        if window and not os.path.isdir(_MAC_APP):
            raise RuntimeError("build the Mac app first: mystical app")
        os.makedirs(_AGENT_DIR, exist_ok=True)
        _write_if_changed(_agent(BRIDGE_LABEL), _bridge_plist())
        # enable, never bootstrap: a hand-launched bridge already holds the ports.
        # The agent takes over at next login, or at the next `mystical restart`.
        r = _launchctl("enable", f"gui/{uid}/{BRIDGE_LABEL}")
        if r.returncode:
            raise RuntimeError((r.stderr or r.stdout).strip() or "launchctl enable failed")
        if window:
            _write_if_changed(_agent(APP_LABEL), _app_plist())
            _launchctl("enable", f"gui/{uid}/{APP_LABEL}")
        elif os.path.isfile(_agent(APP_LABEL)):
            os.remove(_agent(APP_LABEL))
    else:
        r = _launchctl("disable", f"gui/{uid}/{BRIDGE_LABEL}")
        if r.returncode:
            raise RuntimeError((r.stderr or r.stdout).strip() or "launchctl disable failed")
        # Deliberately NOT bootout — same reason as systemd's missing `stop`.
        for label in (BRIDGE_LABEL, APP_LABEL):
            if os.path.isfile(_agent(label)):
                os.remove(_agent(label))
    return _mac_state()


# --- public API ---------------------------------------------------------------
def state() -> dict:
    """Never raises — the UI needs something to render on every host."""
    if _darwin():
        try:
            return _mac_state()
        except (OSError, subprocess.SubprocessError) as e:
            return {"supported": False, "reason": f"launchctl: {e}",
                    "login": False, "window": False, "supervised": False,
                    "browser": None, "profiles": [], "profile": None}
    if not _has_systemd():
        return {"supported": False, "reason": "no systemd on this machine",
                "login": False, "window": False, "supervised": False,
                "browser": None, "profiles": [], "profile": None}
    browser = _browser()
    base = {
        "supported": True,
        "reason": None,
        # Is the bridge running under the unit *right now*? A `mystical restart`
        # from before the launcher learned about systemd leaves this false.
        "supervised": _systemctl("is-active", UNIT).stdout.strip() == "active",
        "browser": os.path.basename(browser) if browser else None,
        # For the selector; the launcher's flag is the persisted choice.
        "profiles": _profiles(browser) if browser else [],
    }
    enabled = _systemctl("is-enabled", UNIT).stdout.strip() == "enabled"
    if not _wsl():
        # Nothing to wake: the unit starts at boot and the window comes from
        # ~/.config/autostart, both of them ours.
        text = ""
        try:
            with open(_AUTOSTART, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            pass
        return {**base, "login": enabled, "window": os.path.isfile(_AUTOSTART),
                "profile": _written_profile(text)}
    d = _startup_dir()
    if not d:
        return {**base, "supported": False, "login": False, "window": False,
                "browser": None, "profiles": [], "profile": None,
                "reason": "no single Windows Startup folder found (several profiles?)"}
    text = ""
    try:
        with open(os.path.join(d, CMD_NAME), encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        pass
    # Both halves have to be in place; if they drift apart the switch reads
    # off, and turning it on writes both back.
    return {**base, "login": bool(text) and enabled,
            "window": "--app=" in text or "Mystical.exe" in text,
            "browser": "Mystical.exe" if _win_app() else base["browser"],
            "profile": _written_profile(text)}


def apply(login: bool, window: bool, profile: str | None = None) -> dict:
    """Write or remove both artefacts. Raises RuntimeError with something worth
    showing the user; the caller turns that into a 400. `profile` pins the
    browser profile the window opens in; None keeps the auto-guess."""
    if _darwin():
        return _mac_apply(login, window)
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
                f.write(_script(window, profile))
        elif window and _browser():
            for path, text in ((_AUTOSTART, _desktop(profile)),
                               (_TRAY_AUTOSTART, _tray_desktop(profile))):
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
        else:
            _remove(_AUTOSTART, _TRAY_AUTOSTART)
    else:
        r = _systemctl("disable", UNIT)
        if r.returncode:
            raise RuntimeError((r.stderr or r.stdout).strip() or "systemctl disable failed")
        # Deliberately NOT `systemctl stop`: whoever flicked this switch is almost
        # certainly talking to us through the bridge it would kill.
        _remove(*((cmd,) if cmd else (_AUTOSTART, _TRAY_AUTOSTART)))
    return state()
