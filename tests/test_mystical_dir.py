"""The .mystical folder's kinds, what can be deleted, and clearing by age."""
import os
import time

import pytest

from bridge import mystical_dir as md, tool_policy as tp


def _root(tmp_path):
    m = tmp_path / ".mystical"
    (m / "scratch" / "old").mkdir(parents=True)
    (m / "scratch" / "old" / "a.py").write_text("x")
    (m / "scratch" / "new.py").write_text("x")
    (m / "docs").mkdir()
    (m / "docs" / "r.md").write_text("# r")
    (m / "images").mkdir()
    (m / "images" / "a.png").write_bytes(b"x")
    (m / "dev.log").write_text("x")
    (m / "kimi-src").mkdir()
    (m / "kimi-src" / "big").write_text("x" * 100)
    old = time.time() - 40 * 86400
    for p in (m / "scratch" / "old" / "a.py", m / "scratch" / "old", m / "kimi-src" / "big", m / "kimi-src"):
        os.utime(p, (old, old))
    return str(tmp_path)


def test_listing_groups_by_kind(tmp_path):
    r = _root(tmp_path)
    got = md.listing(r)
    kinds = {r["name"]: r["kind"] for r in got["entries"]}
    assert kinds == {"scratch": "scratch", "docs": "docs", "images": "images", "dev.log": "bridge", "kimi-src": "other"}
    assert got["groups"]["other"]["bytes"] == 100 and got["total"] > 100
    assert md.listing(r, "scratch")["sub"] == "scratch"


def test_what_can_go(tmp_path):
    r = _root(tmp_path)
    with pytest.raises(ValueError, match="uses that"):
        md.delete(r, "dev.log")
    with pytest.raises(ValueError, match="Old chats"):
        md.delete(r, "images/a.png")
    md.delete(r, "images/a.png", confirm_images=True)
    md.delete(r, "docs/r.md")
    for bad in ("../x", "../../etc/passwd", "", "/etc/passwd"):
        with pytest.raises(ValueError):
            md.delete(r, bad)


def test_a_link_cant_lead_out(tmp_path):
    r = _root(tmp_path)
    out = tmp_path / "outside"
    out.mkdir()
    (out / "keepme").write_text("x")
    os.symlink(out, tmp_path / ".mystical" / "scratch" / "link")
    with pytest.raises(ValueError):
        md.delete(r, "scratch/link/keepme")
    assert (out / "keepme").exists()
    md.delete(r, "scratch/link")     # the link itself can go, not what it points at
    assert (out / "keepme").exists()


def test_clearing_takes_old_scratch_and_other_and_respects_keep(tmp_path):
    r = _root(tmp_path)
    assert {x["path"] for x in md.stale(r)} == {"scratch/old", "kimi-src"}
    md.set_keep(r, "kimi-src", True)
    assert {x["path"] for x in md.stale(r)} == {"scratch/old"}
    got = md.clear_stale(r)
    assert got["removed"] == 1
    assert not (tmp_path / ".mystical" / "scratch" / "old").exists()
    assert (tmp_path / ".mystical" / "scratch" / "new.py").exists() and (tmp_path / ".mystical" / "kimi-src").exists()


def test_read_text_only_inside_and_only_text(tmp_path):
    r = _root(tmp_path)
    assert md.read_text(r, "docs/r.md") == "# r"
    assert md.read_text(r, "images/a.png") is None
    assert md.read_text(r, "../../etc/passwd") is None


# ---- tool policy --------------------------------------------------------------------

@pytest.fixture
def policy(monkeypatch, tmp_path):
    monkeypatch.setattr(tp, "_FILE", str(tmp_path / "pol.json"))


def test_nearest_level_wins_and_says_which(policy, tmp_path):
    from bridge import config, store
    store.init()
    s = store.create_session(config.DASH_CHAT_ID, "/p", cwd=str(tmp_path))
    assert tp.lookup("mcp", "x", "kimi", "/p", s) == (None, None)
    tp.set_pick("machine", "mcp", "x", "kimi", False, "/p", s)
    assert tp.lookup("mcp", "x", "kimi", "/p", s) == (False, "machine")
    tp.set_pick("project", "mcp", "x", "kimi", True, "/p", s)
    assert tp.lookup("mcp", "x", "kimi", "/p", s) == (True, "project")
    assert tp.lookup("mcp", "x", "kimi", "/q", s) == (False, "machine")
    tp.set_pick("chat", "mcp", "x", "kimi", False, "/p", s)
    s = store.get_session(s["id"])
    assert tp.lookup("mcp", "x", "kimi", "/p", s) == (False, "chat")
    tp.set_pick("chat", "mcp", "x", "kimi", None, "/p", s)
    assert tp.lookup("mcp", "x", "kimi", "/p", store.get_session(s["id"])) == (True, "project")


def test_patterns_and_claude_denied(policy):
    assert tp.set_patterns("machine", ["Bash(git push*)", " ", "Bash(git push*)", "; rm"], None, None) == ["Bash(git push*)"]
    tp.set_pick("project", "tool", "WebFetch", "claude", False, "/p", None)
    assert tp.claude_denied("/p", None) == ["WebFetch", "Bash(git push*)"]
    assert tp.claude_denied("/q", None) == ["Bash(git push*)"]
    with pytest.raises(ValueError):
        tp.set_patterns("nope", [], None, None)
