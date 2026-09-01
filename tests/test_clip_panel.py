"""A clip arrives with what it is evidence for: notes, the plan, chapters.

The three channels are authored in three different places (the model's tool
call, the session's TodoWrite list, the recorder's own clock), and the runner is
where they meet. These check the meeting, not the recorder — rec.mjs is exercised
by recording a real page in test_clip_marks_round_trip below.
"""
import json
import os
import shutil
import subprocess

import pytest

from bridge import runner


def _job(todos=None):
    j = runner.Job("j-clip", 555)
    j.todos = todos or []
    return j


def _use(tid, name, inp):
    return {"type": "assistant",
            "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}


def _result(tid, text):
    return {"type": "user",
            "message": {"content": [{"type": "tool_result", "tool_use_id": tid,
                                     "content": [{"type": "text", "text": text}]}]}}


TODOS = [
    {"content": "find what steals the scroll", "status": "completed"},
    {"content": "move the anchor onto the wrapper", "status": "completed"},
    {"content": "mirror into the Mini App", "status": "pending"},
]


def test_todowrite_becomes_the_job_plan():
    j = _job()
    runner._handle_event(j, _use("t1", "TodoWrite", {"todos": TODOS}))
    assert [t["content"] for t in j.todos] == [t["content"] for t in TODOS]


def test_clip_meta_snapshots_the_plan_and_keeps_only_real_indices():
    j = _job(TODOS)
    meta = runner._clip_meta(j, {"notes": "  the scroll holds now  ", "resolves": [1, 2, 9, -1, "x"]})
    assert meta["notes"] == "the scroll holds now"
    assert meta["resolves"] == [1, 2]           # 9, -1 and "x" point at no row
    assert [t["status"] for t in meta["todos"]] == ["completed", "completed", "pending"]


def test_clip_meta_survives_a_call_that_claims_nothing():
    meta = runner._clip_meta(_job(), {})
    assert meta == {"notes": "", "todos": [], "resolves": []}


def test_chapters_parse_off_the_second_line():
    got = runner._clip_chapters([{"type": "text", "text": (
        '/tmp/rec-x/clip.webm\n'
        'CHAPTERS [{"t": 0, "text": "load"}, {"t": 2.5, "text": "sent"}]\n'
        'Recorded http://localhost:5173.')}])
    assert got == [{"t": 0.0, "text": "load"}, {"t": 2.5, "text": "sent"}]


@pytest.mark.parametrize("text", [
    "/tmp/x.webm\nRecorded something.",                    # no marks: the normal case
    "/tmp/x.webm\nCHAPTERS not-json\n",                    # our prefix, junk payload
    "CHAPTERS [{\"t\": 0, \"text\": \"nope\"}]",           # right shape, wrong line
    "/tmp/x.webm\nCHAPTERS [{\"text\": \"untimed\"}]",     # a mark with no clock
])
def test_chapters_stay_incurious_about_text_they_did_not_write(text):
    assert runner._clip_chapters([{"type": "text", "text": text}]) == []


def test_record_result_carries_the_panel(tmp_path, monkeypatch):
    monkeypatch.setattr(runner.config, "UPLOAD_DIR", str(tmp_path / "up"))
    clip = tmp_path / "clip.webm"
    clip.write_bytes(b"\x1a\x45\xdf\xa3")     # enough for mimetypes to call it webm

    j = _job()
    runner._handle_event(j, _use("t1", "TodoWrite", {"todos": TODOS}))
    runner._handle_event(j, _use("t2", "mcp__verify__Record",
                                 {"url": "http://x", "notes": "scroll holds", "resolves": [1]}))
    runner._handle_event(j, _result(
        "t2", f'{clip}\nCHAPTERS [{{"t": 1.5, "text": "composer grows"}}]\nRecorded http://x.'))

    ev = next(e for e in j.events if e.get("type") == "tool_done")
    assert ev["clip"]["notes"] == "scroll holds"
    assert ev["clip"]["resolves"] == [1]
    assert ev["clip"]["chapters"] == [{"t": 1.5, "text": "composer grows"}]
    assert len(ev["clip"]["todos"]) == 3
    assert ev["images"] and ev["images"][0].endswith("clip.webm")
    assert not j.clip_meta                      # the pending entry was consumed


def test_a_clip_claiming_nothing_gets_no_panel(tmp_path, monkeypatch):
    monkeypatch.setattr(runner.config, "UPLOAD_DIR", str(tmp_path / "up"))
    clip = tmp_path / "bare.webm"
    clip.write_bytes(b"\x1a\x45\xdf\xa3")

    j = _job()
    runner._handle_event(j, _use("t1", "mcp__verify__Record", {"url": "http://x"}))
    runner._handle_event(j, _result("t1", f"{clip}\nRecorded http://x."))

    ev = next(e for e in j.events if e.get("type") == "tool_done")
    assert "clip" not in ev                     # no notes, no plan, no marks
    assert ev["images"]                         # but the clip still arrives


def test_a_tool_that_saved_no_file_leaves_no_pending_meta(tmp_path, monkeypatch):
    """A failed recording must not leave its metadata waiting for a file that
    never lands — the next clip would inherit it."""
    monkeypatch.setattr(runner.config, "UPLOAD_DIR", str(tmp_path / "up"))
    j = _job()
    runner._handle_event(j, _use("t1", "mcp__verify__Record", {"url": "http://x", "notes": "n"}))
    runner._handle_event(j, _result("t1", "Recording failed: chrome is not installed"))
    assert not j.clip_meta


@pytest.mark.skipif(not shutil.which("node"), reason="the recorder is a node script")
def test_clip_marks_round_trip(tmp_path):
    """mark() in the step script comes back as a timestamped chapter.

    The point of the whole feature is that the *recorder* times the marks, so
    this asserts the spacing the steps asked for actually survives into the
    sidecar — a chapter list that drifts is worse than none.
    """
    page = tmp_path / "p.html"
    page.write_text("<body style='background:#000'><h1 id=h>hi</h1>"
                    "<script>setInterval(()=>h.textContent=Date.now(),100)</script>")
    out = tmp_path / "clip.webm"
    steps = ('(async () => { const s = ms => new Promise(r => setTimeout(r, ms));'
             ' mark("first"); await s(1200); mark("second"); })()')
    p = subprocess.run(
        ["node", os.path.join(os.path.dirname(runner.__file__), "rec.mjs"),
         page.as_uri(), str(out), "480", "320", "400", "{}", steps, "10"],
        capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stderr           # cleanup must not fail a good clip
    assert out.exists()

    chapters = json.loads((tmp_path / "clip.webm.chapters.json").read_text())
    assert [c["text"] for c in chapters] == ["first", "second"]
    gap = chapters[1]["t"] - chapters[0]["t"]
    assert 1.0 < gap < 1.6, f"marks drifted: {chapters}"
