"""Unit tests for the native JSONL -> bridge transcript translator
(bridge/transcript_jsonl.py). Stdlib only; no env/config needed.
Run: `python tests/test_transcript_jsonl.py`
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import transcript_jsonl as T   # noqa: E402

# A small but representative native transcript: control noise, a user prompt, an
# assistant turn with thinking+text+tool_use, a tool_result, a follow-up
# assistant text, a second prompt, a skipped sidechain, then a final answer.
FIXTURE = [
    {"type": "queue-operation", "sessionId": "U", "operation": "x",
     "timestamp": "2026-01-01T00:00:00Z"},
    {"type": "user", "sessionId": "U", "uuid": "t1", "cwd": "/home/me/projects/x",
     "timestamp": "2026-01-01T00:00:01Z",
     "message": {"role": "user", "content": "hello there"}},
    {"type": "assistant", "sessionId": "U", "uuid": "a1", "parentUuid": "t1",
     "timestamp": "2026-01-01T00:00:02Z",
     "message": {"role": "assistant", "model": "claude-opus", "content": [
         {"type": "thinking", "thinking": "hmm"},
         {"type": "text", "text": "hi back"},
         {"type": "tool_use", "name": "Bash", "input": {"command": "ls -la"}}]}},
    {"type": "user", "sessionId": "U", "uuid": "tr1",
     "timestamp": "2026-01-01T00:00:03Z",
     "message": {"role": "user", "content": [
         {"type": "tool_result", "content": "files..."}]}},
    {"type": "assistant", "sessionId": "U", "uuid": "a2",
     "timestamp": "2026-01-01T00:00:04Z",
     "message": {"role": "assistant", "content": [
         {"type": "text", "text": "done listing"}]}},
    {"type": "user", "sessionId": "U", "uuid": "t2",
     "timestamp": "2026-01-01T00:00:05Z",
     "message": {"role": "user", "content": "second question"}},
    {"type": "assistant", "sessionId": "U", "uuid": "s1", "isSidechain": True,
     "timestamp": "2026-01-01T00:00:05.5Z",
     "message": {"role": "assistant", "content": [
         {"type": "text", "text": "sidechain noise"}]}},
    {"type": "assistant", "sessionId": "U", "uuid": "a3",
     "timestamp": "2026-01-01T00:00:06Z",
     "message": {"role": "assistant", "content": [
         {"type": "text", "text": "final answer"}]}},
]

RECOGNIZED = {"text", "thinking", "tool", "tool_done", "result", "error", "stopped",
              "permission", "question", "permission_resolved", "question_answered"}


def _write(records, name="U.jsonl"):
    d = tempfile.mkdtemp()
    p = os.path.join(d, name)
    with open(p, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    return p


def test_parses_two_turns_with_prompts():
    out = T.parse_jsonl(_write(FIXTURE))
    turns = out["turns"]
    assert [t["prompt"] for t in turns] == ["hello there", "second question"]
    assert [t["seq"] for t in turns] == [0, 1]
    assert turns[0]["id"] == "t1" and turns[1]["id"] == "t2"
    assert all(t["status"] == "done" for t in turns)
    assert all(t["attachments"] == [] for t in turns)
    assert turns[0]["model"] == "opus"        # normalized to short family


def test_events_grouped_and_ordered_under_turns():
    out = T.parse_jsonl(_write(FIXTURE))
    by_turn = {}
    for e in out["events"]:
        by_turn.setdefault(e["turn_id"], []).append(e["type"])
    assert by_turn["t1"] == ["thinking", "text", "tool", "tool_done", "text"]
    assert by_turn["t2"] == ["text"]
    # seqs are globally ascending and unique
    seqs = [e["seq"] for e in out["events"]]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    assert out["next_cursor"] == len(out["events"])


def test_tool_event_carries_name_and_summary():
    out = T.parse_jsonl(_write(FIXTURE))
    tool = next(e for e in out["events"] if e["type"] == "tool")
    assert tool["name"] == "Bash" and tool["summary"] == "ls -la"


def test_reasoning_text_surfaces_on_its_own_event_and_sidechain_skipped():
    out = T.parse_jsonl(_write(FIXTURE))
    texts = [e.get("text") for e in out["events"] if e["type"] == "text"]
    assert "hmm" not in texts                       # reasoning is not a text block
    assert "sidechain noise" not in texts           # isSidechain record dropped
    assert texts == ["hi back", "done listing", "final answer"]
    think = [e for e in out["events"] if e["type"] == "thinking"]
    # 1s is under the bare-marker floor, but there is reasoning text to show
    assert [e["text"] for e in think] == ["hmm"]
    assert think[0]["ms"] == 1000


def test_thinking_marker_carries_the_pause_it_replaces():
    recs = [
        {"type": "user", "uuid": "t1", "timestamp": "2026-01-01T00:00:00Z",
         "message": {"role": "user", "content": "think hard"}},
        {"type": "assistant", "uuid": "a1", "timestamp": "2026-01-01T00:00:09Z",
         "message": {"role": "assistant", "content": [
             {"type": "thinking", "thinking": "", "signature": "abc"},
             {"type": "text", "text": "answer"}]}},
    ]
    out = T.parse_jsonl(_write(recs))
    assert [e["type"] for e in out["events"]] == ["thinking", "text"]
    assert out["events"][0]["ms"] == 9000           # the gap a human sat through
    assert "thinking" not in out["events"][0]       # no text: there is none to show


def test_only_recognized_event_types_emitted():
    out = T.parse_jsonl(_write(FIXTURE))
    assert all(e["type"] in RECOGNIZED for e in out["events"])


def test_cursor_filters_to_newer_events():
    full = T.parse_jsonl(_write(FIXTURE))
    last_seq = full["events"][-1]["seq"]
    tail = T.parse_jsonl(_write(FIXTURE), cursor=last_seq)
    assert [e["type"] for e in tail["events"]] == ["text"]
    assert tail["events"][0]["turn_id"] == "t2"


def test_malformed_lines_skipped():
    d = tempfile.mkdtemp()
    p = os.path.join(d, "U.jsonl")
    with open(p, "w") as f:
        f.write('{"type":"user","uuid":"t1","message":{"role":"user","content":"hi"}}\n')
        f.write("not json at all\n")
        f.write("\n")
        f.write('{"type":"assistant","uuid":"a1","message":{"role":"assistant",'
                '"content":[{"type":"text","text":"ok"}]}}\n')
    out = T.parse_jsonl(p)
    assert len(out["turns"]) == 1
    assert [e["type"] for e in out["events"]] == ["text"]


def test_find_transcript_by_uuid(tmp_root=None):
    root = tempfile.mkdtemp()
    sub = os.path.join(root, "-home-me-projects-x")
    os.makedirs(sub)
    uid = "deadbeef-0000-1111-2222-333344445555"
    open(os.path.join(sub, uid + ".jsonl"), "w").close()
    old = T.PROJECTS_DIR
    T.PROJECTS_DIR = root
    try:
        assert T.find_transcript(uid) == os.path.join(sub, uid + ".jsonl")
        assert T.find_transcript("no-such-uuid") is None
    finally:
        T.PROJECTS_DIR = old


def test_first_user_text_skips_leading_system_tags():
    recs = [
        {"type": "user", "uuid": "u0", "message": {"role": "user",
         "content": "<ide_opened_file>noise</ide_opened_file>"}},
        {"type": "user", "uuid": "u1", "message": {"role": "user",
         "content": "real question here"}},
    ]
    assert T.first_user_text(_write(recs)) == "real question here"


def test_first_user_text_strips_inline_leading_tag():
    recs = [{"type": "user", "uuid": "u0", "message": {"role": "user",
             "content": "<command-name>/x</command-name>\n\nplease do the thing"}}]
    assert T.first_user_text(_write(recs)) == "please do the thing"


def test_askuserquestion_renders_as_question_event_with_answer():
    recs = [
        {"type": "user", "uuid": "t1", "message": {"role": "user", "content": "pick one"}},
        {"type": "assistant", "uuid": "a1", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_1", "name": "AskUserQuestion", "input": {
                "questions": [{"header": "Color", "question": "Fav color?",
                               "multiSelect": False, "options": [
                                   {"label": "Red", "description": "warm"},
                                   {"label": "Blue", "description": "cool"}]}]}}]}},
        {"type": "user", "uuid": "tr1", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1",
             "content": "The user selected: Blue"}]}},
    ]
    out = T.parse_jsonl(_write(recs))
    q = next(e for e in out["events"] if e["type"] == "question")
    assert q["request_id"] == "toolu_1"
    assert q["questions"][0]["header"] == "Color"
    assert [o["label"] for o in q["questions"][0]["options"]] == ["Red", "Blue"]
    qa = next(e for e in out["events"] if e["type"] == "question_answered")
    assert qa["request_id"] == "toolu_1" and qa["answers"] == [{"header": "Color", "labels": ["Blue"]}]
    # AskUserQuestion must NOT also surface as a generic tool row
    assert all(not (e["type"] == "tool" and e.get("name") == "AskUserQuestion")
               for e in out["events"])


def test_user_tool_result_is_not_a_new_turn():
    # A user record whose content is only tool_result blocks must not open a turn.
    recs = [
        {"type": "user", "uuid": "t1", "message": {"role": "user", "content": "go"}},
        {"type": "assistant", "uuid": "a1", "message": {"role": "assistant",
         "content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "a"}}]}},
        {"type": "user", "uuid": "tr", "message": {"role": "user",
         "content": [{"type": "tool_result", "content": "x"}]}},
    ]
    out = T.parse_jsonl(_write(recs))
    assert len(out["turns"]) == 1
    assert [e["type"] for e in out["events"]] == ["tool", "tool_done"]


def test_bash_output_pairs_by_id_and_stays_bash_only():
    # The terminal block needs the command AND its output, paired by tool_use id.
    # A Read result must stay output-free (a whole file would bloat the store).
    recs = [
        {"type": "user", "uuid": "t1", "message": {"role": "user", "content": "go"}},
        {"type": "assistant", "uuid": "a1", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "ls"}},
            {"type": "tool_use", "id": "tu2", "name": "Read", "input": {"file_path": "a"}}]}},
        # Results land out of order — pairing must follow ids, not position.
        {"type": "user", "uuid": "tr", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "tu2", "content": "whole file"},
            {"type": "tool_result", "tool_use_id": "tu1", "content": "a\nb\n",
             "is_error": True}]}},
    ]
    out = T.parse_jsonl(_write(recs))
    done = {e["id"]: e for e in out["events"] if e["type"] == "tool_done"}
    assert done["tu1"]["output"] == "a\nb" and done["tu1"]["is_error"] is True
    assert "output" not in done["tu2"]
    tools = {e["id"]: e["name"] for e in out["events"] if e["type"] == "tool"}
    assert tools == {"tu1": "Bash", "tu2": "Read"}


def test_edit_carries_diff_and_duration():
    # An edit renders as a diff, using the structuredPatch Claude Code already
    # computed; duration comes from the gap between the call and its result.
    recs = [
        {"type": "user", "uuid": "t1", "timestamp": "2026-01-01T00:00:00Z",
         "message": {"role": "user", "content": "go"}},
        {"type": "assistant", "uuid": "a1", "timestamp": "2026-01-01T00:00:01Z",
         "message": {"role": "assistant", "content": [
             {"type": "tool_use", "id": "tu1", "name": "Edit",
              "input": {"file_path": "f.txt"}}]}},
        {"type": "user", "uuid": "tr", "timestamp": "2026-01-01T00:00:03.5Z",
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "tu1", "content": "ok"}]},
         "toolUseResult": {"filePath": "f.txt", "structuredPatch": [
             {"oldStart": 1, "oldLines": 3, "newStart": 1, "newLines": 3,
              "lines": [" alpha", "-beta", "+BETA", " gamma"]}]}},
    ]
    out = T.parse_jsonl(_write(recs))
    done = next(e for e in out["events"] if e["type"] == "tool_done")
    assert done["patch"] == ["@@ -1,3 +1,3 @@", " alpha", "-beta", "+BETA", " gamma"]
    assert done["ms"] == 2500
    assert "output" not in done          # diffs are not terminal output


def test_patch_lines_ignores_resultless_and_patchless_tools():
    assert T.patch_lines(None) == []
    assert T.patch_lines("a string result") == []
    assert T.patch_lines({"stdout": "hi"}) == []


def test_bash_output_is_head_capped():
    long = "x" * (T._OUT_MAX + 500)
    recs = [
        {"type": "user", "uuid": "t1", "message": {"role": "user", "content": "go"}},
        {"type": "assistant", "uuid": "a1", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "yes"}}]}},
        {"type": "user", "uuid": "tr", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "tu1", "content": long}]}},
    ]
    out = T.parse_jsonl(_write(recs))
    got = next(e for e in out["events"] if e["type"] == "tool_done")["output"]
    assert got == "x" * T._OUT_MAX + "\n…"


def test_todowrite_summary_names_the_item_it_just_started():
    todos = [{"content": "a", "status": "completed", "activeForm": "Aing"},
             {"content": "b", "status": "in_progress", "activeForm": "Wiring the card"},
             {"content": "c", "status": "pending", "activeForm": "Cing"}]
    assert T._summarize_tool("TodoWrite", {"todos": todos}) == "Wiring the card · 1/3"
    # nothing in progress -> just how far down the list it is
    done = [dict(t, status="completed") for t in todos]
    assert T._summarize_tool("TodoWrite", {"todos": done}) == "3/3 done"
    assert T._summarize_tool("TodoWrite", {"todos": []}) == ""


def test_skill_summary_names_the_skill_and_its_argument():
    assert T._summarize_tool("Skill", {"skill": "graphify"}) == "graphify"
    assert (T._summarize_tool("Skill", {"skill": "code-review", "args": "ultra"})
            == "code-review ultra")


def test_unknown_tools_summarize_from_whatever_arguments_they_took():
    # No key the summariser knows -> the arguments themselves, so the card says
    # more than its own name. Booleans are modifiers, not subjects.
    assert (T._summarize_tool("TaskUpdate", {"taskId": "1", "status": "in_progress"})
            == "taskId=1 · status=in_progress")
    assert (T._summarize_tool("mcp__x__get_task", {"id": 50180163, "fields": ["id", "name"]})
            == "id=50180163 · fields=id, name")
    assert T._summarize_tool("mcp__x__audit", {"deep": True}) == ""
    assert T._summarize_tool("mcp__x__list", {}) == ""
    # three arguments is the whole line; each is trimmed to stay one
    assert (T._summarize_tool("W", {"a": "1", "b": "2", "c": "3", "d": "4"})
            == "a=1 · b=2 · c=3")
    assert T._summarize_tool("W", {"a": "x" * 60}) == "a=" + "x" * 40


def _done(name, block, result=None):
    return T.tool_done("tu1", name, 5, block, result or {})


def _text_block(text, is_error=False):
    return {"content": [{"type": "text", "text": text}], "is_error": is_error}


def test_result_stat_measures_what_came_back():
    # a read reports its own line count, not the size of the text we were handed
    assert _done("Read", _text_block("1\tx"),
                 {"type": "text", "file": {"numLines": 512}})["stat"] == "512 lines"
    # an image read never gets counted in base64 chars
    assert _done("Read", _text_block("q"),
                 {"type": "image", "file": {"base64": "AAAA"}})["stat"] == "image"
    assert _done("Grep", _text_block("a\nb\nc"))["stat"] == "3 lines"
    assert _done("Glob", _text_block("only.py"))["stat"] == "7 chars"
    assert _done("Agent", _text_block("ok"),
                 {"totalToolUseCount": 14, "totalTokens": 32100})["stat"] == "14 tools · 32.1k tokens"
    assert _done("WebFetch", _text_block("page"), {"bytes": 13674})["stat"] == "13.7k bytes"


def test_result_stat_says_why_a_tool_failed():
    ev = _done("Read", _text_block("File does not exist.\nDid you mean…", is_error=True))
    assert ev["is_error"] is True and ev["stat"] == "File does not exist."


def test_no_stat_for_a_fixed_confirmation_or_a_diff():
    # "Todos have been modified successfully" measured in chars is not information
    assert "stat" not in _done("TodoWrite", _text_block("Todos have been modified…"))
    assert "stat" not in _done("Skill", _text_block("ok"), {"success": True})
    # an edit shows its diff; a char count next to it would be noise
    patched = _done("Edit", _text_block("done"), {"structuredPatch": [
        {"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1, "lines": ["-a", "+b"]}]})
    assert patched["patch"] and "stat" not in patched
    # …but a failed edit has no diff, so the error still gets through
    failed = _done("Edit", _text_block("String not found", is_error=True), {})
    assert failed["stat"] == "String not found"


def test_bash_keeps_output_and_gets_no_stat():
    ev = _done("Bash", _text_block("hi"))
    assert ev["output"] == "hi" and ev["is_error"] is False and "stat" not in ev


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


USAGE_FIXTURE = [
    {"type": "user", "sessionId": "V", "uuid": "u1",
     "timestamp": "2026-01-01T00:00:00Z",
     "message": {"role": "user", "content": "do a thing"}},
    {"type": "assistant", "sessionId": "V", "uuid": "a1",
     "timestamp": "2026-01-01T00:00:01Z",
     "message": {"role": "assistant", "model": "claude-opus-5",
                 "content": [{"type": "text", "text": "part one"}],
                 "usage": {"input_tokens": 100, "output_tokens": 10,
                           "cache_creation_input_tokens": 3,
                           "cache_read_input_tokens": 4}}},
    {"type": "assistant", "sessionId": "V", "uuid": "a2",
     "timestamp": "2026-01-01T00:00:02Z",
     "message": {"role": "assistant", "model": "claude-opus-5",
                 "content": [{"type": "text", "text": "part two"}],
                 "usage": {"input_tokens": 200, "output_tokens": 20,
                           "cache_creation_input_tokens": 1,
                           "cache_read_input_tokens": 2}}},
]


def test_turn_carries_its_summed_token_usage():
    """An adopted session already accumulates these four; they belong on the turn
    so the store can keep them, not only folded into a dollar estimate."""
    turn = T.parse_jsonl(_write(USAGE_FIXTURE, "V.jsonl"))["turns"][0]
    assert turn["tokens"] == {"in": 300, "out": 30, "cache_w": 4, "cache_r": 6}


def test_turn_without_usage_reports_no_tokens():
    turn = T.parse_jsonl(_write(FIXTURE))["turns"][0]
    assert turn.get("tokens") is None
