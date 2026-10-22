"""Picture choices: an AskUserQuestion option carries its own screenshots (its
`preview`), and options offered as prose get sent back once to be asked as a
card. Spec: .mystical/design-drafts/picture-choices/SPEC.md.
Run: python -m pytest tests/test_picture_choices.py -q"""

import json
import os
import shlex
import subprocess
import sys
import tempfile

from bridge import askhook, config, runner

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

SLASH_PROSE = """Drew three directions on the live box, in your FLINT EMBER.

- **A · TOKEN** (recommended): the command becomes one chip inside your words.
- **B · HEADER**: a band on top of the box says what the command does.
- **C · SEGMENT**: the command becomes the prompt itself, a solid segment.

Which direction do you want?"""


def _png(name="a.png"):
    p = os.path.join(tempfile.mkdtemp(prefix="pc-"), name)
    with open(p, "wb") as f:
        f.write(PNG)
    return p


# --- the Stop hook's reading -------------------------------------------------

def test_lettered_options_under_a_choice_question_are_caught():
    assert askhook.offers_choice(SLASH_PROSE)
    assert askhook.offers_choice("Two ways:\n\nA) Redis, fast\nB) SQLite, simple\n\nWhich one?")
    assert askhook.offers_choice("1. keep the cache\n2. drop it\n\nShould I keep it or drop it?")
    assert askhook.offers_choice("**Option 1 —** rail\n**Option 2 —** grid\n\nWhich do you prefer?**")


def test_a_report_that_asks_no_choice_stops_as_written():
    report = "Done.\n\n1. Fixed the parser\n2. Added a test\n\nWant me to commit?"
    assert not askhook.offers_choice(report)                      # no choice asked
    assert not askhook.offers_choice(SLASH_PROSE.rsplit("\n", 1)[0])   # no closing question
    assert not askhook.offers_choice("A) one thing\n\nWhich do you want?")   # one option
    assert not askhook.offers_choice("A plugin's command is next. Which file?")  # "A " is not a key
    assert not askhook.offers_choice("")


def _hook(stdin: str) -> "tuple[int, str]":
    p = subprocess.run([sys.executable, "-I", askhook.__file__], input=stdin,
                       capture_output=True, text=True, timeout=20)
    return p.returncode, p.stdout.strip()


def test_the_hook_blocks_once_then_lets_the_stop_through():
    code, out = _hook(json.dumps({"last_assistant_message": SLASH_PROSE}))
    assert code == 0 and json.loads(out) == {"decision": "block", "reason": askhook.REASON}
    code, out = _hook(json.dumps({"last_assistant_message": SLASH_PROSE, "stop_hook_active": True}))
    assert code == 0 and out == ""


def test_a_broken_hook_input_never_holds_the_turn():
    assert _hook("not json") == (0, "")
    assert _hook(json.dumps({"last_assistant_message": None})) == (0, "")


# --- the run's argv and env --------------------------------------------------

def test_runs_are_told_options_can_carry_a_preview():
    assert runner._run_env(None)["CLAUDE_CODE_QUESTION_PREVIEW_FORMAT"] == "markdown"


def _settings(cmd):
    return json.loads(cmd[cmd.index("--settings") + 1]) if "--settings" in cmd else None


def test_an_interactive_run_gets_the_stop_hook():
    cmd = runner._base_cmd("hi", 555, stream=True, interactive=True,
                           claude_session_id="c-pc", cwd=tempfile.mkdtemp())
    stop = _settings(cmd)["hooks"]["Stop"][0]["hooks"][0]
    assert stop["type"] == "command"
    assert shlex.split(stop["command"])[1:] == ["-I", os.path.join(runner._REPO_ROOT, "bridge", "askhook.py")]


def test_no_stop_hook_where_nobody_can_answer_a_card():
    plain = runner._base_cmd("hi", 555, stream=False, cwd=tempfile.mkdtemp())
    one_shot = runner._base_cmd("hi", 555, stream=True, interactive=True,
                                cwd=tempfile.mkdtemp(), skip_pack=True)
    assert _settings(plain) is None and _settings(one_shot) is None


def test_every_settings_a_run_collects_goes_in_as_one():
    cmd = ["claude", "-p", "--settings", '{"hooks": {"Stop": [1]}}', "--model", "x",
           "--settings", '{"hooks": {"Stop": [2], "PreToolUse": [3]}, "permissions": {"ask": ["m"]}}']
    out = runner._one_settings(cmd)
    assert out.count("--settings") == 1 and out[:4] == ["claude", "-p", "--model", "x"]
    assert _settings(out) == {"hooks": {"Stop": [1, 2], "PreToolUse": [3]}, "permissions": {"ask": ["m"]}}
    assert runner._one_settings(["claude"]) == ["claude"]
    # A settings *file* isn't JSON: it is passed on, not folded.
    assert runner._one_settings(["claude", "--settings", "/x.json"]) == ["claude", "--settings", "/x.json"]


# --- an option's pictures reach the card -------------------------------------

def _q(*previews):
    return [{"question": "Which look?", "header": "Direction",
             "options": [{"label": f"{k} · X", "preview": p} for k, p in zip("ABC", previews)]}]


def test_preview_images_are_copied_into_the_runs_uploads():
    a, b = _png("a.png"), _png("a.png")      # same name, different files
    got = runner._adopt_preview_images("job_pc", "req/1", _q(
        f"![In the box]({a})\n![Sent](<{b}>)", "no picture here"))
    pv = got[0]["options"][0]["preview"]
    up = os.path.join(config.UPLOAD_DIR, "job_pc") + os.sep
    paths = [line.split("](")[1].rstrip(")") for line in pv.splitlines()]
    assert pv.startswith("![In the box](") and "\n![Sent](" in pv
    assert all(p.startswith(up) and os.path.isfile(p) for p in paths)
    assert len(set(paths)) == 2 and all("req1-" in os.path.basename(p) for p in paths)
    assert got[0]["options"][1]["preview"] == "no picture here"
    assert os.path.isfile(a)                     # copied, not moved: the file is not ours


def test_anything_that_is_not_a_local_image_stays_as_written():
    txt = os.path.join(tempfile.mkdtemp(), "notes.txt")
    open(txt, "w").close()
    previews = (f"![x]({txt})", "![x](/no/such/shot.png)", "![x](relative/shot.png)")
    assert runner._adopt_preview_images("job_pc2", "r", _q(*previews)) == _q(*previews)
    plain = [{"question": "?", "header": "H", "options": [{"label": "A"}]}, "junk"]
    assert runner._adopt_preview_images("job_pc2", "r", plain) == plain
    assert runner._adopt_preview_images("job_pc2", "r", None) is None


def test_the_card_and_the_event_carry_the_copies():
    a = _png("shot.png")
    job = runner.Job("job_pc3", 555)
    runner._handle_control_request(job, {"request_id": "rq", "request": {
        "subtype": "can_use_tool", "tool_name": "AskUserQuestion",
        "input": {"questions": _q(f"![1]({a})", f"![1]({a})")}}})
    ev = [e for e in job.events if e["type"] == "question"][0]
    for qs in (ev["questions"], job.pending[0]["questions"]):
        for o in qs[0]["options"]:
            assert o["preview"].startswith(f"![1]({os.path.join(config.UPLOAD_DIR, 'job_pc3')}")
