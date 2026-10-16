"""Set up and Remove for Share this device: one macOS admin-password prompt runs
bridge/device_setup/setup.sh or remove.sh as root.

The prompt is osascript's `do shell script … with administrator privileges`,
the standard one, so nothing here holds or sees the password. The scripts own
every step (setup.sh says what each one does and why). This side only quotes the
command twice, once for the shell and once as an AppleScript string, and reads
the script's last stdout line, its JSON result. `do shell script` hands output
back with \\r line endings, which splitlines() reads as well. A cancelled prompt
is osascript's error -128.
"""

import getpass
import json
import os
import shlex
import subprocess

_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "device_setup")
_SCRIPTS = {"setup": "setup.sh", "remove": "remove.sh"}


def _applescript(s):
    """`s` as an AppleScript string literal, whose escapes are a backslash and a quote."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def run(action, owner=getpass.getuser(), run=subprocess.run):
    """Set up ("setup") or Remove ("remove") this device for `owner`, the account
    that shares it. Returns the script's {"ok", "checks", "error"}, or
    {"ok": False, "error": "Cancelled."} when the password prompt is cancelled."""
    shell = " ".join(shlex.quote(a) for a in ("/bin/bash", os.path.join(_DIR, _SCRIPTS[action]), owner))
    try:
        r = run(["osascript", "-e", "do shell script %s with administrator privileges" % _applescript(shell)],
                capture_output=True, encoding="utf-8", errors="replace", timeout=900)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "It took longer than 15 minutes."}
    if r.returncode == 1 and "-128" in r.stderr:
        return {"ok": False, "error": "Cancelled."}
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        return {"ok": False, "error": (r.stderr.strip().splitlines() or ["It stopped without an answer."])[-1]}
