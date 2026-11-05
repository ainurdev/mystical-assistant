"""paths: the bundled skill pack rides every interactive run while SKILL PATHS
(the `router` AI switch) is on. Run: python -m pytest tests/test_paths.py -v"""

import pytest

from bridge import aifeatures, paths, runner, store

store.init()
SID = "11111111-2222-3333-4444-555555555555"


def _cmd(**kw):
    return runner._base_cmd("hi", 1, stream=True, interactive=True, claude_session_id=SID, **kw)


@pytest.fixture
def router_on(monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "router")


@pytest.fixture
def router_off(monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)


def test_base_cmd_adds_plugin_dir_when_router_on(router_on):
    cmd = _cmd()
    assert cmd[cmd.index("--plugin-dir") + 1] == paths.PACK_DIR


def test_base_cmd_no_plugin_dir_when_off_or_skip_pack(router_off, monkeypatch):
    assert "--plugin-dir" not in _cmd()
    monkeypatch.setattr(aifeatures, "enabled", lambda key: True)
    assert "--plugin-dir" not in _cmd(skip_pack=True)


@pytest.fixture
def session_c1():
    s = store.create_session(1, "p")
    store.set_claude_session_id(s["id"], "c1")
    paths._pack_ok.clear()


@pytest.fixture
def rivendell_session_c2():
    s = store.create_session(1, "p", origin="rivendell:job")
    store.set_claude_session_id(s["id"], "c2")
    paths._pack_ok.clear()


def test_pack_in_prompt_when_on(router_on, session_c1):
    assert paths.PACK_TEXT in runner._compose_system_prompt(paths_pack=paths.pack_for("c1"))


def test_pack_is_constant(router_on, session_c1):
    a = runner._compose_system_prompt(paths_pack=paths.pack_for("c1"))
    assert a == runner._compose_system_prompt(paths_pack=paths.pack_for("c1"))


def test_no_pack_for_rivendell_jobs(router_on, rivendell_session_c2):
    assert paths.pack_for("c2") == ""


def test_no_pack_when_off(router_off, session_c1):
    assert paths.pack_for("c1") == ""
