"""Read the dashboard's theme palettes out of lib/theme.ts the way it builds them.

theme.ts keeps each family's palettes as GROUNDS (`const NAME: Record<string,
string> = { ...BASE, token: "value", ... };`) and ROWS (`["key", "NAME", "feel",
GROUND, { acc: "...", ask: "..." }],`), one per line, and the dashboard spreads
roles over ground. This does the same spread, so the palette tests check the
colours the browser actually gets. Shared by test_light_theme_contrast.py and
test_miniapp_theme_sync.py.
"""

import re

GROUND = re.compile(r"const ([A-Z_]+): Record<string, string> = \{(.*?)\};", re.S)
ROW = re.compile(r'\["([\w-]+)", "[^"]*", "[^"]*", ([A-Z_]+), \{(.*?)\}\],')
TOKEN = re.compile(r'"?([\w-]+)"?: "([^"]+)"')


def palettes(src):
    """{theme key: {token: value}} for every row in theme.ts."""
    grounds = {}
    for name, body in GROUND.findall(src):
        pal = {}
        for base in re.findall(r"\.\.\.([A-Z_]+)", body):
            pal.update(grounds[base])
        pal.update(TOKEN.findall(body))
        grounds[name] = pal
    out = {}
    for key, ground, roles in ROW.findall(src):
        pal = {**grounds[ground], **dict(TOKEN.findall(roles))}
        acc = pal["acc"]
        pal["accent-rgb"] = " ".join(str(int(acc[i:i + 2], 16)) for i in (1, 3, 5))
        out[key] = pal
    return out


def is_light(key):
    """A light ground is `<colouring>-light` (theme.ts isLight)."""
    return key.endswith("-light")
