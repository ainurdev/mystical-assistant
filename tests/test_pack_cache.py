"""The graph pack goes into --append-system-prompt once per session.

Re-sending a rebuilt pack every turn changes the appended block, which sits after
the last prompt-cache breakpoint — the whole block plus the resumed transcript
gets re-written at cache-write price.
Run: python -m pytest tests/test_pack_cache.py -v"""

import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import runner  # noqa: E402


def _sysprompt(cmd: list) -> str:
    return cmd[cmd.index("--append-system-prompt") + 1]


def _cmd(sid: str, new: bool = False) -> list:
    return runner._base_cmd("hi", 555, stream=False, claude_session_id=sid,
                            new_session=new)


def _stub_pack(monkeypatch, pack: str) -> None:
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a, **k: pack)


def test_pack_injected_on_first_turn_only(monkeypatch):
    _stub_pack(monkeypatch, "GRAPH")
    sid = str(uuid.uuid4())

    assert "GRAPH" in _sysprompt(_cmd(sid, new=True))
    assert "GRAPH" not in _sysprompt(_cmd(sid))


def test_appended_prompt_is_byte_stable_across_turns(monkeypatch):
    """The actual cache contract: turn 2 and turn 3 must be identical bytes even
    though the pack changed underneath (a re-mapped repo bumps it)."""
    _stub_pack(monkeypatch, "GRAPH v1")
    sid = str(uuid.uuid4())
    _cmd(sid, new=True)

    turn2 = _sysprompt(_cmd(sid))
    _stub_pack(monkeypatch, "GRAPH v2 — the map was rebuilt mid-session")
    turn3 = _sysprompt(_cmd(sid))
    assert turn2 == turn3


def test_each_session_gets_its_own_injection(monkeypatch):
    _stub_pack(monkeypatch, "GRAPH")
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    assert "GRAPH" in _sysprompt(_cmd(a, new=True))
    assert "GRAPH" in _sysprompt(_cmd(b, new=True))   # b is not muted by a
    assert "GRAPH" not in _sysprompt(_cmd(a))


def test_skip_pack_still_wins(monkeypatch):
    """Internal one-shots stay pack-free and must not mark the session packed."""
    _stub_pack(monkeypatch, "GRAPH")
    sid = str(uuid.uuid4())
    assert "GRAPH" not in _sysprompt(
        runner._base_cmd("hi", 555, stream=False, claude_session_id=sid,
                         skip_pack=True))
    assert "GRAPH" in _sysprompt(_cmd(sid, new=True))


def test_stable_content_always_present(monkeypatch):
    """Muting the pack must not mute the dev-log note — it is not volatile."""
    _stub_pack(monkeypatch, "GRAPH")
    sid = str(uuid.uuid4())
    _cmd(sid, new=True)
    assert runner._LOG_NOTE in _sysprompt(_cmd(sid))
