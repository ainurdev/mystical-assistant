---
name: bridge-feature-slice
description: Use when adding or changing a capability in this repo that users should reach — a new endpoint, panel, command, or piece of session data. Names every file the change has to touch across the bot, the Mini App and the dashboard, in order, so a surface doesn't get left behind. Use before writing code, not after.
user-invocable: true
---

# Wiring a capability across the three surfaces

A feature here is never one file. The same capability has to reach a Telegram
chat, a phone-sized Mini App and a desktop dashboard, each with its own server,
its own client and its own auth. Leave one out and the product quietly disagrees
with itself.

## The slice, in order

Trace an existing feature before you start — `attribution` / "breakdown" is a
clean, recent one to copy:

| # | Layer | File | Rule |
|---|-------|------|------|
| 1 | Logic | `bridge/<feature>.py` | Stdlib only. Module docstring says *why*, including what you chose not to build. Best-effort features swallow their own errors — nothing may raise into the turn lifecycle. |
| 2 | Storage | `bridge/store.py` | Only if it must outlive the process. SQLite; migrations live here too. |
| 3 | Dashboard route | `bridge/dashboard/server.py` → `_get_api()` / `do_POST` | `self._json(...)`. POST is gated on Host + Origin + `X-Dash-Token`. |
| 4 | Mini App route | `bridge/miniapp/server.py` | Same data, `/api/...` prefix, auth is a validated `X-Telegram-Init-Data`. |
| 5 | Dashboard client | `bridge/dashboard/web/src/api.ts` | Typed `req<T>`; export the interface. |
| 6 | Mini App client | `bridge/miniapp/web/src/lib/api.ts` | Typed `request<T>`. |
| 7 | Dashboard UI | `bridge/dashboard/web/src/components/hud/` | HUD panel — see the `mystical-assistant-design` skill. |
| 8 | Mini App UI | `bridge/miniapp/web/src/components/` | Sheet/tab, 390px-first. |
| 9 | Bot | `bridge/dispatch.py` | Only if it deserves a slash command. Add it to `HELP` in the same edit — an undocumented command doesn't exist. |
| 10 | Live updates | `bridge/pubsub.py` | Only if it changes mid-turn: `publish("session:<id>", …)`, consumed over SSE. |
| 11 | Tests | `tests/test_<feature>.py` + `tests/test_<feature>_endpoint.py` | Logic and route tested separately. |

Skipping a row is fine when it genuinely doesn't apply — skipping it *by
forgetting* is the failure. State which rows you're skipping and why.

## Rules that only apply here

- **The client may be newer than the server.** Users run a dashboard built from
  new code against a bridge process still running old code, so a brand-new route
  404s. Both `SpendPanel.tsx` and `SpendSheet.tsx` handle exactly this — copy
  that pattern for any new endpoint, and say "restart the bridge" in the UI
  rather than rendering a broken panel.
- **Two servers, one shape.** If the dashboard and the Mini App return different
  JSON for the same concept, the next feature that reads it has to special-case
  both. Reuse the function from `bridge/<feature>.py` in both routes; don't
  reshape in the route.
- **Config is frozen at import.** `bridge/config.py` reads `os.environ` once. A
  new setting goes there (and in `.env.example`, which `tests/test_env_example.py`
  enforces), never read ad-hoc from `os.environ` at call time.
- **Route matching is manual string work** — `path == "/local/x"` and
  `path.startswith(...)`. Order matters: a `startswith` above a more specific
  path will swallow it. Put the specific case first, as `/breakdown` is.

## Verify

1. `python3 -m pytest tests/ -q` — green.
2. Both routes answer: `curl -s 127.0.0.1:8790/local/<x>` (the Mini App needs
   forged init-data — see **bridge-eyes**).
3. Both UIs render it — **bridge-eyes** for the screenshots.
4. It's live at all: **bridge-ship**.
