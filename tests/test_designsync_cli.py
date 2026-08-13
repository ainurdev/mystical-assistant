"""`mystical design-link` — how a session running in some other repo persists a
design link. The bridge package isn't importable from an arbitrary cwd; the
launcher already on PATH is.
Run: python -m pytest tests/test_designsync_cli.py -v"""

import json
import os
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
MYSTICAL = str(ROOT / "bin" / "mystical")


def _run(args, home):
    env = {**os.environ, "HOME": str(home)}
    # conftest.py hard-pins BRIDGE_DB for the whole pytest process so in-process
    # tests never touch the real ~/.bridge_state. That would otherwise leak into
    # this subprocess and win over HOME, defeating the isolation below.
    env.pop("BRIDGE_DB", None)
    return subprocess.run([MYSTICAL, *args], capture_output=True, text=True, env=env)


def test_design_link_writes_the_link(tmp_path):
    p = _run(["design-link", "myrepo", "aaaa-1111"], tmp_path)
    assert p.returncode == 0, p.stderr
    cfg = json.loads((tmp_path / ".bridge_state" / "project_config.json").read_text())
    assert cfg["myrepo"]["design_project"] == "aaaa-1111"


def test_design_link_rejects_wrong_arity(tmp_path):
    p = _run(["design-link", "myrepo"], tmp_path)
    assert p.returncode == 2
    assert "usage" in (p.stdout + p.stderr).lower()


def test_design_link_with_a_blank_id_unlinks(tmp_path):
    _run(["design-link", "myrepo", "aaaa-1111"], tmp_path)
    p = _run(["design-link", "myrepo", ""], tmp_path)
    assert p.returncode == 0, p.stderr
    cfg = json.loads((tmp_path / ".bridge_state" / "project_config.json").read_text())
    assert "myrepo" not in cfg


def test_design_link_works_without_a_dot_env(tmp_path):
    """design-link needs no secrets, so it must work from a checkout that has no
    .env yet (e.g. before ./setup.sh has run) — exactly the "any repo" case the
    brief calls out. Runs against a copy of the script so REPO resolves to a
    directory that genuinely has no .env, not this checkout's real one."""
    fake_repo = tmp_path / "repo"
    (fake_repo / "bin").mkdir(parents=True)
    fake_mystical = fake_repo / "bin" / "mystical"
    shutil.copy(MYSTICAL, fake_mystical)
    fake_mystical.chmod(0o755)
    (fake_repo / "bridge").symlink_to(ROOT / "bridge")

    home = tmp_path / "home"
    env = {**os.environ, "HOME": str(home)}
    env.pop("BRIDGE_DB", None)
    p = subprocess.run([str(fake_mystical), "design-link", "myrepo", "aaaa-1111"],
                        capture_output=True, text=True, env=env)
    assert p.returncode == 0, p.stderr
    cfg = json.loads((home / ".bridge_state" / "project_config.json").read_text())
    assert cfg["myrepo"]["design_project"] == "aaaa-1111"
