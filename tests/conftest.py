"""Test-suite fixtures + environment isolation.

CRITICAL: bridge/config.py reads every setting from os.environ AT IMPORT TIME and
freezes it into module constants. So the test environment must be pinned HERE —
in conftest, which pytest imports before any test module (and therefore before
the first `import bridge.config`) — not in each test file's preamble, where a
value leaking from the developer's shell (they run the bridge from it) would win
and, worse, point tests at the real ~/.bridge_state DB and the real chat-id
allow-list. We hard-assign (not setdefault) so a shell value can never leak in.
"""

import os
import sys
import tempfile

# The bridge package lives at the repo root (parent of tests/); put it on the
# path once so every test module imports `bridge` without its own sys.path hack.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Pin the security-relevant env before bridge.config is imported anywhere.
os.environ["TELEGRAM_BOT_TOKEN"] = "12345:TESTTOKEN"
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["DASH_TOKEN"] = "test-dash-token"     # non-empty → the CSRF gate is ON
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "bridge-test.db")
# The MCP allowlist seeds default_disabled_tools(); the bridge exports .env into
# the shells it hosts, so an unpinned value flips that default under the very
# sessions that run this suite (tests patch config.MCP_SERVERS when they want one).
os.environ["MCP_SERVERS"] = ""
# Hard-pin a canonical project root before config freezes it, so within_base()
# is deterministic suite-wide (config.BASE_PATH is read once, at first import).
# Tests that assert on containment should build fixtures under config.BASE_PATH.
os.environ["BASE_PATH"] = tempfile.mkdtemp()
# Same freeze-at-import rule for the two files that hold real credentials: a
# test module importing bridge.accounts / bridge.freeagent before its own
# preamble runs would otherwise write account profiles and provider API keys
# into the developer's actual ~/.mystical.
os.environ["ACCOUNTS_DIR"] = os.path.join(tempfile.mkdtemp(), "accounts")
os.environ["FREEAGENTS_FILE"] = os.path.join(tempfile.mkdtemp(), "freeagents.json")

# Claude Code's live-session registry is a path frozen at import in bridge.machine,
# with no env knob. native.scan() now indexes what that registry lists, so leave it
# pointed at the developer's real ~/.claude/sessions and the suite would index the
# very sessions running it. Empty temp dir; a test that wants rows writes them there.
from bridge import machine  # noqa: E402
machine.SESSIONS_DIR = tempfile.mkdtemp()

# Same story for ~/.claude.json: toolsets merges other projects' local-scope MCP
# servers straight from it, and the path is frozen at import with no env knob.
# Point it at a file that doesn't exist so the suite never reads the real one.
from bridge import toolsets  # noqa: E402
toolsets.CLAUDE_JSON = os.path.join(tempfile.mkdtemp(), "claude.json")
