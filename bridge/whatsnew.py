"""What changed in Mystical, told in the bell: a changelog row each install writes
at boot from the commits that landed, and a note row for each heading a maintainer
added to docs/notes.md (docs/superpowers/specs/notif-updates.md).

Why each install writes its own row rather than reading a committed CHANGELOG:
the range is known only here (`last_head` → HEAD), every path that moves the
checkout — the UPDATE button, `mystical update`, a hand pull and a restart —
passes through boot, and nobody has to remember to write an entry at merge time.
The cost is one haiku call per restart that found new commits, behind the UPDATE
NOTES switch; off, the row lists the commit subjects instead.

Why a note's heading is its identity: the file is diffed between the old and the
new HEAD, so an edit to a note's body tells nobody again and a changed heading is
a new note. `notes_seen` remembers what this install already showed, because the
feed forgets after a week.

Why SEND NOTE pushes: a local commit on master would make every later PULL &
RESTART (`--ff-only`) fail on an install that cannot push, so a refused push is
rolled back and nothing is left behind.

Best-effort throughout: boot() never blocks start-up — everything after recording
HEAD runs in a daemon thread that prints and never raises.
"""

NOTES_PATH = "docs/notes.md"
NOTES_HEADER = (
    "# Notes for every install\n\n"
    "A heading per note. Each lands in the bell of every Mystical that pulls it\n"
    "(bridge/whatsnew.py). Write one from the bell's Updates tab, or by hand in this shape.\n"
)

import re

# `## 2026-10-18 · Title — Author`; the author is optional. Anything else under a
# `## ` is a hand-written heading: the title whole, no date, no author.
_HEADING = re.compile(r"^(\d{4}-\d{2}-\d{2}) · (.+?)(?: — (.+))?$")


def notes_in(text: str) -> list:
    """The entries of docs/notes.md, in file order: {heading, date, title, author,
    body}. The heading line (without `## `) is the note's identity; the body is
    everything up to the next entry, stripped."""
    out: list = []
    for line in text.splitlines():
        if line.startswith("## "):
            heading = line[3:].strip()
            m = _HEADING.match(heading)
            out.append({"heading": heading, "date": m.group(1) if m else "",
                        "title": (m.group(2) if m else heading).strip(),
                        "author": (m.group(3) or "").strip() if m else "", "body": ""})
        elif out:
            out[-1]["body"] += line + "\n"
    for e in out:
        e["body"] = e["body"].strip()
    return out
