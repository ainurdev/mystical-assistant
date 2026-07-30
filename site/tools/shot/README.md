# shot — the dashboard screenshots

`public/shots/*.png` are real captures of the running dashboard, not mockups. They
go stale the moment the UI moves, so this is how to re-take them.

`shot.py` is a headless-Chrome screenshotter that talks CDP. Chrome's own
`--screenshot` flag waits for the network to go quiet, and the dashboard holds an
SSE stream open for as long as it's up, so that flag never returns on it — hence
the protocol.

## Re-taking them

The bridge has to be running, and the shots are only as interesting as what's on
screen: a session mid-turn beats an idle one.

```bash
cd site
BASE='http://127.0.0.1:8790/?skipboot=1'   # add &token=… if DASH_TOKEN is set
DEMO="$(cat tools/shot/demo.js)"

# the main view
python3 tools/shot/shot.py --url "$BASE" --out public/shots/dashboard.png \
  --wait 6000 --eval "$DEMO"

# settings → a named tab (the label carries a hint, so match loosely)
python3 tools/shot/shot.py --url "$BASE" --out public/shots/accounts.png --wait 10000 \
  --eval "$DEMO
    document.querySelector('[title=\"dashboard settings\"]').click();
    setTimeout(() => [...document.querySelectorAll('button')]
      .find(b => /ACCOUNTS/.test(b.textContent)).click(), 500);"
```

`--wait` is the settle before the shutter, in milliseconds. The panels fill from
the bridge, so too short a wait catches `LOADING…` — the Accounts tab needs
about ten seconds for its per-account usage meters.

`--eval` runs any JavaScript against the settled page, which is also how a shot
opens a modal. Clicks go through React fine, but tab labels include their hint
text, so match with a regex rather than an equality check.

## demo.js

The dashboard shows whatever repos are on the machine that took the picture.
`demo.js` rewrites the rendered DOM — project names, branch names, session
titles, home paths, the signed-in email — into a demo set, so a capture can be
published without leaking a client's repo names. It touches the DOM only; the
bridge never hears about it and a refresh undoes it.

Two things it does deliberately:

- **The open session keeps its real title**, and the script switches to a session
  on this project first (the `MYST` tag). The centre pane is the biggest thing a
  visitor reads, so it shows this repo's own work — the one conversation that's
  safe to publish verbatim.
- **It re-applies on every mutation.** The dashboard polls every few seconds and
  React renders straight over these edits.

If the machine that takes the next shots has different repos, update the `NAMES`
map — anything left unmapped ships as-is.
