"""SKILL PATHS: Matt Pocock's skill pack, loaded into every run while the
`router` AI switch is on.

The pack is vendored under bridge/skills/mattpocock instead of installed as a
plugin: one switch turns it on, there is nothing to install per account, and
every account runs the same files. `claude --plugin-dir` loads it per run.

The flag is added inside runner._base_cmd, not passed as extra_args, because
resumed, queued and recovered runs lose extra_args and would drop the pack
mid-session. Checked by hand: when the plugin is also installed, the CLI logs
'from --plugin-dir overrides installed version' and runs one copy, so the
installed one needs no disabling.

The routing instructions ride the system prompt as PACK_TEXT, a constant: the
appended prompt sits after the last cache breakpoint, so text that varied by
turn would re-write the whole block at cache-write price. Whether a session gets
it is decided once per session (pack_for) and kept, like the Rivendell note, so
flipping the switch or a session's origin mid-run can't change a running
session's prompt. Unattended runs (Rivendell jobs, device runs) never get it:
nobody is there to answer a grill or press a step button, so a path would stall.
"""

import os

from bridge import aifeatures, store

PACK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills", "mattpocock")
PLUGIN_ID = "mattpocock-skills@claude-plugins-official"


def on() -> bool:
    return aifeatures.enabled("router")

PACK_TEXT = "\n".join([
    "Skill paths. Matt Pocock's skills are loaded as /mattpocock-skills:<name>.",
    "When a prompt has no /command in front, first decide whether one of these paths fits it:",
    "- feature: a new feature or idea. Start grill-with-docs.",
    "- bug: something broken, failing or slow. Start diagnosing-bugs.",
    "- refactor: tangled code or architecture work. Start improve-codebase-architecture.",
    "- one: research, a prototype, a review, a PR or teaching. Start that one skill (research, prototype, code-review, pr, teach).",
    "If one fits, call SetPath with the path and a one-line why, then start its skill with the Skill tool.",
    "If none fits (a plain question, a small edit, a chat reply), just answer and start nothing.",
    'If the message begins "No path for this message.", start nothing.',
    'When you finish a step of a path and need nothing more from the user, call StepDone. After a grill, pass choice "here" if the work fits this one session, or "tickets" if it needs several. Never call StepDone while waiting on the user.',
    "Tickets: the tracker is local files. Write one ticket per file to .mystical/tickets/<feature-slug>/<NN>-<slug>.md in this checkout, using the local ticket template, numbered from 01 in dependency order. Triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix.",
])

# claude session id -> whether its origin gets the pack, decided at its first run.
_pack_ok: dict[str, bool] = {}


def pack_for(claude_session_id: str) -> str:
    """PACK_TEXT for an attended run of this session while the switch is on, else "".
    The switch is read every run (it applies to the next turn); the origin once."""
    if not on():
        return ""
    if claude_session_id not in _pack_ok:
        try:
            origin = str((store.get_by_claude_session_id(claude_session_id) or {}).get("origin") or "")
        except Exception:  # noqa: BLE001 — the pack never blocks a turn
            origin = ""
        _pack_ok[claude_session_id] = not origin.startswith(("rivendell", "device-run"))
    return PACK_TEXT if _pack_ok[claude_session_id] else ""
