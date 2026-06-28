"""Native-transcript fidelity: recover per-turn cost (from usage tokens) and
elapsed (from timestamps), and normalize the model to its short family, so an
adopted VS Code session reports the same metrics as a bridge-run one instead of
$0 / blank / a long model string.
Run: `python tests/test_native_fidelity.py`
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import transcript_jsonl as tj  # noqa: E402


def _write(records):
    path = os.path.join(tempfile.mkdtemp(), "s.jsonl")
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    return path


def _turn(records):
    return tj.parse_jsonl(_write(records))["turns"][0]


def test_cost_recovered_from_usage_tokens():
    t = _turn([
        {"type": "user", "cwd": "/x", "uuid": "u",
         "message": {"role": "user", "content": "hi"}},
        {"type": "assistant", "uuid": "a",
         "message": {"role": "assistant", "model": "claude-opus-4-20260101",
                     "usage": {"input_tokens": 1000, "output_tokens": 500,
                               "cache_creation_input_tokens": 0,
                               "cache_read_input_tokens": 0},
                     "content": [{"type": "text", "text": "ok"}]}},
    ])
    # opus list price 15/Mtok in, 75/Mtok out -> (1000*15 + 500*75)/1e6 = 0.0525
    assert abs(t["cost"] - 0.0525) < 1e-9


def test_model_normalized_to_family():
    t = _turn([
        {"type": "user", "cwd": "/x", "uuid": "u",
         "message": {"role": "user", "content": "hi"}},
        {"type": "assistant", "uuid": "a",
         "message": {"role": "assistant", "model": "claude-sonnet-4-6-20260101",
                     "content": [{"type": "text", "text": "ok"}]}},
    ])
    assert t["model"] == "sonnet"


def test_elapsed_from_timestamps():
    t = _turn([
        {"type": "user", "cwd": "/x", "uuid": "u", "timestamp": "2026-01-01T00:00:00Z",
         "message": {"role": "user", "content": "hi"}},
        {"type": "assistant", "uuid": "a", "timestamp": "2026-01-01T00:00:12Z",
         "message": {"role": "assistant", "model": "claude-haiku",
                     "content": [{"type": "text", "text": "ok"}]}},
    ])
    assert t["elapsed"] == 12


def test_no_usage_leaves_cost_none():
    t = _turn([
        {"type": "user", "cwd": "/x", "uuid": "u",
         "message": {"role": "user", "content": "hi"}},
        {"type": "assistant", "uuid": "a",
         "message": {"role": "assistant", "model": "claude-opus",
                     "content": [{"type": "text", "text": "ok"}]}},
    ])
    assert t["cost"] is None


def test_cache_tokens_included_in_cost():
    t = _turn([
        {"type": "user", "cwd": "/x", "uuid": "u",
         "message": {"role": "user", "content": "hi"}},
        {"type": "assistant", "uuid": "a",
         "message": {"role": "assistant", "model": "claude-sonnet-4",
                     "usage": {"input_tokens": 0, "output_tokens": 0,
                               "cache_creation_input_tokens": 1_000_000,
                               "cache_read_input_tokens": 1_000_000},
                     "content": [{"type": "text", "text": "ok"}]}},
    ])
    # sonnet cache_write 3.75/Mtok + cache_read 0.30/Mtok = 4.05 for 1M each
    assert abs(t["cost"] - 4.05) < 1e-6


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
