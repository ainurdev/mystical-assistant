"""Stop hook: a turn that ends by offering lettered options in prose is sent back
once to ask them with AskUserQuestion.

Why: every surface draws an AskUserQuestion as a card you tap, with each
option's pictures inside it (its `preview`), while options written as prose
leave you matching screenshot names to letters and typing the answer. The
bridge's system prompt already asks for the card, but a skill read later can
say otherwise and win (superpowers' brainstorming: "A/B/C/D text options"), and
`tool_choice` can't force a tool while thinking is on. A Stop hook is the one
lever that acts after the fact.

What counts: the message ends on a question that asks for a choice ("which",
"prefer", "pick", "choose", "go with", " or ") with at least two option lines
above it, keyed A-D or 1-4. A numbered report that ends "Want me to commit?"
asks for no choice, so it stops as written.

Why only once: `stop_hook_active` is set while Claude is already continuing
because of a Stop hook, and blocking again could loop. Whatever still gets
through, the dashboard's ASK bar turns into chips (web/src/lib/askback.ts).

Stdlib only, run as `python3 -I askhook.py` with the hook's JSON on stdin
(runner._base_cmd wires it into --settings). Any error lets the stop through:
a broken hook must never hold a turn open.
"""

import json
import re
import sys

REASON = (
    "You ended by offering options in prose, so the human has nothing to tap. "
    "Ask that same question with AskUserQuestion: one option per choice, the "
    "one you recommend first. If an option has screenshots, put them in its "
    "preview as markdown images, one per state: ![In the box](/absolute/path.png). "
    "Don't repeat the rest of your message.")

# "A · TOKEN: …", "- **B.** …", "C) …", "Option 2 — …", "1. …"
_OPTION = re.compile(
    r"^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:option\s+)?([a-d]|[1-4])(?:\*\*|__)?\s*(?:[·.):—–-]|\*\*)",
    re.IGNORECASE)
_CHOICE = re.compile(r"\b(?:which|prefer|pick|choose|go with|or)\b", re.IGNORECASE)
_TAIL = 2400   # the options sit right above the question; a long report's top doesn't matter


def offers_choice(text: str) -> bool:
    """Does this message end by asking for a pick among lettered options?"""
    t = (text or "").rstrip().rstrip("*_`)\"' ")
    if not t.endswith("?"):
        return False
    lines = [ln for ln in t[-_TAIL:].splitlines() if ln.strip()]
    if len(lines) < 3 or not _CHOICE.search(lines[-1]):
        return False
    keys = {m.group(1).upper() for ln in lines[:-1] if (m := _OPTION.match(ln))}
    return len(keys) >= 2


def main() -> int:
    try:
        data = json.load(sys.stdin)
        if not data.get("stop_hook_active") and offers_choice(data.get("last_assistant_message") or ""):
            print(json.dumps({"decision": "block", "reason": REASON}))
    except Exception:  # noqa: BLE001 -- a broken hook lets the stop through
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
