"""The MODE pickers must not offer a posture the runtime would reject.

Claude's list is checked against the installed CLI's own `--permission-mode`
choices (skipped when `claude` isn't on this machine); opencode's is checked
against what `build_cmd` actually turns each mode into.
"""

import re
import subprocess

import pytest

from bridge import config, freeagent
from bridge.runner import claude_bin


def _cli_choices() -> "set[str] | None":
    try:
        out = subprocess.run([claude_bin(), "--help"], capture_output=True,
                             text=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"--permission-mode <mode>(.*?)\n\s*--", out, re.S)
    return set(re.findall(r'"([A-Za-z]+)"', m.group(1))) if m else None


def test_every_offered_mode_is_one_the_cli_takes():
    choices = _cli_choices()
    if not choices:
        pytest.skip("claude CLI not available to read --permission-mode from")
    # "manual" is the CLI's alias for "default"; we store the canonical one.
    choices.discard("manual")
    choices.add("default")
    assert config.MINIAPP_PERMISSION_MODES <= choices, (
        f"offered but not accepted: {config.MINIAPP_PERMISSION_MODES - choices}")


def test_a_free_agent_only_plans_or_runs_flat_out():
    prov = {"provider": "zen", "model": "big-pickle"}
    plan = freeagent.build_cmd("go", prov, None, "/tmp", "plan")
    assert plan[plan.index("--agent") + 1] == "plan"
    # Every other mode — including the asking ones nobody can answer headlessly
    # — is the auto-approving run the free rung has always been.
    for mode in (None, "bypassPermissions", "default", "dontAsk", "acceptEdits", "auto"):
        cmd = freeagent.build_cmd("go", prov, None, "/tmp", mode)
        assert "--auto" in cmd and "--agent" not in cmd, mode
    assert set(freeagent.FREE_MODES) <= config.MINIAPP_PERMISSION_MODES
