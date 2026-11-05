"""SKILL PATHS: Matt Pocock's skill pack, loaded into every run while the
`router` AI switch is on.

The pack is vendored under bridge/skills/mattpocock instead of installed as a
plugin: one switch turns it on, there is nothing to install per account, and
every account runs the same files. `claude --plugin-dir` loads it per run.

The flag is added inside runner._base_cmd, not passed as extra_args, because
resumed, queued and recovered runs lose extra_args and would drop the pack
mid-session. Checked by hand: when the plugin is also installed, the CLI logs
'from --plugin-dir overrides installed version' and runs one copy, so the
installed one needs no disabling.
"""

import os

from bridge import aifeatures

PACK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills", "mattpocock")
PLUGIN_ID = "mattpocock-skills@claude-plugins-official"


def on() -> bool:
    return aifeatures.enabled("router")
