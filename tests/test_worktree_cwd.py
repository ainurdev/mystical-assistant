"""server._worktree_cwd: resolve the working-tree dir for a project+branch — the
linked worktree when one exists on disk, else the project checkout. Run with pytest.
Operates inside the configured BASE_PATH (read at runtime) so it is robust to the
test-suite's BASE_PATH import race, and cleans up the dirs it makes."""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import config  # noqa: E402
from bridge.dashboard import server  # noqa: E402


def test_worktree_cwd_resolves_project_and_worktree():
    base = config.BASE_PATH
    proj_rel = "wtcwd_proj"
    proj = os.path.join(base, proj_rel)
    os.makedirs(proj, exist_ok=True)
    try:
        # no branch / no worktree yet → the project checkout
        assert server._worktree_cwd(proj_rel, "") == os.path.realpath(proj)
        assert server._worktree_cwd(proj_rel, "feature/x") == os.path.realpath(proj)
        # once the branch has a linked worktree on disk → that worktree
        wt = server._worktree_path(proj_rel, "feature/x")
        os.makedirs(wt, exist_ok=True)
        assert server._worktree_cwd(proj_rel, "feature/x") == os.path.realpath(wt)
        # an unknown project → None
        assert server._worktree_cwd("nope-nope", "") is None
    finally:
        shutil.rmtree(proj, ignore_errors=True)
        shutil.rmtree(os.path.join(base, ".worktrees"), ignore_errors=True)
