# Visual element selector → Claude — design

Date: 2026-06-27
Branch: `feat/element-selector`

A "Design" mode that loads the running project in a resizable breakpoint frame, lets
the user click real elements (or drop pins on empty space), annotate each, and send
the whole set plus one instruction to Claude. Claude receives each element with its
**source `file:line`**, the user's notes, and an optional screenshot, then edits the
real code through the **existing** run pipeline.

Built Dashboard-first, then ported to the Mini App via a shared core. No DB schema
change; no new run path; the existing preview tunnel is unchanged.

---

## Why this shape

The hard part is **not** the frame, the prompt, or the Claude turn — those exist:

- Preview already exposes the target dev server at `preview.mhzrerfani.dev` via the
  named Cloudflare tunnel (`bridge/tunnel.py`, `bridge/miniapp/web/src/routes/preview.tsx`).
- Prompts already flow UI → `POST /api/run` → `runner.start_streaming_job` → `claude`
  CLI (`bridge/runner.py:732`, `:588`), and images already attach via base64 →
  `_save_images` → prepended to the prompt (`bridge/miniapp/server.py:112`,
  `runner.py:594`).

The hard part is the **selector**: to draw an overlay and read the DOM *inside* the
previewed page, our code must run inside that page. The preview is a different origin
from the Mini App / Dashboard, so the parent cannot touch `iframe.contentDocument`.

**Resolution (chosen):** a dev-only Vite plugin that Claude adds to the target project
injects an in-page agent. The agent runs same-origin to the page, reads its own DOM,
and talks to our UI over `postMessage` (which is allowed cross-origin). Because the
plugin lives in the dev server, **the tunnel needs zero changes** — Vite serves the
agent itself, and HMR is untouched (no proxy in the path).

Prior art confirming the approach: `react-dev-inspector`, `vite-plugin-vue-inspector`,
`click-to-react-component`, and **Onlook** all map a clicked DOM node to source via a
build-time transform + an in-page overlay.

---

## ① Injectable selector agent + Vite plugin

The foundation. A small standalone package (not coupled to the bridge) the user/Claude
adds to any Vite project.

**Plugin** (`vite-plugin-mystical-selector`), dev-only (`apply: 'serve'`):
1. **Source-location transform.** Stamp `data-mloc="<relpath>:<line>:<col>"` onto JSX
   elements. Use a Babel/SWC JSX-source transform (the `react-dev-inspector` technique)
   rather than reading React-fiber internals — robust across React 18/19 and SWC. Vue
   support is a later add via `unplugin-vue-inspector`'s equivalent.
2. **Agent injection.** `transformIndexHtml` injects `<script type="module">` loading
   the agent IIFE in dev only.
3. **Framing.** In dev, set permissive `Content-Security-Policy: frame-ancestors` (and
   strip `X-Frame-Options`) for our parent origins so the iframe embeds.

**Agent** (`client.ts`, built to one IIFE). Runs in the page:
- **Handshake.** On load, waits for an `init` message carrying a per-session `nonce`
  and the parent origin; all later messages are validated against both. Ignores
  messages from any other origin/nonce.
- **Modes** (toggled by parent messages): `idle` | `select` | `pin`.
- **Hover (select mode):** highlight the element under the cursor — outline box +
  label (tag · classes · `WxH`). Throttled `mousemove` + `elementFromPoint`.
- **Click (select mode):** capture the element (below) and `postMessage` it out; add a
  persistent outline so multi-select is visible in-page.
- **Click (pin mode):** capture `{ x, y }` in page coords + the nearest element under
  the point; emit a `pin`.
- **Per-element capture:**
  `{ id, mloc, selector, tag, idAttr, classList, text(≤120), outerHTMLSnippet(≤500),
    rect:{x,y,w,h}, styles:{color,background,fontSize,display,...} }`.
  `selector` is a robust nth-of-type CSS path (fallback when `mloc` is absent).
  `mloc` is read from `el.closest('[data-mloc]')`.
- **Cleanup.** Leaving select/pin mode removes overlays and listeners.

**Message protocol** (`protocol.ts`, shared verbatim between agent and host):
`parent→agent`: `init`, `setMode`, `clearSelection`, `removeItem`.
`agent→parent`: `ready`, `hover`, `selected`, `pin`, `error`.

**Setup path.** A one-tap "Set up selector in this project" action composes a canned
Claude prompt ("add `vite-plugin-mystical-selector` as a dev dependency and wire it
into `vite.config.*`, dev-only") and starts a normal run in the project's session —
reusing the existing run flow, no dedicated endpoint. Manual setup (README) also works.

Files: new `tools/selector-plugin/` (`vite-plugin.ts`, `client.ts`, `protocol.ts`,
`README.md`). Tested standalone against a plain parent HTML page before any UI work.

---

## ② Shared host core

One module, consumed by **both** React apps (Mini App and Dashboard are both React 19
+ Vite). Lives at a shared path imported via a Vite alias (e.g. `@selector/*` →
`bridge/shared/selector/`) from both `bridge/miniapp/web` and `bridge/dashboard/web`.

- `protocol.ts` — re-export of the agent protocol constants (single source of truth).
- `useElementSelector.ts` — hook: owns the iframe ref, performs the `init` handshake
  (generates the nonce, posts it once `ready` arrives), tracks `mode`, the tray
  (`items: (Element|Pin)[]` each with an editable `note`), and the breakpoint width.
- `PreviewFrame.tsx` — `<iframe src={previewUrl}>` + a breakpoint toolbar (presets:
  Mobile 375 · Tablet 768 · Laptop 1280 · Desktop 1440 · Full; plus custom width). The
  frame is set to the chosen CSS width and **scaled to fit** its container via
  `transform: scale(...)` so a 1440px frame is viewable in a smaller pane (and on the
  Mini App). Select / Pin toggles live here.
- `SelectionTray.tsx` — list of captured items; each row shows the element label /
  pin marker, a note `<textarea>`, and a remove button. Hovering a row re-highlights
  its element in the frame (sends a transient `hover`).
- `composePrompt.ts` — serialize tray + instruction into the Claude block (below).

Files: new `bridge/shared/selector/*`; Vite alias added to both web apps'
`vite.config.ts`.

---

## ③ Compose + send to Claude

On **Send**, `composePrompt` produces:

```
Visual edit on <project> at <width>px. The user selected these in the running app:

[1] <button class="btn-cta"> "Get started"
    source: src/components/Hero.tsx:42
    selector: main > section.hero > button.btn-cta
    note: make this primary blue and bigger
[2] PIN near <footer> at (320, 980)
    note: add a newsletter signup here

Instruction: <user's prompt>
```

- `source:` line is omitted when `mloc` is absent (non-transformed project); the
  `selector` + text/classes still let Claude grep to the right node.
- **Screenshot attached by default** (toggle to disable): one breakpoint-width capture
  via ④, sent through the existing image pipeline so Claude also sees the layout.
- Submitted via the existing client run flow (`api.run(...)` / chat `runPrompt`),
  which already accepts an arbitrary prompt string + images. No new `/api/run` work.

Tray + breakpoint are ephemeral UI state; the composed text + screenshot ride on the
existing turn/attachments, so **no store schema change** and full transcript history
for free.

Files: integrate into Mini App composer/chat (`bridge/miniapp/web/src/lib/chat.tsx`,
new `routes/design.tsx`) and the Dashboard run flow (new HUD panel + `App.tsx` wiring).

---

## ④ Screenshot endpoint (optional, also the fallback)

`POST /api/preview/screenshot { width }` → captures `preview.mhzrerfani.dev` at the
given viewport width with headless Chrome (`chrome-headless-shell`, already working in
WSL per project setup) and returns an image. Client-side capture is impossible because
cross-origin iframe pixels taint the canvas — so this is server-side.

Two uses: (a) the default visual-context attachment in ③; (b) the **fallback mode**
for non-Vite / unsupported projects — user boxes/pins on the static screenshot and
those annotations + notes are sent (no live DOM, but still a usable path).

Files: new handler in `bridge/miniapp/server.py` (+ dashboard `server.py`); a small
`bridge/screenshot.py` wrapping the headless invocation.

---

## ⑤ Security

- `postMessage` validates **origin + per-session nonce** both directions; the agent
  ignores anything else.
- The agent + plugin are **dev-only** (`apply: 'serve'`, `import.meta.env.DEV`) — never
  in a production bundle.
- The permissive `frame-ancestors` is scoped to the bridge's parent origins and applies
  only to the dev server.

---

## Build order (Dashboard-first to de-risk)

1. **Agent + Vite plugin** (①) — verify hover/click/pin, `mloc` capture, and the
   handshake against a plain parent page.
2. **`PreviewFrame` + breakpoints** (② partial) — iframe renders the tunnel preview at
   each width with scale-to-fit, no selection yet, in the Dashboard.
3. **Selection/pin/tray + notes** (② rest) — full picking end-to-end in the Dashboard.
4. **Compose + send** (③) — structured prompt + screenshot through the existing run
   flow; verify Claude makes the correct edit from `file:line`.
5. **Screenshot endpoint + fallback** (④) — and the default attachment.
6. **Port to Mini App** — reuse the shared core; add touch ergonomics (long-press to
   select, larger hit targets) and a `routes/design.tsx`.

---

## Risks / open issues

- **Source-mapping robustness.** Mitigated by the `data-mloc` build-time stamp rather
  than fiber internals; degrades gracefully to selector+text when absent.
- **Dev-server framing headers.** The plugin sets `frame-ancestors` in dev; some
  setups may still block — surfaced as a clear "couldn't embed" error with the
  open-in-tab fallback.
- **Mobile picking ergonomics.** Small screen + touch; handled in the Mini App port
  with long-press + scaled frame; acknowledged as the riskiest UX.
- **Single preview at a time.** The tunnel maps one hostname→one dev port, so the
  selector previews the currently-running dev server — matches today's model.
- **Vue/non-React.** v1 transform targets JSX (React); Vue and the screenshot-only
  fallback are follow-ups.

---

## Testing

- **Agent (①):** a standalone test harness page (plain HTML parent + iframe loading a
  fixture app with the plugin) asserting the protocol: handshake, hover, multi-select,
  pin, and `mloc` capture. Vitest + jsdom for the pure capture/selector functions.
- **`composePrompt` (③):** unit tests over tray fixtures (with/without `mloc`, pins,
  notes) asserting the exact Claude block.
- **Backend (④):** pytest for the screenshot handler (mock the headless call) and the
  width param validation, under `tests/`.
- **Frontend:** build both web clients (`npm --prefix … run build`) to typecheck the
  shared core import from both apps.
