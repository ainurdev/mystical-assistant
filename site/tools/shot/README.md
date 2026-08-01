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

```bash
# the WORKTREES tab, showing a fleet (see worktrees.js — it brings its own data)
python3 tools/shot/shot.py --url "$BASE" --out public/shots/worktrees.png \
  --width 880 --height 640 --scale 2 --wait 5000 --eval "$(cat tools/shot/worktrees.js)"
```

`--scale` is the device pixel ratio: 2 for a retina-sized shot, which is what
makes 10px UI type legible on the site. The window size is in CSS pixels either
way, so the file comes out at twice it.

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

## worktrees.js

Same idea one level down. The WORKTREES tab is only worth a picture when several
branches are checked out at once with sessions running in them, which is a state
no machine is reliably in when the shutter opens. `worktrees.js` shims
`window.fetch` so the bridge's answers *for one project* — its worktrees, its
branches, each branch's ahead/behind/dirty, the sessions attached to them —
describe that fleet, then opens the tab and expands a row. The panel doing the
rendering is the real one, so the shot goes stale with the UI like every other:
re-run it. Nothing is written back to the bridge, and a refresh undoes it.

It ends by stretching the modal over the whole window (and dropping the
backdrop's padding, which is what actually sizes it), so the capture needs no
crop and no `demo.js` — the frame is the panel, and nothing of the real machine
is left around the edges.
