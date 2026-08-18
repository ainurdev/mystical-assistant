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

## In-session alternative

A run started by the bridge gets a `Screenshot` MCP tool
(`bridge/verify_mcp.py`) that returns the image as a content block — no file, no
node. Use it when it's there; it caps at 1600×1600 to bound token cost.
