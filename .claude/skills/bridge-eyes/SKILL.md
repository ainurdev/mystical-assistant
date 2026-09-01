---
name: bridge-eyes
description: Use when frontend work in this repo needs to be looked at rather than asserted — after changing anything under bridge/dashboard/web, bridge/miniapp/web or site/, or when the user says "screenshot it", "does it look right", "show me the dashboard", or asks you to verify a UI change. Covers headless capture in WSL and driving the live UIs over CDP.
user-invocable: true
---

# Looking at the UIs headlessly

There is no display here. Every visual claim has to come from a captured pixel,
and the obvious way to capture one hangs forever on this project's own UIs.

## Which port is which

| Port | Surface | Notes |
|------|---------|-------|
| 8790 | Dashboard | Desktop. `?skipboot=1` bypasses the 4.25s boot intro. |
| 8787 | Mini App | 390px wide. `/api/*` needs Telegram init-data. |
| 8791 | Landing page | Static. |

`DASH_TOKEN` is empty in this machine's `.env`, so local GETs need no auth. If it
is set, append `?token=…`.

## Static pages: use the bridge's own helper

```python
from bridge import screenshot
open("/tmp/shot.png", "wb").write(screenshot.capture("http://127.0.0.1:8791/", 1280, 800))
```

`bridge/screenshot.py` already owns the WSL specifics — it finds the newest
chrome-headless-shell under `~/.cache/ms-playwright/` (the build number changes
on every Playwright update, so never hardcode the path) and puts the cached
`libasound.so.2` stub on `LD_LIBRARY_PATH`. Don't hand-roll chrome flags.

Then `Read` the PNG to actually look at it.

## Live app pages: `capture()` will hang — use CDP

Chrome's `--screenshot` mode waits for the page to finish loading. The dashboard
and Mini App hold SSE streams open forever, so it never fires: no image, no
error, no timeout worth waiting for. Measured on the live dashboard — still
nothing at 75s, while the landing page returns in 0.8s.

Use the bundled CDP script instead, which navigates, waits a fixed settle, and
grabs `Page.captureScreenshot`:

```sh
node .claude/skills/bridge-eyes/shot.mjs 'http://127.0.0.1:8790/?skipboot=1' /tmp/dash.png 1280 800
# → /tmp/dash.png 169KB, ~3.4s
```

Then `Read /tmp/dash.png`.

## Driving, not just looking

The script is deliberately small; when you need to click through to a state,
extend the same CDP session with `Runtime.evaluate` rather than reaching for
Playwright (the npm module is not installed, and the chrome-devtools MCP fails
with "Target closed" in this WSL box).

- Launch with your own `--user-data-dir` — without it chrome hands off to an
  already-running instance and your debug port never listens. (`shot.mjs` does.)
- Dashboard selectors: session rows are `.sessrow`; several `.mscroll` elements
  exist — the transcript scroller is the one containing `[data-key]` rows. Turn
  rows carry `data-index`/`data-key`; `[data-prompt-idx]` was removed in the
  virtualization rewrite and now silently matches nothing.
- The editor is inside `AnalyzeModal`, not a top-level tab: click `MAP` on a
  project row, then the `EDITOR` tab.
- Mini App with real data needs a forged `X-Telegram-Init-Data`:
  `secret = HMAC_SHA256("WebAppData", TELEGRAM_BOT_TOKEN)`, then
  `hash = HMAC_SHA256(secret, "\n".join(sorted("k=v")))` over `auth_date`,
  `query_id`, `user` — the user id must be in `ALLOWED_CHAT_IDS`. Block
  `*telegram-web-app.js*` via `Network.setBlockedURLs` or the real CDN script
  overwrites your stub `window.Telegram`.
- Opening a session from another repo calls `api.select` and **changes the
  bridge's active project**. Stay in the active project, or restore it with
  `POST /local/select {"dir": …}` on 8790.

## Recording, not just stills

A still cannot show a transition, a hover, or a race. `.claude/skills/bridge-eyes/rec.mjs`
is `shot2.mjs` with `Page.startScreencast` in place of the single capture, and
takes the same arguments plus an output fps:

```sh
node .claude/skills/bridge-eyes/rec.mjs 'http://127.0.0.1:8790/?skipboot=1' /tmp/clip.webm \
  1280 800 3000 '{}' "$ASYNC_JS" 10
# → /tmp/clip.webm 800KB  490 frames -> 102 @10fps  10.2s
```

The 7th argument is the same `Runtime.evaluate` string `shot2.mjs` takes, run
with `awaitPromise`, so an async IIFE with `await sleep()` between clicks is the
whole step language — no separate DSL.

- **Output is VP8/webm, never mp4.** Playwright's bundled ffmpeg (the only one
  on this machine) is built `--disable-everything`: mjpeg in, libvpx out, webm
  muxed. No h264, no concat demuxer, no gif. Telegram accepts it via
  `sendVideo` (measured 2026-08-31); `send.py` falls back to `sendDocument` if
  that ever stops being true.
- Chrome emits ~50 frames/s and only when pixels *change*, so the recorder
  drops the surplus and pads gaps with the last frame, against an absolute
  video clock. Check the printed real-time figure against the container's
  `Duration` — they should match within a frame or two. If they don't, the
  video is lying about how long the UI took.
- Watch it yourself before sending: `send.py` now takes `.webm` as well as PNGs.

Isolation needs nothing new. Build in a worktree, serve that `dist` with
`.mystical/probe/probe.py` (static + read-only GET proxy), and record against
*that* port — the recorder already gets a fresh `mkdtemp` chrome profile per
run, so nothing touches the live bridge's state.

## In-session alternative

A run started by the bridge gets a `Screenshot` MCP tool
(`bridge/verify_mcp.py`) that returns the image as a content block — no file, no
node. Use it when it's there; it caps at 1600×1600 to bound token cost.
