"""The light grounds' ink tiers must stay legible.

The light palettes in the dashboard's theme.ts (CLAUDE's paper, FLINT's
daylight, every colouring on them) are hand-authored hex, so a retint can
silently drop caption text (`--txl` alone is used 100+ times at 8-10px) to a
washed-out grey. This reads theme.ts and checks every text tier and every colour
used as text against WCAG contrast floors on that theme's own canvas.

Run: `python tests/test_light_theme_contrast.py`
"""

import os
import re
import sys

from theme_ts import is_light, palettes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THEME_TS = os.path.join(ROOT, "bridge/dashboard/web/src/lib/theme.ts")
INDEX_CSS = os.path.join(ROOT, "bridge/dashboard/web/src/index.css")

# Structural edges, read out of index.css's `:root[data-light]` block and mixed
# against the theme's own palette. These are what a light ground uses instead of
# glow, so they have to be SEEN: the pre-fix values (an alpha wash of the accent
# over `transparent`) landed at ~1.05 on white, i.e. no visible edge at all,
# which is what made the dashboard read as one flat white sheet.
EDGE_FLOORS = {"border": 1.3, "input": 1.35, "border-bright": 2.0}

# Ink tiers, brightest to faintest. `txg` is the decorative ghost tier (line
# numbers, empty states) — held to the 3:1 large-text floor, not 4.5:1.
INK_FLOORS = {
    "txb": 14.0, "txh": 11.0, "tx": 9.0, "txm": 7.0,
    "txd": 5.8, "txf": 5.2, "txl": 4.7, "txg": 3.25,
}
# Semantic colours that appear as text somewhere; the `-g` ghosts get 3:1.
SEMANTIC_FLOOR = 4.45
GHOST_FLOOR = 3.25

# The grounds the light colourings sit on — each its family's DARKEST light stop,
# below `panel`, so clearing this clears every surface.
CANVAS = {"claude": "#efede5", "flint": "#ebebed"}

# The light ground has to stay a GROUND, not a spotlight: `panel` is the raised
# card and `canvas` sits below it, so the biggest surface is never the brightest.
# (A white canvas with white panels is the "whole screen is too white" failure.)
LADDER = ("canvas", "panel3", "panel2", "panel")
MIN_LADDER_STEP = 1.008  # each rung measurably lighter than the one below

# Themes whose semantics must be TELLABLE APART, not one hue in six shades:
# your colour is never a warning's. Exempt on purpose: the claude-* set (its
# brand clay sits ~7 degrees off its err salmon, and LIBRARY's gold is the
# warning's), VIRIDIAN (green phosphor: go and good are one word, as FERN's),
# and FLINT SUNSET (warm by design, its orange leans on err's red).
COLORFUL = ["aqua", "amber", "magenta", "blueprint", "void",
            "flint-ember", "flint-fuchsia", "flint-kiln", "flint-cobalt", "flint-nocturne", "flint-signal",
            "flint-ember-light", "flint-fuchsia-light", "flint-kiln-light", "flint-cobalt-light",
            "flint-nocturne-light", "flint-signal-light"]
HUE_KEYS = ["acc", "ok", "warn", "err", "info", "purple"]
MIN_HUE_GAP = 20.0   # degrees between any two saturated semantics
MIN_SAT = 0.16       # below this a colour is neutral ink, so it has no hue to space
MIN_COLORFUL = 4     # ... and each theme needs at least this many that do


def hue_sat(hex_color):
    """(hue in degrees, HSV saturation) for a hex colour."""
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    mx, mn = max(r, g, b), min(r, g, b)
    span = mx - mn
    if not span:
        return 0.0, 0.0
    if mx == r:
        h = 60 * (((g - b) / span) % 6)
    elif mx == g:
        h = 60 * ((b - r) / span + 2)
    else:
        h = 60 * ((r - g) / span + 4)
    return h, span / mx


def hue_gap(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def _lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_color):
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def light_edges(css):
    """{token: (srcA, pct, srcB)} for the `color-mix` edges in :root[data-light]."""
    block = re.search(r":root\[data-light\] \{(.*?)\n\}", css, re.S).group(1)
    out = {}
    for token, a, pct, b in re.findall(
        r"--([\w-]+): color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, var\(--([\w-]+)\)\)",
        block,
    ):
        out[token] = (a, int(pct), b)
    return out


def mix(a, b, pct):
    """sRGB mix of `pct`% a into b — what the browser does for color-mix(srgb)."""
    av = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    bv = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    t = pct / 100
    return "#%02x%02x%02x" % tuple(round(x * t + y * (1 - t)) for x, y in zip(av, bv))


def main():
    src = open(THEME_TS, encoding="utf-8").read()

    assert "adventure" not in src, "the ADVENTURE theme was removed"

    pals = palettes(src)
    light_keys = [k for k in pals if is_light(k)]
    assert len(light_keys) == 13, f"expected CLAUDE's 6 + FLINT's 7 light colourings: {light_keys}"

    css = open(INDEX_CSS, encoding="utf-8").read()
    edges = light_edges(css)
    missing = set(EDGE_FLOORS) - set(edges)
    assert not missing, f"index.css :root[data-light] no longer sets {missing}"

    # Elevation ink is 62-78% BLACK on the dark ground; if light ever stops
    # overriding it, every modal gets a grime halo instead of a lift.
    light_block = re.search(r":root\[data-light\] \{(.*?)\n\}", css, re.S).group(1)
    for tok in ("--shadow-pop", "--shadow-modal"):
        assert f"{tok}: color-mix" in light_block, f"light ground must retint {tok}"

    fails = []
    grounds = ("acc-on", "panel", "panel2", "panel3", "canvas")
    for key in light_keys:
        pal = pals[key]
        bg = CANVAS[key.split("-")[0]]
        assert pal.get("canvas") == bg, f"{key}: pal canvas {pal.get('canvas')} != {bg}"
        for token, value in pal.items():
            if not value.startswith("#"):
                continue  # a font stack or the rgb triplet
            floor = INK_FLOORS.get(
                token, GHOST_FLOOR if token.endswith("-g") else SEMANTIC_FLOOR)
            if token in grounds:
                continue  # grounds, not ink
            got = contrast(value, bg)
            if got < floor:
                fails.append(f"  {key}.{token} {value} on {bg}: {got:.2f} < {floor}")
        # White-ish text on the accent fill has to work too.
        on_acc = contrast(pal["acc-on"], pal["acc"])
        if on_acc < SEMANTIC_FLOOR:
            fails.append(f"  {key}: acc-on on acc: {on_acc:.2f} < {SEMANTIC_FLOOR}")
        # The surface ladder has to actually climb.
        for lo, hi in zip(LADDER, LADDER[1:]):
            if luminance(pal[hi]) + 0.05 < (luminance(pal[lo]) + 0.05) * MIN_LADDER_STEP:
                fails.append(f"  {key}: {hi} {pal[hi]} is not above {lo} {pal[lo]}")
        # ... and the edges drawn on the card have to be visible against it.
        for token, floor in EDGE_FLOORS.items():
            src_a, pct, src_b = edges[token]
            edge = mix(pal[src_a], pal[src_b], pct)
            got = contrast(edge, pal["panel"])
            if got < floor:
                fails.append(f"  {key}.--{token} {edge} on panel {pal['panel']}: "
                             f"{got:.2f} < {floor}")

    # Every colourful theme's semantics must be distinguishable hues.
    for key in COLORFUL:
        pal = pals.get(key)
        assert pal, f"no pal{{}} parsed for {key}"
        hues = {k: hue_sat(pal[k]) for k in HUE_KEYS}
        spaced = {k: h for k, (h, s) in hues.items() if s >= MIN_SAT}
        if len(spaced) < MIN_COLORFUL:
            fails.append(
                f"  {key}: only {len(spaced)} saturated semantics "
                f"({', '.join(sorted(spaced)) or 'none'}) < {MIN_COLORFUL}")
        items = sorted(spaced.items())
        for i, (ka, ha) in enumerate(items):
            for kb, hb in items[i + 1:]:
                gap = hue_gap(ha, hb)
                if gap < MIN_HUE_GAP:
                    fails.append(
                        f"  {key}: {ka} {pal[ka]} and {kb} {pal[kb]} are the same "
                        f"hue ({gap:.0f} deg apart < {MIN_HUE_GAP})")

    if fails:
        print("FAIL — theme palette below floor:\n" + "\n".join(fails))
        sys.exit(1)
    print(f"ok — {len(light_keys)} light colourings clear every ink floor and climb "
          f"their surface ladder; {len(COLORFUL)} themes have distinct semantics")


if __name__ == "__main__":
    main()
