"""What this device is, and whether it is ready to take a teammate's device run.

A Mac whose owner turned on Share this device says so in the websocket handshake
(Worker._connect in bridge/rivendell.py): `X-Mystical-Features: device-runs` and
`X-Mystical-Device`, the facts below as base64url JSON. It says so only when it is
READY, so Rivendell never routes a run to a device that cannot take it.

The facts come from a handful of system binaries; `run=` is the seam the tests
use. A missing, slow or failing binary is a missing fact, never an exception: a
device hiccup must not keep the Rivendell link down.
"""

import base64
import hashlib
import json
import os
import platform
import re
import subprocess
import threading
import time

from bridge import config

RUN_USER = "mysticalruns"
HELPER = "/usr/local/libexec/mystical-run-helper"
RUNS_CONFIG = "/usr/local/etc/mystical-runs.json"
XCODE_DEV = "/Applications/Xcode.app/Contents/Developer"

_TIMEOUT = 10        # seconds, per binary
_TTL = 300           # seconds the facts are trusted
_lock = threading.Lock()
_cached = {"at": 0.0, "facts": None}


# ---------------------------------------------------------------------------
# Parsers — pure, each fed what one binary printed (None when it printed nothing)
# ---------------------------------------------------------------------------

def parse_text(out):
    """A one-line fact (sw_vers, pod, scutil): the output, stripped."""
    return (out or "").strip() or None


def parse_xcode(out):
    """`xcodebuild -version`: "Xcode 27.0" on the first line -> "27.0"."""
    m = re.match(r"Xcode (\S+)", out or "")
    return m.group(1) if m else None


def _vkey(version):
    return [int(p) if p.isdigit() else 0 for p in version.split(".")]


def parse_ios_runtimes(out):
    """`xcrun simctl list runtimes -j`: the installed iOS versions, newest first
    (Rivendell keeps the first ten)."""
    try:
        found = [r["version"] for r in json.loads(out or "")["runtimes"]
                 if r.get("platform") == "iOS" and r.get("isAvailable")]
        return sorted(found, key=_vkey, reverse=True)
    except Exception:  # noqa: BLE001 — whatever simctl printed, "none" is the answer
        return []


def parse_node(out):
    """`node -v`: "v26.11.0" -> the major, "26"."""
    m = re.match(r"v?(\d+)", (out or "").strip())
    return m.group(1) if m else None


def parse_chip(out):
    """`sysctl -n machdep.cpu.brand_string`: "Apple M5 Pro" -> "M5 Pro". An Intel
    Mac keeps its whole brand string."""
    return (parse_text(out) or "").removeprefix("Apple ") or None


def parse_uuid(out):
    """`ioreg -rd1 -c IOPlatformExpertDevice`: the IOPlatformUUID value."""
    m = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', out or "")
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------

def _out(run, cmd, env=None):
    """One probe's stdout, or None when the binary is missing, slow or fails."""
    try:
        r = run(cmd, capture_output=True, encoding="utf-8", errors="replace",
                timeout=_TIMEOUT, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def developer_dir(run=subprocess.run):
    """The Xcode to run tools under (DEVELOPER_DIR), or None without one.
    `xcode-select -p` often points at the Command Line Tools while Xcode.app is
    installed, and the Tools have no simulator. shortcut: only Xcode.app is
    looked for, not renamed copies; upgrade if people keep Xcode elsewhere."""
    active = (_out(run, ["xcode-select", "-p"]) or "").strip()
    if active and not active.endswith("CommandLineTools"):
        return active
    return XCODE_DEV if os.path.isdir(XCODE_DEV) else None


def _probe(run):
    # shortcut: the probes run one after another (about 2 s cold); thread them
    # if the first connect's delay ever matters.
    dev = developer_dir(run)
    env = {**os.environ, "DEVELOPER_DIR": dev} if dev else None

    def out(*cmd):
        return _out(run, list(cmd), env)

    uuid = parse_uuid(out("ioreg", "-rd1", "-c", "IOPlatformExpertDevice"))
    return {
        "id": hashlib.sha256(uuid.encode()).hexdigest()[:16] if uuid else None,
        "name": parse_text(out("scutil", "--get", "ComputerName")) or platform.node() or None,
        "os": "macOS",
        "osVersion": parse_text(out("sw_vers", "-productVersion")),
        "chip": parse_chip(out("sysctl", "-n", "machdep.cpu.brand_string")),
        # Without Xcode these two are the shims that pop up "install the command
        # line tools", so they are not started blind.
        "xcode": parse_xcode(out("xcodebuild", "-version")) if dev else None,
        "iosRuntimes": parse_ios_runtimes(out("xcrun", "simctl", "list", "runtimes", "-j")) if dev else [],
        "node": parse_node(out("node", "-v")),
        "pods": parse_text(out("pod", "--version")),
    }


def device_facts(run=subprocess.run):
    """What this device is: {id, name, os, osVersion, chip, xcode, iosRuntimes,
    node, pods}, or None off macOS. Cached for 300 s (probing takes seconds);
    refresh() drops the cache. The id is stable: the first 16 hex of the sha256 of
    the platform UUID."""
    if platform.system() != "Darwin":
        return None
    with _lock:
        if _cached["facts"] is None or time.monotonic() - _cached["at"] >= _TTL:
            _cached.update(facts=_probe(run), at=time.monotonic())
        return _cached["facts"]


def refresh():
    """Forget the cached facts: after Set up or Remove, or an Xcode install."""
    with _lock:
        _cached["facts"] = None


def wall_ports():
    """This bridge's own ports, which Set up walls the hidden user off: the
    dashboard, the Mini App and the landing page (setup.sh's pf rule)."""
    return sorted({config.DASH_PORT, config.MINIAPP_PORT, config.LANDING_PORT})


def setup_state(exists=os.path.exists, run=subprocess.run):
    """What Set up leaves behind: the hidden user, the root helper, Claude Code
    installed for that user, and the wall. Claude is the `claude` path Set up
    records in its root-owned config once the binary is there; the wall holds
    for the ports it records as `walled`, which must be this bridge's ports now.
    The hidden home stays closed to this account, so nothing is looked up inside
    it."""
    try:
        with open(RUNS_CONFIG, encoding="utf-8") as f:
            cfg = json.load(f)
        claude, walled = cfg.get("claude"), cfg.get("walled")
    except (OSError, ValueError, AttributeError):
        claude = walled = None
    return {
        "user": _out(run, ["dscl", ".", "-read", "/Users/" + RUN_USER]) is not None,
        "helper": exists(HELPER),
        "claude": isinstance(claude, str) and claude != "",
        "wall": walled == wall_ports(),
    }


# ---------------------------------------------------------------------------
# State and handshake
# ---------------------------------------------------------------------------

def _check(key, ok, *words):
    """One mark in the panel's checks line; a word that is missing (the version of
    something not installed) drops out of the label."""
    return {"key": key, "label": " ".join(w for w in words if w), "ok": bool(ok)}


def share_state(inst, run=subprocess.run):
    """Where this device stands for one instance: {state, checks, facts, installed}.

    NOT_MAC (not macOS) > OFF (Share this device is off) > XCODE_MISSING (no
    Xcode, or no iOS runtime) > NEEDS_SETUP (the hidden user, helper or Claude
    is missing, or the wall isn't on the bridge's ports now) > READY. Node and
    CocoaPods show in the checks but hold nothing back. `installed` is whether
    anything of Set up's is here, whatever the state: what REMOVE is offered on.
    """
    facts = device_facts(run)
    if facts is None:
        return {"state": "NOT_MAC", "checks": [], "facts": None, "installed": False}
    setup = setup_state(run=run)
    user = setup["user"] and setup["helper"] and setup["claude"]
    ios = facts["iosRuntimes"]
    checks = [
        _check("macos", facts["osVersion"], "MACOS", facts["osVersion"]),
        _check("xcode", facts["xcode"], "XCODE", facts["xcode"]),
        _check("ios", ios, "IOS", ios and ios[0], "SIMULATOR"),
        _check("node", facts["node"], "NODE", facts["node"]),
        _check("pods", facts["pods"], "COCOAPODS", facts["pods"]),
        _check("user", user, "USER MYSTICALRUNS"),
        _check("wall", setup["wall"], "WALL"),
    ]
    if not inst.get("share_device", True):
        state = "OFF"
    elif not facts["xcode"] or not ios:
        state = "XCODE_MISSING"
    elif not all(setup.values()):
        state = "NEEDS_SETUP"
    else:
        state = "READY"
    return {"state": state, "checks": checks, "facts": facts, "installed": any(setup.values())}


def _last_run_path():
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "device_last_run.json")


def record_last_run(by: str, task: "str | None") -> None:
    """Note the run this device just ran, {at, by, task}, for the settings'
    STATE row (device_side.run calls it once the result is posted). Beside the
    DB, 0600. Best-effort: a note that can't be written never fails a run."""
    path = _last_run_path()
    try:
        with os.fdopen(os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600),
                       "w", encoding="utf-8") as f:
            os.fchmod(f.fileno(), 0o600)    # a leftover temp file keeps its own mode through O_CREAT
            json.dump({"at": time.time(), "by": by, "task": task}, f)
        os.replace(path + ".tmp", path)
    except OSError as e:
        print(f"device runs: the last run couldn't be noted: {e}")


def last_run() -> "dict | None":
    """The newest run this device ran, {at, by, task}, or None before the first."""
    try:
        with open(_last_run_path(), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) else None


def handshake_headers(inst, run=subprocess.run):
    """The two header lines a READY device adds to the websocket upgrade; none
    otherwise. The device header is URL-safe base64 without padding, which is
    what Node's Buffer.from(raw, 'base64url') reads."""
    if not inst.get("share_device", True):
        return []   # the owner opted out: no probe at all
    s = share_state(inst, run)
    if s["state"] != "READY" or not s["facts"]["id"]:
        return []   # Rivendell knows a device by its id; without one there is no device to offer
    raw = json.dumps(s["facts"], separators=(",", ":")).encode()
    return ["X-Mystical-Features: device-runs",
            "X-Mystical-Device: " + base64.urlsafe_b64encode(raw).decode().rstrip("=")]
