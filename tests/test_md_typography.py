"""Response typography: the lead-in rule, and the accent tokens the .md block asks for.

Two things in `HANDOFF.md §8` fail silently rather than loudly, so they are
checked here instead of by eye.

The lead-in rule is the only judgement call in `Markdown.tsx`: a **bold** that is
short, single-line and ends in a colon stops being emphasis and becomes a tracked
label. Widen it and `**72 passed, 1 failed**` turns into a heading; narrow it and
`**Root cause:**` loses its rank. The regex is read out of the component so the
cases below are testing what actually ships.

The token check exists because `--ac-20` — asked for in three places, defined in
none — spent its whole life resolving to currentColor, and the moment it was
folded into a `border:` shorthand the border vanished entirely. An undefined
`--ac-NN` is invalid at computed-value time: no console error, no visible cause.

Run: `python3 tests/test_md_typography.py`
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SURFACES = {
    "dashboard": ("bridge/dashboard/web/src/components/Markdown.tsx",
                  "bridge/dashboard/web/src/index.css"),
    "miniapp": ("bridge/miniapp/web/src/components/Markdown.tsx",
                "bridge/miniapp/web/src/index.css"),
}
MD_TSX, CSS = (os.path.join(ROOT, f) for f in SURFACES["dashboard"])

# (bold text as authored, is it a lead-in label?)
CASES = [
    ("Root cause:", True),
    ("Fix:", True),
    ("Verified:", True),
    ("Tests:", True),
    # No colon — a result, not a label. This is the case the bound is for.
    ("72 passed, 1 failed", False),
    ("-129/+17 lines", False),
    # Ends in a colon but is a clause, not a label.
    ("Everything below this line is provisional and may change:", False),
    # A colon alone, or one leading character, is not a label either.
    (":", False),
    ("A:", False),
    # The label treatment is for one line; a wrapped bold keeps the wash.
    ("Root\ncause:", False),
]


def lead_re(tsx):
    """The lead-in regex exactly as that surface's Markdown.tsx ships it."""
    src = open(os.path.join(ROOT, tsx), encoding="utf-8").read()
    m = re.search(r"const LEAD_RE = /(.+?)/;", src)
    assert m, f"LEAD_RE is gone from {tsx} — did the lead-in rule move?"
    return re.compile(m.group(1))


def test_lead_in_rule():
    """Both surfaces, because the same reply has to read the same on each."""
    bad = []
    for surface, (tsx, _css) in SURFACES.items():
        rx = lead_re(tsx)
        bad += [
            f"  {surface} {text!r}: {'kept the wash' if want else 'became a label'}"
            for text, want in CASES
            if bool(rx.match(text)) is not want
        ]
    assert not bad, "lead-in rule misclassifies:\n" + "\n".join(bad)


def test_lead_in_is_applied():
    """The regex is only half of it — the class has to reach the element."""
    for surface, (tsx, css) in SURFACES.items():
        src = open(os.path.join(ROOT, tsx), encoding="utf-8").read()
        assert "LEAD_RE.test(textOf(children))" in src, f"{surface}: LEAD_RE never tested against a bold"
        assert '"md-lead"' in src, f"{surface}: nothing applies the md-lead class"
        assert ".md strong.md-lead" in open(os.path.join(ROOT, css), encoding="utf-8").read(), \
            f"{surface}: md-lead has no style"


def test_accent_tokens_are_defined():
    """Every --ac-NN index.css uses is one index.css also defines."""
    css = open(CSS, encoding="utf-8").read()
    defined = set(re.findall(r"(--ac-\d+)\s*:", css))
    used = set(re.findall(r"var\((--ac-\d+)", css))
    missing = sorted(used - defined)
    assert not missing, f"index.css uses undefined accent tokens: {missing} (defined: {sorted(defined)})"


def test_measure_bounds_exist():
    css = open(CSS, encoding="utf-8").read()
    for token in ("--md-measure", "--md-wide"):
        assert re.search(rf"{token}\s*:\s*\d+em", css), f"{token} is not defined in em"
    # A table has to be free to outgrow its wrapper, or the wrapper's
    # overflow-x has nothing to scroll (HANDOFF §8, the wide-table check).
    test_tables_can_outgrow_their_wrapper()


def test_tables_can_outgrow_their_wrapper():
    """Both surfaces: `overflow-x` on the wrapper has nothing to scroll if the
    table is capped at 100% of it — it squeezes cells into stacks instead."""
    for surface, (_tsx, path) in SURFACES.items():
        table = re.search(r"^\.md table \{([^}]*)\}", open(os.path.join(ROOT, path), encoding="utf-8").read(), re.M)
        assert table, f"{surface}: .md table rule is gone"
        assert "max-width" not in table.group(1), \
            f"{surface}: .md table caps its own width — wide tables will squeeze, not scroll"


if __name__ == "__main__":
    fails = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as e:
                fails.append(f"FAIL {name}: {e}")
    for f in fails:
        print(f)
    sys.exit(1 if fails else 0)
