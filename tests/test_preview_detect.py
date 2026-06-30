"""preview_detect.heuristic: deterministic start-command detection."""

import json
import os

from bridge import preview_detect as pd


def _pkg(d, scripts):
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "package.json"), "w", encoding="utf-8") as f:
        json.dump({"scripts": scripts}, f)


def test_root_app_npm_with_install(tmp_path):
    _pkg(str(tmp_path), {"dev": "vite"})
    # no node_modules → install is prepended
    assert pd.heuristic(str(tmp_path)) == "npm install && npm run dev"


def test_root_app_skips_install_when_node_modules_present(tmp_path):
    _pkg(str(tmp_path), {"dev": "vite"})
    os.makedirs(tmp_path / "node_modules")
    assert pd.heuristic(str(tmp_path)) == "npm run dev"


def test_pnpm_lockfile_picks_pnpm(tmp_path):
    _pkg(str(tmp_path), {"dev": "vite"})
    (tmp_path / "pnpm-lock.yaml").write_text("")
    assert pd.heuristic(str(tmp_path)) == "pnpm install && pnpm run dev"


def test_single_subdir_app_chains_cd(tmp_path):
    # root has no package.json; one obvious app under web/
    _pkg(str(tmp_path / "web"), {"dev": "vite"})
    (tmp_path / "web" / "yarn.lock").write_text("")
    assert pd.heuristic(str(tmp_path)) == "cd web && yarn install && yarn run dev"


def test_ambiguous_multiple_apps_returns_none(tmp_path):
    # two runnable subdir apps (both scanned) → ambiguous → defer to Claude
    _pkg(str(tmp_path / "web"), {"dev": "vite"})
    _pkg(str(tmp_path / "app"), {"dev": "vite"})
    assert pd.heuristic(str(tmp_path)) is None


def test_no_runnable_project_returns_none(tmp_path):
    # a python-ish repo with no package.json anywhere we look
    (tmp_path / "main.py").write_text("print(1)")
    assert pd.heuristic(str(tmp_path)) is None


def test_start_script_fallback(tmp_path):
    _pkg(str(tmp_path), {"start": "node server.js"})
    os.makedirs(tmp_path / "node_modules")
    assert pd.heuristic(str(tmp_path)) == "npm run start"
