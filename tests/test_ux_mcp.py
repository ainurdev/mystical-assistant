"""mystical-ux: the UX knowledge server, and the bridge's capture of Mobbin calls."""
import json

import pytest

from bridge import runner, ux_mcp


@pytest.fixture(autouse=True)
def ux_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("MYSTICAL_UX_DIR", str(tmp_path))
    return tmp_path


def _rpc(method, params=None, rid=1):
    return ux_mcp._handle(                          # noqa: SLF001 — the unit under test
        {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def _call(name, **args):
    return _rpc("tools/call", {"name": name, "arguments": args})["result"]["content"][0]["text"]


def _mobbin_result(query, *apps):
    """A tool_result's content as Mobbin returns it: preview images, then one JSON text block."""
    screens = [{"id": f"id-{a}", "image_url": f"https://mobbin.com/api/mcp/short/{a}",
                "mobbin_url": f"https://mobbin.com/screens/id-{a}", "app_name": a, "platform": "web"}
               for a in apps]
    return [{"type": "image", "source": {"type": "base64", "media_type": "image/webp", "data": "AAAA"}},
            {"type": "text", "text": json.dumps({"query": query, "screens": screens,
                                                 "ai_usage_notice": {"text": "usage is high"}})}]


def test_initialize_and_tools_list():
    assert _rpc("initialize")["result"]["protocolVersion"] == ux_mcp.PROTOCOL
    assert {t["name"] for t in _rpc("tools/list")["result"]["tools"]} == {"SearchUx", "GetUx", "RecordUx"}
    assert _rpc("notifications/initialized", rid=None) is None


def test_record_creates_then_appends_and_keeps_the_old_verdict(ux_dir):
    out = _call("RecordUx", slug="link-icons", title="Icons beside underlined links",
                verdict="Only when the icon adds meaning.", tags=["links", "icons"], project="nr-kantoor",
                rules=["The underline says link."], screens=["Descript · Learn more ↗ · https://mobbin.com/screens/a"],
                case="Asked: icon beside the underline?")
    assert out.startswith("Created link-icons")
    _call("RecordUx", slug="link-icons", status="decided", verdict="Never on row links.",
          screens=["Descript · Learn more ↗ · https://mobbin.com/screens/a", "Apollo · row links · https://mobbin.com/screens/b"],
          case="Picked B; I had recommended A.", project="nr-kantoor")
    text = (ux_dir / "patterns" / "link-icons.md").read_text()
    assert "status: decided" in text and "verdict: Never on row links." in text
    assert "verdict was: Only when the icon adds meaning." in text          # history, not lost
    assert text.count("Descript · Learn more") == 1                         # evidence deduped
    assert "Apollo · row links" in text and "The underline says link." in text
    assert text.count("· nr-kantoor ·") == 2                                 # both cases kept
    assert _call("GetUx", slug="link-icons") == text


def test_record_refuses_a_slug_that_leaves_the_folder(ux_dir):
    for slug in ("../escape", "a/b", "Caps", ""):
        assert "slug" in _call("RecordUx", slug=slug, title="t", verdict="v")
    assert not list(ux_dir.rglob("*.md"))


def test_a_new_pattern_needs_a_title_and_a_verdict(ux_dir):
    assert "title and a verdict" in _call("RecordUx", slug="half", title="Only a title")
    assert "decided, researched or open" in _call("RecordUx", slug="x", title="t", verdict="v", status="done")
    assert not (ux_dir / "patterns" / "half.md").exists()


def test_search_finds_a_pattern_by_its_words():
    _call("RecordUx", slug="link-icons", title="Icons beside underlined links", verdict="Only when it adds meaning.",
          tags=["links"])
    _call("RecordUx", slug="forms", title="Forms in two equal columns", verdict="Every form: two columns.")
    out = _call("SearchUx", query="should a link get an icon?")
    assert "link-icons" in out and "forms" not in out
    assert "link-icons" not in _call("SearchUx", query="link icon", tags=["tables"])


def test_search_falls_back_to_past_mobbin_searches():
    ux_mcp.capture("mcp__mobbin__search_screens",
                   _mobbin_result("calendar event running over its end time", "Cron", "Linear"), "/x/nr-kantoor")
    out = _call("SearchUx", query="a calendar event that runs over")
    assert "Cron https://mobbin.com/screens/id-Cron" in out and "nr-kantoor" in out


def test_search_with_nothing_says_research_it():
    assert "Nothing yet" in _call("SearchUx", query="date range picker")


def test_capture_keeps_links_not_images_and_skips_other_content(ux_dir):
    assert ux_mcp.capture("mcp__mobbin__search_screens", _mobbin_result("view all link", "Stripe"),
                          "/Users/me/Projects/.worktrees/nr-kantoor/main")
    for content in ("plain string", [{"type": "text", "text": "not json"}], None):
        assert not ux_mcp.capture("mcp__mobbin__search_screens", content, None)
    (line,) = (ux_dir / "mobbin.jsonl").read_text().splitlines()
    rec = json.loads(line)
    assert rec["project"] == "nr-kantoor" and rec["query"] == "view all link" and rec["tool"] == "search_screens"
    assert rec["screens"] == [{"app": "Stripe", "id": "id-Stripe", "url": "https://mobbin.com/screens/id-Stripe"}]
    assert "image_url" not in line                                           # expires in 30 days; not ours


def test_the_stream_captures_a_mobbin_result_and_nothing_else(ux_dir):
    j = runner.Job("j-ux", 555)
    j.cwd = "/Users/me/Projects/ainurhq/nationale-rijschool/nr-kantoor"
    for tid, name in (("t1", "mcp__mobbin__search_screens"), ("t2", "Bash")):
        runner._handle_event(j, {"type": "assistant", "message": {"content": [          # noqa: SLF001
            {"type": "tool_use", "id": tid, "name": name, "input": {"query": "q"}}]}})
        runner._handle_event(j, {"type": "user", "message": {"content": [               # noqa: SLF001
            {"type": "tool_result", "tool_use_id": tid, "content": _mobbin_result("invoice pdf link", "Fiverr")}]}})
    (line,) = (ux_dir / "mobbin.jsonl").read_text().splitlines()
    assert json.loads(line)["project"] == "nr-kantoor"


def test_every_session_is_told_to_ask_it_first():
    assert runner._UX_NOTE in runner._compose_system_prompt()                # noqa: SLF001
    assert "mcp__mystical-ux__SearchUx" in runner._UX_NOTE                  # noqa: SLF001
