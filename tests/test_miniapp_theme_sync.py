"""The Mini App's palettes must not drift from the dashboard's.

bridge/miniapp/web/src/lib/theme.ts carries a COPY of the palette block in
bridge/dashboard/web/src/lib/theme.ts (the source of truth) — every family, both
grounds — because the Mini App is a separate Vite bundle and the dashboard's
theme.ts drags in push/indicator/toolwidget, the same way the project duplicates
langfor/stick/toolfold.

A copy rots. Both files are read with the one parser (theme_ts.palettes) and
must agree colouring for colouring, token for token, and on each family's type,
corners and effects — so retinting a theme on one side fails loudly here instead
of leaving the phone one release behind.

Run: `python tests/test_miniapp_theme_sync.py`
"""

import os
import re
import sys

from theme_ts import palettes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DASH = os.path.join(ROOT, "bridge/dashboard/web/src/lib/theme.ts")
MINI = os.path.join(ROOT, "bridge/miniapp/web/src/lib/theme.ts")

FAMILY = re.compile(r"const FAMILY: Record<Family.*?\n\};", re.S)


def main():
    dash_src = open(DASH, encoding="utf-8").read()
    mini_src = open(MINI, encoding="utf-8").read()
    dash = palettes(dash_src)
    mini = palettes(mini_src)

    fails = []
    assert mini, "no themes parsed out of the Mini App's theme.ts"

    for key in sorted(set(dash) | set(mini)):
        if key not in mini:
            fails.append(f"  {key}: on the dashboard, missing from the Mini App")
        elif key not in dash:
            fails.append(f"  {key}: in the Mini App, no such theme on the dashboard")
        elif mini[key] != dash[key]:
            for token in sorted(set(dash[key]) | set(mini[key])):
                if dash[key].get(token) != mini[key].get(token):
                    fails.append(f"  {key}.{token}: {mini[key].get(token)} != dashboard's {dash[key].get(token)}")

    fd, fm = FAMILY.search(dash_src), FAMILY.search(mini_src)
    if not fd or not fm:
        fails.append("  FAMILY table not found in one of the files")
    elif fd.group(0) != fm.group(0):
        fails.append("  FAMILY table (font / corners / effects per family) differs")

    if fails:
        print("FAIL — Mini App palettes have drifted:\n" + "\n".join(fails))
        sys.exit(1)
    print(f"ok — {len(mini)} Mini App themes match the dashboard, token for token")


def test_miniapp_theme_sync():
    main()


if __name__ == "__main__":
    main()
