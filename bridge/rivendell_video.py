"""The media half of Rivendell's video kind (rivendell.py: _run_video).

A bridge Mac does what Claude cannot: it downloads the file, pulls the audio
out with ffmpeg, transcribes it with whisper.cpp, and keeps one frame per
screen change. Claude then only reads text and images. Everything here is a
plain function so the tests can fake subprocess and the network."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import urllib.request

from bridge import config

TRANSCRIBER = "whisper.cpp large-v3-turbo"
_SHOWINFO_TIME = re.compile(r"pts_time:([0-9.]+)")


class VideoToolError(RuntimeError):
    """A tool is missing or failed; the message is what the viewer shows."""


def _run(cmd: list[str], what: str, timeout: float) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise VideoToolError(f"{os.path.basename(cmd[0])}: command not found") from None
    except subprocess.TimeoutExpired:
        raise VideoToolError(f"{what} took longer than {int(timeout)}s") from None
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-3:]
        raise VideoToolError(f"{what} failed: " + " | ".join(tail))
    return proc


def download(url: str, dest: str, timeout: float = 900) -> None:
    """Stream the file to disk; the signed URL is good for an hour."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp, open(dest, "wb") as out:
            shutil.copyfileobj(resp, out, 1024 * 1024)
    except Exception as e:  # noqa: BLE001 — the message is what the viewer shows
        raise VideoToolError(f"download failed: {e}") from None


def extract_audio(src: str, wav: str) -> None:
    """16 kHz mono PCM, what whisper.cpp reads."""
    _run([config.FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error", "-i", src,
          "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], "audio extraction", 900)


def transcribe(wav: str, language: str) -> list[dict]:
    """whisper-cli writes <wav>.json next to the wav; offsets are milliseconds."""
    _run([config.WHISPER_BIN, "-m", config.WHISPER_MODEL, "-f", wav, "-l", language,
          "-oj", "-of", wav, "-np"], "transcription", 3600)
    try:
        with open(wav + ".json", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise VideoToolError(f"transcription wrote no readable JSON: {e}") from None
    segments = []
    for item in data.get("transcription") or []:
        text = str(item.get("text") or "").strip()
        offsets = item.get("offsets") or {}
        if not text:
            continue
        segments.append({"startMs": int(offsets.get("from", 0)), "endMs": int(offsets.get("to", 0)), "text": text})
    return segments


def pick_frames(src: str, out_dir: str, max_frames: int = 40, threshold: float = 0.3) -> list[dict]:
    """One JPEG per screen change (plus the first frame), at most max_frames,
    spread evenly when ffmpeg finds more. showinfo's pts_time, printed in the
    same order as the files, says which moment each is from."""
    os.makedirs(out_dir, exist_ok=True)
    select = f"select='eq(n\\,0)+gt(scene\\,{threshold})'"
    proc = _run([config.FFMPEG_BIN, "-y", "-hide_banner", "-nostats", "-i", src,
                 "-vf", f"{select},showinfo,scale='min(1280\\,iw)':-2", "-vsync", "vfr", "-q:v", "4",
                 os.path.join(out_dir, "%04d.jpg")], "frame extraction", 1800)
    moments = [int(round(float(m) * 1000)) for m in _SHOWINFO_TIME.findall(proc.stderr or "")]
    files = sorted(f for f in os.listdir(out_dir) if f.endswith(".jpg"))
    frames = [{"index": i + 1, "timeMs": moments[i] if i < len(moments) else 0, "path": os.path.join(out_dir, f)}
              for i, f in enumerate(files)]
    if len(frames) > max_frames:
        step = len(frames) / max_frames
        kept = [frames[int(i * step)] for i in range(max_frames)]
        for f in frames:
            if f not in kept:
                os.remove(f["path"])
        frames = [{**f, "index": i + 1} for i, f in enumerate(kept)]
    return frames


def clock(ms: int) -> str:
    total = max(0, ms // 1000)
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def render_transcript(segments: list[dict]) -> str:
    return "\n".join(f"{clock(s['startMs'])}  {s['text']}" for s in segments)


def render_screens(frames: list[dict]) -> str:
    return "\n".join(f"{f['index']}. {clock(f['timeMs'])} — {f['path']}" for f in frames)


def fill_prompt(prompt: str, transcript_text: str, screens_text: str) -> str:
    """The two placeholders Rivendell leaves for the bridge."""
    return prompt.replace("{{TRANSCRIPT}}", transcript_text).replace("{{SCREENS}}", screens_text or "(none)")


def parse_json_answer(text: str) -> dict | None:
    """Claude's answer as a dict: the first {...} in it, fences or not; None when there is none."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def transcribe_result(language: str, segments: list[dict], frames: list[dict], answer_text: str,
                      transcriber: str = TRANSCRIBER) -> dict:
    """The JSON Rivendell parses (video-result.ts). An unreadable answer leaves
    the summary empty; the transcript and the frames still count."""
    data = parse_json_answer(answer_text) or {}
    captions = {}
    for s in data.get("screens") or []:
        if isinstance(s, dict) and isinstance(s.get("index"), int) and str(s.get("caption") or "").strip():
            captions[s["index"]] = str(s["caption"]).strip()
    return {
        "language": language,
        "transcriber": transcriber,
        "segments": segments,
        "summary": str(data["summary"]).strip() if isinstance(data.get("summary"), str) and data["summary"].strip() else None,
        "chapters": [c for c in (data.get("chapters") or []) if isinstance(c, dict)],
        "keyPoints": [p for p in (data.get("keyPoints") or []) if isinstance(p, str)],
        "screens": [{"index": f["index"], "timeMs": f["timeMs"], "caption": captions.get(f["index"])} for f in frames],
    }
