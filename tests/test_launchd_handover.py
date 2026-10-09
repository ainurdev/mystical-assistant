"""bin/mystical on a Mac with the LaunchAgent installed: start/stop/restart must
go through launchctl, because a plain kill of a KeepAlive job is relaunched and
a hand-launched copy beside the agent fights it for the dashboard port.

Runs the real script against a fake repo, HOME and PATH: `uname` says Darwin,
`launchctl` records its argv, `curl` answers so the port waits return at once."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
LABEL = "cloud.ainurhq.mystical.bridge"


def _exe(path: Path, body: str):
    path.write_text("#!/bin/bash\n" + body)
    path.chmod(0o755)


@pytest.fixture
def mac(tmp_path):
    repo = tmp_path / "repo"
    (repo / "bin").mkdir(parents=True)
    shutil.copy(ROOT / "bin" / "mystical", repo / "bin" / "mystical")
    (repo / ".env").write_text('DASH_PORT="8790"\n')
    home = tmp_path / "home"
    (home / "Library" / "LaunchAgents").mkdir(parents=True)
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    log = tmp_path / "launchctl.log"
    loaded = tmp_path / "loaded"     # exists = agent loaded; content = its pid
    _exe(fakebin / "uname", 'echo Darwin\n')
    _exe(fakebin / "curl", 'exit 0\n')
    _exe(fakebin / "launchctl", f'''echo "$*" >> "{log}"
case "$1" in
  print) [ -f "{loaded}" ] || exit 113
         pid="$(cat "{loaded}")"; echo "{LABEL} = {{"; [ -n "$pid" ] && printf '\\tpid = %s\\n' "$pid"; echo "}}" ;;
  print-disabled) echo "disabled services = {{"; echo "}}" ;;
  bootout) rm -f "{loaded}" ;;
esac
exit 0
''')

    def run(*args):
        env = {**os.environ, "HOME": str(home),
               "PATH": f"{fakebin}:/usr/bin:/bin:/usr/sbin:/sbin",
               "BRIDGE_STATE_DIR": str(tmp_path / "state")}
        env.pop("BRIDGE_DB", None)
        p = subprocess.run([str(repo / "bin" / "mystical"), *args],
                           capture_output=True, text=True, env=env, timeout=60)
        calls = log.read_text().splitlines() if log.exists() else []
        return p, calls

    def install(pid=None):
        (home / "Library" / "LaunchAgents" / f"{LABEL}.plist").write_text("<plist/>")
        if pid is not None:
            loaded.write_text(str(pid))

    return {"run": run, "install": install, "repo": repo}


def test_start_bootstraps_the_installed_agent(mac):
    mac["install"]()
    (mac["repo"] / "bridge" / "dashboard" / "web" / "dist").mkdir(parents=True)
    p, calls = mac["run"]("start")
    assert any(c.startswith("bootstrap gui/") and c.endswith(f"{LABEL}.plist") for c in calls), (calls, p.stdout, p.stderr)


def test_stop_boots_the_agent_out_instead_of_signalling(mac):
    mac["install"](pid="")          # loaded, no live pid to wait on
    p, calls = mac["run"]("stop")
    assert p.returncode == 0, p.stderr
    assert any(c.startswith("bootout gui/") and c.endswith(LABEL) for c in calls), calls
    assert "Stopped" in p.stdout


def test_restart_asks_launchd_to_kill_and_relaunch(mac):
    """kickstart -k: launchd does the restart, so it lands even when the caller
    is a session inside the bridge that dies with it."""
    mac["install"](pid=os.getpid())
    p, calls = mac["run"]("restart")
    assert any(c.startswith("kickstart -k gui/") for c in calls), (calls, p.stderr)
    assert not any(c.startswith("bootout") for c in calls), calls


def test_no_agent_means_no_launchctl_writes(mac):
    p, calls = mac["run"]("stop")
    assert "Not running" in p.stdout
    assert not [c for c in calls if c.split()[0] in ("bootout", "bootstrap", "kickstart")], calls
