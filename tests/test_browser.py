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
    _mk(base, "ainurhq", "unideck-mono", "unideck", git="dir")     # org/mono/repo
    _mk(base, "ainurhq", "unideck-mono", "unideck-api", git="file")  # worktree-style .git file
    _mk(base, "ainurhq", "poc")                                    # bare folder — not a repo
    _mk(base, ".hidden", "x", git="dir")                           # dotdir skipped
    _mk(base, "node_modules", "y", git="dir")                      # SKIP_DIRS skipped
    _mk(base, "deep", "a", "b", "c", git="dir")                    # depth 4 — beyond cap

    assert browser.list_projects() == [
        "/ainurhq/invoicer",
        "/ainurhq/unideck-mono/unideck",
        "/ainurhq/unideck-mono/unideck-api",
        "/aligned",
    ]
