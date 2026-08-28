"""browser.list_projects — repo discovery that recurses into org folders."""

import os

from bridge import browser, config


def _mk(base, *parts, git=None):
    """Create base/parts; git='dir' adds a .git dir, git='file' a .git file."""
    p = os.path.join(base, *parts)
    os.makedirs(p, exist_ok=True)
    if git == "dir":
        os.makedirs(os.path.join(p, ".git"), exist_ok=True)
    elif git == "file":
        open(os.path.join(p, ".git"), "w").close()
    return p


def test_list_projects_recurses_org_folders(tmp_path, monkeypatch):
    base = os.path.realpath(str(tmp_path))
    monkeypatch.setattr(config, "BASE_PATH", base)

    _mk(base, "aligned", git="dir")                                # top-level repo
    _mk(base, "ainurhq", "invoicer", git="dir")                    # org/repo
    _mk(base, "ainurhq", "efas", "app", git="dir")                 # org/sub-org/repo
    _mk(base, "ainurhq", "poc")                                    # bare folder — not a repo
    _mk(base, "ainurhq", "invoicer", "packages", "core", git="dir")  # inside a repo — not a project
    _mk(base, "wt", git="file")                                    # worktree checkout — skipped
    _mk(base, "wt2", "inner", git="dir")                           # nested under a worktree...
    _mk(base, "wt2", git="file")                                   # ...not entered either
    _mk(base, ".hidden", "x", git="dir")                           # dotdir skipped
    _mk(base, "node_modules", "y", git="dir")                      # SKIP_DIRS skipped

    assert browser.list_projects() == [
        "/ainurhq/efas/app",
        "/ainurhq/invoicer",
        "/aligned",
    ]


def test_project_exists_only_for_live_dirs_under_base(tmp_path, monkeypatch):
    base = os.path.realpath(str(tmp_path))
    monkeypatch.setattr(config, "BASE_PATH", base)
    _mk(base, "alive")

    assert browser.project_exists("/alive")
    assert not browser.project_exists("/")              # the root holds projects, is not one
    assert not browser.project_exists("~")              # nor is your home dir
    assert not browser.project_exists("/gone")          # deleted worktree checkout
    assert not browser.project_exists("/../outside")    # escapes the workspace
