import json
import os
import subprocess

import pytest

from bridge import rivendell_video as rv


def test_transcribe_runs_whisper_and_reads_its_json(tmp_path, monkeypatch):
    """whisper-cli writes <wav>.json; its offsets are the segments' milliseconds."""
    wav = str(tmp_path / "audio.wav")
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        with open(wav + ".json", "w") as f:
            json.dump({"transcription": [
                {"offsets": {"from": 0, "to": 15000}, "text": " Hello gentlemen. "},
                {"offsets": {"from": 15000, "to": 25000}, "text": "It is very necessary."},
                {"offsets": {"from": 25000, "to": 26000}, "text": "   "},
            ]}, f)
        return subprocess.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(rv.subprocess, "run", run)
    monkeypatch.setattr(rv.config, "WHISPER_BIN", "whisper-cli")
    monkeypatch.setattr(rv.config, "WHISPER_MODEL", "/m/turbo.bin")
    segments = rv.transcribe(wav, "en")
    assert segments == [{"startMs": 0, "endMs": 15000, "text": "Hello gentlemen."},
                        {"startMs": 15000, "endMs": 25000, "text": "It is very necessary."}]
    cmd = calls[0]
    assert cmd[:3] == ["whisper-cli", "-m", "/m/turbo.bin"]
    assert "-l" in cmd and cmd[cmd.index("-l") + 1] == "en"
    assert "-oj" in cmd and "-of" in cmd and cmd[cmd.index("-of") + 1] == wav


def test_missing_tool_is_a_readable_error(tmp_path, monkeypatch):
    def run(cmd, **kw):
        raise FileNotFoundError(2, "No such file", cmd[0])
    monkeypatch.setattr(rv.subprocess, "run", run)
    with pytest.raises(rv.VideoToolError, match="whisper-cli: command not found"):
        rv.transcribe(str(tmp_path / "a.wav"), "en")
    with pytest.raises(rv.VideoToolError, match="ffmpeg: command not found"):
        rv.extract_audio("in.mov", "out.wav")


def test_tools_says_which_video_tools_are_found(monkeypatch, tmp_path):
    model = tmp_path / "ggml.bin"
    model.write_bytes(b"x")
    monkeypatch.setattr(rv.config, "FFMPEG_BIN", "/bin/sh")               # any executable
    monkeypatch.setattr(rv.config, "WHISPER_BIN", str(tmp_path / "no-whisper"))
    monkeypatch.setattr(rv.config, "WHISPER_MODEL", str(model))
    assert rv.tools() == {"ffmpeg": True, "whisper": False, "model": True}


def test_pick_frames_reads_showinfo_moments_and_caps_the_count(tmp_path, monkeypatch):
    """ffmpeg's showinfo prints one pts_time per selected frame, in the files' order."""
    out = tmp_path / "frames"
    stderr = "".join(f"[Parsed_showinfo_1 @ 0x1] n:{i} pts:{i} pts_time:{i * 10}.5 fmt:yuv\n" for i in range(50))

    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        os.makedirs(out, exist_ok=True)
        for i in range(1, 51):
            (out / f"{i:04d}.jpg").write_bytes(b"\xff\xd8\xff")
        return subprocess.CompletedProcess(cmd, 0, "", stderr)
    monkeypatch.setattr(rv.subprocess, "run", run)
    frames = rv.pick_frames("in.mov", str(out), max_frames=40)
    assert len(frames) == 40
    cmd = calls[0]
    assert "-fps_mode" in cmd and cmd[cmd.index("-fps_mode") + 1] == "vfr" and "-vsync" not in cmd   # ffmpeg 9 dropped -vsync
    assert frames[0] == {"index": 1, "timeMs": 500, "path": str(out / "0001.jpg")}
    assert frames[-1]["index"] == 40
    assert len({f["timeMs"] for f in frames}) == 40          # an even spread, no repeats
    assert all(os.path.exists(f["path"]) for f in frames)


def test_prompt_filling_and_rendering():
    segs = [{"startMs": 95000, "endMs": 97000, "text": "The Exact number."}]
    frames = [{"index": 1, "timeMs": 12000, "path": "/w/screens/1.jpg"}]
    assert rv.render_transcript(segs) == "1:35  The Exact number."
    assert rv.render_screens(frames) == "1. 0:12 — /w/screens/1.jpg"
    out = rv.fill_prompt("T:\n{{TRANSCRIPT}}\nS:\n{{SCREENS}}", rv.render_transcript(segs), rv.render_screens(frames))
    assert "{{" not in out and "1:35  The Exact number." in out


def test_transcribe_result_merges_claude_json_or_leaves_summary_empty():
    segs = [{"startMs": 0, "endMs": 1, "text": "hi"}]
    frames = [{"index": 1, "timeMs": 0, "path": "/w/1.jpg"}, {"index": 2, "timeMs": 5000, "path": "/w/2.jpg"}]
    answer = "```json\n" + json.dumps({"summary": "A walkthrough.", "chapters": [{"timeMs": 0, "title": "Intro"}],
                                     "keyPoints": ["x"], "screens": [{"index": 2, "caption": "Card"}]}) + "\n```"
    res = rv.transcribe_result("en", segs, frames, answer)
    assert res["summary"] == "A walkthrough."
    assert res["screens"] == [{"index": 1, "timeMs": 0, "caption": None}, {"index": 2, "timeMs": 5000, "caption": "Card"}]
    assert res["language"] == "en" and res["segments"] == segs and res["transcriber"] == "whisper.cpp large-v3-turbo"
    bad = rv.transcribe_result("en", segs, frames, "Sorry, I could not open the images.")
    assert bad["summary"] is None and bad["chapters"] == [] and bad["keyPoints"] == []
    assert bad["screens"][1]["caption"] is None
