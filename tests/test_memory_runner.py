"""Wiring tests: memory Context Pack injection + system-prompt composition in
the runner. Run: `python tests/test_memory_runner.py`
"""

import os
import sys

import pytest
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import config, project_config, runner, store  # noqa: E402

store.init()


@pytest.fixture(autouse=True)
def _feature_on(monkeypatch):
    """Project memory ships OFF (bridge/aifeatures.py) — these tests are about what it
    does once switched on, so turn it on for the module."""
    monkeypatch.setattr(config, "MEMORY_ENABLE", True)


def test_compose_appends_pack_after_stable_parts():
    pack = "# Project memory\n- (goal) x — y"
    s = runner._compose_system_prompt(pack)
    assert pack in s
    # stable ASK prompt precedes the (session-stable) memory pack — cache alignment
    assert s.index(config.ASK_SYSTEM_PROMPT.strip()[:20]) < s.index("Project memory")


def test_compose_empty_pack_has_no_trailing_blank():
    s = runner._compose_system_prompt("")
    assert "Project memory" not in s
    assert s == s.strip()


def test_base_cmd_skip_pack_injects_no_memory_and_sets_model():
    cmd = runner._base_cmd("hello", 555, stream=False, skip_pack=True, model="haiku")
    assert "--model" in cmd and "haiku" in cmd
    sysprompt = cmd[cmd.index("--append-system-prompt") + 1]
    assert "Project memory" not in sysprompt


def test_memory_pack_for_disabled_returns_empty():
    old = config.MEMORY_ENABLE
    config.MEMORY_ENABLE = False
    try:
        assert runner._memory_pack_for(555, "/tmp") == ""
    finally:
        config.MEMORY_ENABLE = old


def test_memory_pack_for_respects_off_posture():
    key = runner._project_key(555, "/tmp")
    store.add_memory(555, "project", "goal", "ship it", "finish the thing",
                     project_path=key, branch=None, status="active")
    old = project_config.memory_mode
    try:
        project_config.memory_mode = lambda _p: "ask"
        assert "ship it" in runner._memory_pack_for(555, "/tmp")
        project_config.memory_mode = lambda _p: "off"
        assert runner._memory_pack_for(555, "/tmp") == ""
    finally:
        project_config.memory_mode = old


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
