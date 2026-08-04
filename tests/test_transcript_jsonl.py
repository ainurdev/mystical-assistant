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

RECOGNIZED = {"text", "tool", "tool_done", "result", "error", "stopped",
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
    assert by_turn["t1"] == ["text", "tool", "tool_done", "text"]
    assert by_turn["t2"] == ["text"]
    # seqs are globally ascending and unique
    seqs = [e["seq"] for e in out["events"]]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    assert out["next_cursor"] == len(out["events"])


def test_tool_event_carries_name_and_summary():
    out = T.parse_jsonl(_write(FIXTURE))
    tool = next(e for e in out["events"] if e["type"] == "tool")
    assert tool["name"] == "Bash" and tool["summary"] == "ls -la"


def test_thinking_and_sidechain_skipped():
    out = T.parse_jsonl(_write(FIXTURE))
    texts = [e.get("text") for e in out["events"] if e["type"] == "text"]
    assert "hmm" not in texts                       # thinking block dropped
    assert "sidechain noise" not in texts           # isSidechain record dropped
    assert texts == ["hi back", "done listing", "final answer"]


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
