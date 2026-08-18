# mystical-assistant

A bridge that runs Claude Code on this machine, driven from three surfaces:
a **Telegram bot** (`bridge/dispatch.py`), a **Telegram Mini App**
(`bridge/miniapp/`, port 8787), and a **localhost dashboard**
(`bridge/dashboard/`, port 8790). Landing page on 8791. Python stdlib only on
the backend — no framework, no ORM, no async runtime.

## The one thing that bites everyone

**The running bridge is a snapshot of the code from when it launched.** A
committed fix does nothing until the bridge restarts, and restarting is not
`mystical restart` when you are a session *inside* that bridge — you share its
systemd cgroup and would kill yourself mid-turn. Use the **bridge-ship** skill.

## Tests

```sh
python3 -m pytest tests/ -q      # 1007 passing, ~19s (2026-08-18)
```

Fully green. Anything red is your change — there is no known-failure floor.

`tests/conftest.py` pins the environment **before** `bridge.config` is imported,
because config freezes every setting into module constants at import time. A
test that imports `bridge.config` (directly or transitively) before conftest's
pins would run against your real `~/.bridge_state` DB, your real accounts, and
your real chat-id allow-list. Never add env setup inside a test module's
preamble — put it in conftest, above the first bridge import.

## Conventions

- **`ponytail:` comments are load-bearing.** They mark a deliberate shortcut and
  name its ceiling. Don't "fix" one without reading what it defers; `/ponytail-debt`
  harvests them.
- **Module docstrings carry the design rationale** — the *why not* as much as the
  what. Read the docstring before changing a module; write one for a new one.
- Specs and plans live in `docs/superpowers/{specs,plans}/YYYY-MM-DD-slug.md`.
- Per-repo runtime state (git-ignored) goes in `.mystical/`: `dev.log`,
  `learn/` lessons, design-sync state.
- No external MCP servers load by default (startup cost) — the `mcp-on` skill
  turns one on for a session.

## Project skills

- **bridge-ship** — build, restart, and confirm a change is actually live.
- **bridge-feature-slice** — wiring a capability across all three surfaces.
- **bridge-eyes** — screenshotting/driving the UIs headlessly to verify frontend work.
- **mystical-assistant-design** — the CRT-HUD brand system, tokens, components.
