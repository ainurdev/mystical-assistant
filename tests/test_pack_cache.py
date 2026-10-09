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


def test_repo_gets_self_ignoring_mystical_dir(tmp_path):
    """The note sends files to .mystical/; a repo must have it, ignored by itself."""
    (tmp_path / ".git").mkdir()
    runner._base_cmd("hi", 555, stream=False, cwd=str(tmp_path), skip_pack=True)
    assert (tmp_path / ".mystical" / ".gitignore").read_text() == "*\n"
    plain = tmp_path / "plain"
    plain.mkdir()
    runner._base_cmd("hi", 555, stream=False, cwd=str(plain), skip_pack=True)
    assert not (plain / ".mystical").exists()


def test_acp_first_prompt_carries_mystical_note(tmp_path, monkeypatch):
    """ACP has no system prompt: a new agent session gets the note on its first
    prompt, a resumed one doesn't, and the repo gets its .mystical/ either way."""
    (tmp_path / ".git").mkdir()
    sent = []
    a = runner.acp_agents
    monkeypatch.setattr(a, "preset", lambda agent: {"label": "Fake"})
    monkeypatch.setattr(a, "run_problem", lambda *x: None)
    for f in ("argv", "env_for", "login_hint", "auth_method"):
        monkeypatch.setattr(a, f, lambda *x: None)
    monkeypatch.setattr(runner.acp, "run_turn", lambda job, **kw: sent.append(kw["text"]))
    for agent_sid in (None, "old"):
        monkeypatch.setattr(runner.store, "get_session",
                            lambda sid, v=agent_sid: {"agent_session_id": v})
        job = runner.AcpJob("j", 555, store_session_id="s")
        job.runtime = "acp:fake"
        runner._consume_acp(job, "hi", [], str(tmp_path), None, None, None)
    assert sent == [runner._MYSTICAL_NOTE + "\n\nhi", "hi"]
    assert (tmp_path / ".mystical" / ".gitignore").read_text() == "*\n"
