"""The Mini App's palettes must not drift from the dashboard's.

bridge/miniapp/web/src/lib/theme.ts is a COPY of the dark half of
bridge/dashboard/web/src/lib/theme.ts (the source of truth) — the Mini App is a
separate Vite bundle and the dashboard's theme.ts drags in nyan/piano/push/songs,
so the project duplicates it the same way it duplicates langfor/stick/toolfold.

A copy rots. This checks every token the Mini App carries still holds the hex the
dashboard says it should, so retinting a theme on one side fails loudly here
instead of leaving the phone one release behind.

Run: `python tests/test_miniapp_theme_sync.py`
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DASH = os.path.join(ROOT, "bridge/dashboard/web/src/lib/theme.ts")
MINI = os.path.join(ROOT, "bridge/miniapp/web/src/lib/theme.ts")

# AURORA's four carry no pal{} on the dashboard — they recolour through a CSS
# filter, which the Mini App does not do (see the header comment in its
# theme.ts). Their Mini App pals are an accent approximation with no dashboard
# counterpart, so they are checked for shape only, not for equality.
FILTER_KEYS = {"aqua", "green", "amber", "magenta"}
ACCENT_ONLY = {"acc", "accent-rgb", "tx", "txb"}


def tokens(body):
    return dict(re.findall(r'"?([\w-]+)"?: "([^"]+)"', body))


def dash_palettes(src):
    """{key: {token: value}} for the dashboard, including the generated CLAUDE set."""
    out = {}
    for m in re.finditer(r'\{ key: "([\w-]+)".*?pal: \{(.*?)\} \}', src):
        out[m.group(1)] = tokens(m.group(2))
    # CLAUDE's four are built by .map() over one shared palette, so they are not
    # literal in the source the regex above walks.
    base = tokens(re.search(r"const CLAUDE_PAL[^=]*= \{(.*?)\};", src, re.S).group(1))
    for key, _name, _feel, acc in re.findall(
        r'\["([\w-]+)", "([^"]+)", "([^"]+)", "(#[0-9a-f]{6})"\]', src
    ):
        rgb = " ".join(str(int(acc[i:i + 2], 16)) for i in (1, 3, 5))
        out[key] = {**base, "acc": acc, "accent-rgb": rgb}
    return out


def mini_palettes(src):
    out = {}
    for m in re.finditer(r'\{ key: "([\w-]+)".*?pal: \{(.*?)\} \},', src):
        out[m.group(1)] = tokens(m.group(2))
    return out


def main():
    dash_src = open(DASH, encoding="utf-8").read()
    mini_src = open(MINI, encoding="utf-8").read()
    dash = dash_palettes(dash_src)
    mini = mini_palettes(mini_src)

    light = re.findall(
        r'"([\w-]+)"',
        re.search(r"LIGHT_KEYS: ThemeKey\[\] = \[(.*?)\]", dash_src).group(1),
    )

    fails = []
    assert mini, "no themes parsed out of the Mini App's theme.ts"

    for key, pal in mini.items():
        if key in FILTER_KEYS:
            # aqua IS the index.css base, so an empty pal is correct for it.
            extra = set(pal) - ACCENT_ONLY
            if extra:
                fails.append(f"  {key}: filter theme carries {sorted(extra)}, "
                             f"expected only {sorted(ACCENT_ONLY)}")
            continue
        if key in light:
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
    dark = {k for k in dash if k not in light} | FILTER_KEYS
    missing = dark - set(mini)
    if missing:
        fails.append(f"  dark themes missing from the Mini App: {sorted(missing)}")

    if fails:
        print("FAIL — Mini App palettes have drifted:\n" + "\n".join(fails))
        sys.exit(1)
    print(f"ok — {len(mini)} Mini App themes match the dashboard "
          f"({len(mini) - len(FILTER_KEYS)} full palettes, "
          f"{len(FILTER_KEYS)} accent-only)")


if __name__ == "__main__":
    main()
