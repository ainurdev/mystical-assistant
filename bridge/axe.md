# Vendored: axe-core

`axe.min.js` is [axe-core](https://github.com/dequelabs/axe-core) **4.14.1**, unchanged,
from the npm package. `bridge/design_audit.py` injects it at each width `inspect_ui`
checks and runs the WCAG 2.x A and AA rules.

Licence: MPL-2.0 (`axe.LICENSE`); the code bundled inside it is listed in
`axe.LICENSE-3RD-PARTY`.

## Refresh

```sh
d=$(mktemp -d) && (cd "$d" && npm pack axe-core@<version> && tar xzf axe-core-*.tgz)
cp "$d/package/axe.min.js" bridge/axe.min.js
cp "$d/package/LICENSE" bridge/axe.LICENSE
cp "$d/package/LICENSE-3RD-PARTY.txt" bridge/axe.LICENSE-3RD-PARTY
```

Check its hash against the package's `sri-history.json` entry for that version, update the
version above, and run `python3 -m pytest tests/test_design_board.py -q -k axe`: its
real-browser test fails when the new file doesn't load or its rule names changed.
