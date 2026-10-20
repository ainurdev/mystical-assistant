"""The Mini App's palettes must not drift from the dashboard's.

bridge/miniapp/web/src/lib/theme.ts is a COPY of the dark AURORA and CLAUDE
colourings in bridge/dashboard/web/src/lib/theme.ts (the source of truth) — the
Mini App is a separate Vite bundle and the dashboard's theme.ts drags in
push/indicator/toolwidget, so the project duplicates it the same way it
duplicates langfor/stick/toolfold.

A copy rots. This checks every token the Mini App carries still holds the hex the
dashboard says it should, so retinting a theme on one side fails loudly here
instead of leaving the phone one release behind.

Run: `python tests/test_miniapp_theme_sync.py`
"""

import os
import re
import sys

from theme_ts import is_light, palettes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DASH = os.path.join(ROOT, "bridge/dashboard/web/src/lib/theme.ts")
MINI = os.path.join(ROOT, "bridge/miniapp/web/src/lib/theme.ts")

# FLINT, PEBBLE and MIDDLE-EARTH are family layers in the dashboard's stylesheet
# (index.css, THE FAMILIES) that the Mini App does not carry, so their colourings
# stay off the phone. MIDDLE-EARTH's keys are its schemes' names.
DASHBOARD_ONLY = ("flint-", "pebble-", "rivendell", "moria", "mordor")


def tokens(body):
    return dict(re.findall(r'"?([\w-]+)"?: "([^"]+)"', body))


def mini_palettes(src):
    out = {}
    for m in re.finditer(r'\{ key: "([\w-]+)".*?pal: \{(.*?)\} \},', src):
        out[m.group(1)] = tokens(m.group(2))
    return out


def main():
    dash_src = open(DASH, encoding="utf-8").read()
    mini_src = open(MINI, encoding="utf-8").read()
    dash = palettes(dash_src)
    mini = mini_palettes(mini_src)

    fails = []
    assert mini, "no themes parsed out of the Mini App's theme.ts"

    for key, pal in mini.items():
        if is_light(key):
            fails.append(f"  {key}: light theme — the Mini App has no "
                         f":root[data-light] re-derivation to carry it")
            continue
        src_pal = dash.get(key)
        if not src_pal:
            fails.append(f"  {key}: no such theme on the dashboard")
            continue
        for token, value in pal.items():
            want = src_pal.get(token)
            if want is None:
                fails.append(f"  {key}.{token}: not a dashboard token")
            elif want != value:
                fails.append(f"  {key}.{token}: {value} != dashboard's {want}")

    # A dashboard dark theme that never reached the phone is drift too.
    dark = {k for k in dash if not is_light(k) and not k.startswith(DASHBOARD_ONLY)}
    missing = dark - set(mini)
    if missing:
        fails.append(f"  dark themes missing from the Mini App: {sorted(missing)}")

    if fails:
        print("FAIL — Mini App palettes have drifted:\n" + "\n".join(fails))
        sys.exit(1)
    print(f"ok — {len(mini)} Mini App themes match the dashboard, token for token")


if __name__ == "__main__":
    main()
