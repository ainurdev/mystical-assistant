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
# Hard-pin a canonical project root before config freezes it, so within_base()
# is deterministic suite-wide (config.BASE_PATH is read once, at first import).
# Tests that assert on containment should build fixtures under config.BASE_PATH.
os.environ["BASE_PATH"] = tempfile.mkdtemp()
