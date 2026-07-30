"""The free-agent rung: opencode, driven headlessly, on a non-Anthropic provider.

`opencode run <prompt> --model <provider>/<model> --auto` is the close analogue of
the bridge's own `claude -p`, which is why one adapter covers every provider
opencode can reach. PROVIDERS is the ladder, free-est first; a provider appears
only when its prerequisite is configured, so a rung is never offered that would
fail at handover time.

Deliberately NOT a second route to a Claude subscription: opencode's own docs
state Anthropic prohibits using Claude Pro/Max from it. This rung exists to keep
working when the Claude accounts are spent, on someone else's models.

A handed-off turn cannot answer permission prompts (there is nobody on the other
end of a card mid-handover), so it runs with --auto inside the session's own
working directory and its output is captured as one assistant message. Switching
to `--format json` for per-tool-call events is a drop-in change to _parse_output
once there is a recorded event stream to test against.
"""

import json
import os
import shutil
import sys

# provider   -- opencode provider id, also the runtime tag stored on the turn
# env        -- the setting that has to be present for this rung to be offered
# model_env  -- optional override of the default model
# label      -- what the approval card calls it
PROVIDERS = (
    {"provider": "zen", "env": "OPENCODE_API_KEY", "model_env": "OPENCODE_ZEN_MODEL",
     "model": "big-pickle", "label": "opencode zen (free)"},
    {"provider": "gemini", "env": "GEMINI_API_KEY", "model_env": "GEMINI_MODEL",
     "model": "gemini-3-flash", "label": "Gemini Flash (free tier)"},
    {"provider": "qwen", "env": "DASHSCOPE_API_KEY", "model_env": "QWEN_MODEL",
     "model": "qwen3-coder-plus", "label": "Qwen Coder"},
    # Local inference has no API key: naming a model is the opt-in.
    {"provider": "ollama", "env": "OLLAMA_MODEL", "model_env": "OLLAMA_MODEL",
     "model": "", "label": "Ollama (local)"},
)

OPENCODE_BIN = os.environ.get("OPENCODE_BIN", "opencode")
_FALLBACKS = ("~/.opencode/bin/opencode", "~/.local/bin/opencode")
_bin: "str | None" = None


def opencode_bin() -> "str | None":
    """Absolute path to the opencode launcher, or None when it isn't installed.
    Resolved like runner.claude_bin(): never trust the ambient PATH, since the
    bridge may run from systemd/cron."""
    global _bin
    if _bin and os.path.exists(_bin):
        return _bin
    if os.sep in OPENCODE_BIN:
        _bin = os.path.expanduser(OPENCODE_BIN)
        return _bin if os.access(_bin, os.X_OK) else None
    found = shutil.which(OPENCODE_BIN)
    if not found:
        for cand in _FALLBACKS:
            cand = os.path.expanduser(cand)
            if os.access(cand, os.X_OK):
                found = cand
                break
    _bin = found
    return _bin


# --- settings ----------------------------------------------------------------
# A provider used to be configurable only through the bridge's own environment,
# which meant editing a service file and restarting to try one out. Keys entered
# in the dashboard land here instead, 0600 beside the account profiles. The
# environment still wins where both are set, so an existing deployment's
# variables keep their meaning.

SETTINGS = os.path.expanduser(
    os.environ.get("FREEAGENTS_FILE", "~/.mystical/freeagents.json"))
SETTABLE = tuple({n for s in PROVIDERS for n in (s["env"], s["model_env"]) if n})


def settings() -> dict:
    try:
        with open(SETTINGS) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items()
            if k in SETTABLE and isinstance(v, str) and v} if isinstance(data, dict) else {}


def set_setting(name: str, value: "str | None") -> None:
    """Save (or, with an empty value, forget) one provider setting."""
    if name not in SETTABLE:
        raise ValueError(f"{name} is not a free-agent setting")
    data = settings()
    value = (value or "").strip()
    if value:
        data[name] = value
    else:
        data.pop(name, None)
    os.makedirs(os.path.dirname(SETTINGS), mode=0o700, exist_ok=True)
    try:
        with open(SETTINGS, "w") as f:
            json.dump(data, f, indent=2)
        os.chmod(SETTINGS, 0o600)              # it holds API keys
    except OSError as e:
        print(f"[freeagent] persist failed: {e}", file=sys.stderr)


def _value(name: str) -> str:
    return os.environ.get(name) or settings().get(name) or ""


def run_env() -> dict:
    """Environment for the opencode subprocess: the bridge's own, plus the keys
    saved from the dashboard, which it can only read as variables. Saved keys
    fill gaps only -- the same precedence _value() reports, so the rung that was
    offered is the one that runs."""
    saved = {k: v for k, v in settings().items() if not os.environ.get(k)}
    return {**os.environ, **saved}


def available() -> list:
    """Configured free providers, free-est first. Empty when opencode is absent."""
    if not opencode_bin():
        return []
    out = []
    for spec in PROVIDERS:
        if not _value(spec["env"]):
            continue
        model = _value(spec["model_env"] or "") or spec["model"]
        if not model:
            continue
        out.append({"provider": spec["provider"], "model": model,
                    "label": spec["label"]})
    return out


def status() -> dict:
    """Every rung and what it still needs, for the settings UI. A provider whose
    only missing piece is a key is worth showing greyed-out with the box to type
    it into -- that is the whole difference between 'set an env var somewhere'
    and 'set it up here'."""
    ready = {p["provider"] for p in available()}
    rows = []
    for spec in PROVIDERS:
        saved = spec["env"] in settings()
        rows.append({
            "provider": spec["provider"], "label": spec["label"],
            "env": spec["env"], "model_env": spec["model_env"],
            "model": _value(spec["model_env"] or "") or spec["model"],
            # Ollama names a local model instead of authenticating, so the box
            # asks for a model there and a key everywhere else.
            "needs": "model" if spec["env"] == spec["model_env"] else "key",
            "configured": bool(_value(spec["env"])),
            "source": "env" if os.environ.get(spec["env"]) else ("saved" if saved else None),
            "ready": spec["provider"] in ready,
        })
    return {"installed": bool(opencode_bin()), "providers": rows}


def build_cmd(prompt: str, provider: dict, session: "str | None",
              cwd: "str | None") -> list:
    cmd = [opencode_bin() or OPENCODE_BIN, "run", prompt,
           "--model", f"{provider['provider']}/{provider['model']}",
           "--auto"]
    if session:
        cmd += ["--session", session]
    if cwd:
        cmd += ["--dir", cwd]
    return cmd


def briefing(task: str, recent: list) -> str:
    """What the free agent is told on takeover. It cannot read Claude's
    transcript (different runtime, different session store), so the task and a
    summary of what already happened travel in the prompt."""
    done = "\n".join(f"- {line}" for line in recent) if recent else "- (nothing yet)"
    return (f"You are taking over a task in progress from another agent that ran "
            f"out of usage quota.\n\nTASK:\n{task}\n\nALREADY DONE:\n{done}\n\n"
            f"Continue from there. Do not start over, and do not redo finished "
            f"work. Verify the repository's current state before changing it.")
