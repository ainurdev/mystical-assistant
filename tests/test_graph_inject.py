"""Graph pack rides --append-system-prompt after the memory pack.
Run: python -m pytest tests/test_graph_inject.py -v"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import runner  # noqa: E402


def _sysprompt(cmd: list) -> str:
    return cmd[cmd.index("--append-system-prompt") + 1]


def test_compose_orders_memory_then_graph():
    out = runner._compose_system_prompt("MEMPACK", "GRAPHPACK")
    assert out.index("MEMPACK") < out.index("GRAPHPACK")


def test_compose_without_graph_unchanged():
    assert runner._compose_system_prompt("MEMPACK") == \
        runner._compose_system_prompt("MEMPACK", "")


def test_base_cmd_includes_graph_pack(monkeypatch):
    monkeypatch.setattr(runner, "_memory_pack_for", lambda *a: "MEM")
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a: "# Project map\nX")
    cmd = runner._base_cmd("hi", 555, stream=False)
    assert "# Project map" in _sysprompt(cmd)


def test_skip_pack_skips_graph_too(monkeypatch):
    monkeypatch.setattr(runner, "_memory_pack_for", lambda *a: "MEM")
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a: "# Project map\nX")
    cmd = runner._base_cmd("hi", 555, stream=False, skip_pack=True)
    assert "# Project map" not in _sysprompt(cmd)
    assert "MEM" not in _sysprompt(cmd)


def test_graph_pack_for_swallows_errors(monkeypatch):
    from bridge import graphmap
    monkeypatch.setattr(graphmap, "graph_pack",
                        lambda _cwd: (_ for _ in ()).throw(RuntimeError("boom")))
    assert runner._graph_pack_for(555, "/tmp") == ""
