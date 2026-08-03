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


def test_claude_prompt_is_tagged_internal():
    # The Claude fallback runs a throwaway session that persists a JSONL; the tag
    # keeps native.scan from surfacing it in the unified session list.
    from bridge import native
    assert pd._PROMPT.startswith(native.INTERNAL_ONESHOT_TAG)


def test_detect_spends_nothing_while_the_switch_is_off(tmp_path, monkeypatch):
    # Opening a TERMINAL tab reaches detect() with nobody pressing anything, so
    # an unreadable repo must not fall through to a model call unasked.
    _pkg(str(tmp_path / "web"), {"dev": "vite"})
    _pkg(str(tmp_path / "app"), {"dev": "vite"})
    assert pd.heuristic(str(tmp_path)) is None

    from bridge import aifeatures, runner
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)
    monkeypatch.setattr(runner, "run_blocking", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("spent a model call while the switch was off")))

    out = pd.detect(str(tmp_path), 555)
    assert out["source"] == "fallback"
    assert out["command"]          # still offers something editable


def test_detect_asks_the_model_once_the_switch_is_on(tmp_path, monkeypatch):
    _pkg(str(tmp_path / "web"), {"dev": "vite"})
    _pkg(str(tmp_path / "app"), {"dev": "vite"})

    from bridge import aifeatures, runner
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "preview")
    monkeypatch.setattr(runner, "run_blocking", lambda *a, **k: (
        '{"command": "cd web && npm run dev", "explanation": "the web app"}', "s", 0, False))

    out = pd.detect(str(tmp_path), 555)
    assert out["source"] == "claude"
    assert out["command"] == "cd web && npm run dev"
