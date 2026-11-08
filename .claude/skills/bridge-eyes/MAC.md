# bridge-eyes on the Mac

The kit is `macos/eyes/`: headless Google Chrome (`cdp.mjs`) for speed, and real
WebKit (`wkshot.swift`), the engine Mystical.app runs, for WebKit's own bugs.
Paths below are from the repo root; any checkout works.

## 1. Build each side

```sh
cd <checkout>/bridge/dashboard/web && npx vite build --outDir /tmp/eyes-after --emptyOutDir
```

A worktree has no `node_modules`: link the main checkout's first (bridge-worktree).
"Before" is a build of the base branch, or the live dist, which is what the user
sees right now: `~/Projects/mystical-assistant/bridge/dashboard/web/dist`.

## 2. Compare, don't eyeball

A layout change gets a before/after compare across window sizes before you call
it done. Raw rects scroll past unread: the Settings resize printed a 6px shrink
at 700×600 in its first sweep, and only the reviewers caught it, ten minutes later.

```sh
node macos/eyes/compare.mjs /tmp/eyes-before /tmp/eyes-after '.setdlg,.setpage' \
  "window.dispatchEvent(new CustomEvent('hud:settings', {detail: 'appearance'}))"
```

- Arguments: before and after (dist folders, served read-only for you, or URLs),
  comma-separated selectors, and an optional step run in the page after boot
  (`await` works).
- Sizes sit either side of the CSS breakpoints: 390×844, 601×700, 700×600,
  800×600, 1024×768, the user's Mystical.app window, 1920×1080, 2560×1440.
  `SIZES=WxH,…` replaces them.
- One row per size and selector, with Δw and Δh. **It exits 1 when anything got
  narrower, got shorter at the same width, or went missing.** Decide whether each
  flagged row is meant, and say which in your report. Shorter but wider shows as
  `reflowed`: that's text taking the room.
- `SHOTS=<dir>` keeps every capture (`after-1425x743.png`, …), `DPR=2` makes them
  sharp, and `WAIT=<ms>` stretches the 6 s boot wait.
- Rows sized by live data (a chat, a list) can move between runs. The same build
  on both sides shows the noise floor.

## Reference

- **Never capture :8790 itself.** Opening a session there marks its notices read,
  which writes real data. `roserve.mjs` serves a build's files, passes every GET
  (SSE included) to the live bridge and answers anything else with a 405:
  `node macos/eyes/roserve.mjs /tmp/eyes-after 0` prints one line whose first word
  is its URL (the upstream's host:port comes later in it, so don't grep). A
  server started in the background dies when your turn ends, so start it in the
  same command as its captures.
- **An Ask waiting on you.** `node macos/eyes/asks.mjs /tmp/eyes-after 0` is
  roserve with five canned sessions in front of the live list: a pick-one question,
  a pick-several one, three questions in one ask, a permission, and a question
  asked in prose. Their ids follow the URL line; land on one with
  `hud-last-session` (below). An answer prints as `RESPOND <turn> <body>` and
  clears the ask, so a click or key flow checks end to end; any other write
  prints as `REFUSED` and gets the 405.
- **What a key does inside Mystical.app.** `swiftc macos/eyes/keyprobe.swift -o /tmp/keyprobe`,
  then `/tmp/keyprobe <url> <waitMs> ctrl+tab cmd+. esc` prints, per key, whether
  the page got it and called preventDefault, and what AppKit got back
  (`cancelOperation` leaves full screen, `selectNextKeyView` moves focus). The
  window is hidden and takes no focus; `PRELOAD=` as below. It has no main menu,
  so a menu key like Window ▸ Dashboard ⌘1 never takes a key there.
- **As the user sees it.** `node macos/eyes/user.mjs preload` prints a
  `hud-settings` seed (theme, font, layout) from a clone of Mystical.app's WebKit
  store, deleted straight after because it holds drafts; `user.mjs size` prints the
  app's window, e.g. `1425 743`. compare.mjs uses both unless `AS_USER=0`. Read
  them fresh: the user changes theme often. To land on a session, add
  `localStorage.setItem('hud-last-session', '<id>')` to `PRELOAD`.
- **Auth.** `.env` sets `DASH_TOKEN` here, in quotes. Strip them:
  `grep '^DASH_TOKEN=' .env | cut -d= -f2- | tr -d '"'`. With the quotes, GETs
  work and every POST is a 401. compare.mjs reads it for you.
- **One Chrome shot:** `node macos/eyes/cdp.mjs <url> <out.png|.jpg> <w> <h> <waitMs> [evalJs] [wait2Ms] [dpr=2] [full=0|1]`.
  An evalJs that awaits must be an async IIFE, `(async () => {…})()`; a bare
  `await` fails without a word. `CLIP=x,y,w,h` crops, `full=1` grows the viewport
  to the page, `PRELOAD=<js>` runs before the page's own scripts, `UA=<ua>` fakes a
  user agent, and `EVAL_MAX=` lifts the 600-character eval print.
- **One WebKit shot:** `swift macos/eyes/wkshot.swift <url> <out.png> <w> <h> <waitMs> [jsBody] [wait2Ms]`,
  `PRELOAD=` as above. jsBody is a function body: `await` works, `return x` is
  printed. If results look frozen, check `document.visibilityState` reads "visible".
- **Opening things:** `?skipboot=1` skips the boot intro; a Settings page is
  `window.dispatchEvent(new CustomEvent('hud:settings', {detail: '<tab>'}))`.
- **Headless Chrome focus and hover:** `el.focus()` fires no focus events until
  `Emulation.setFocusEmulationEnabled`; at DPR 2 a CDP hover changes the DOM but not
  the screenshot, which DPR 1 does show.
- **`timeout`** is a perl stand-in in agent shells (~/.zshenv): whole seconds or
  30s / 5m / 1h, and a command that runs out exits 142, not GNU's 124.
- **Recording:** `bridge/rec.mjs` and the Record tool need WSL's Playwright build,
  and neither runs here.
