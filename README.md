<div align="center">

<img src="docs/assets/mystical.svg" width="128" alt="mystical-assistant" />

# mystical-assistant

**Claude Code runs on your machine. You drive it from your phone.**

[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-7fe9d8?style=flat-square&labelColor=060a0a)](https://www.python.org/)
[![Dependencies 0](https://img.shields.io/badge/dependencies-0-b9a6ff?style=flat-square&labelColor=060a0a)](#)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-required-7fe9d8?style=flat-square&labelColor=060a0a)](https://claude.com/claude-code)
[![Telegram](https://img.shields.io/badge/Telegram-bot%20%2B%20mini%20app-6fb5ff?style=flat-square&labelColor=060a0a)](https://t.me/BotFather)

</div>

<!-- DEMO_GIF: 45–60s screen recording (marketing track) goes here -->

A remote dev workflow backed by **Claude Code on your own machine**, driven from
anywhere — a **Telegram bot**, a **Telegram Mini App** control panel, and a
**localhost desktop dashboard** — all sharing one conversation store. Start a
session on any surface (including Claude Code running natively in VS Code) and
continue it from any other, without caring where it started.

The bridge runs `claude` locally and reuses its login (no API key). Your phone or
browser is just a remote control; the work happens on your machine, in your repos.

<br />

## ✦ Surfaces

| Surface | How you reach it | What it's for |
|---|---|---|
| **Telegram bot** | DM your bot | Quick plain-text prompts, `/projects`, `/server`, `/preview`, `/logs` |
| **Telegram Mini App** | bot menu → 🛠 Open Panel | Prompting from your phone: prompts + screenshots, model/effort/permission pickers, live stream, answer cards, plus session history and GitHub issues as prompt sources |
| **Desktop dashboard** | `http://127.0.0.1:8790/?token=…` (localhost only, never exposed) | A full-parity Claude client: project-grouped session sidebar, chat + cards, dual live logs, usage |
| **Native Claude Code** (VS Code / terminal) | the `claude` you already run | Discovered automatically and made resumable from the surfaces above |

<br />

## ✦ Setup

**Before you start**

| You need | Why | Note |
|---|---|---|
| [`claude` CLI](https://claude.com/claude-code), installed and logged in | the bridge shells out to it | reuses your existing login — no API key |
| Python 3.10+ | runs the bridge | stdlib only — nothing to `pip install` |
| A Telegram account | it's your remote control | you create the bot in step 1 |

A small tunnel client (only for the phone Mini App — setup offers to install it)
and Node (only if you edit the web UI) are optional.

**Install**

```bash
git clone https://github.com/mhzrerfani/mystical-assistant
cd mystical-assistant
./setup.sh
```

`setup.sh` asks four questions and handles everything else. It's idempotent —
re-run it any time and it only asks for what's still missing.

1. **Bot token.** It walks you through [@BotFather](https://t.me/BotFather) →
   `/newbot` → paste the token. Setup checks the token against Telegram and
   prints your bot's `t.me` link, so a typo fails here instead of at first run.
2. **Projects root** — the folder your repos live in (default `~/projects`).
3. **Mini App?** — the phone control panel; it needs a small tunnel client, and
   if that's missing setup offers to install it (Homebrew on macOS, a release
   binary into `~/.local/bin` on Linux). Say no and you still get the bot +
   dashboard.
4. **Start it now?** — launches the bridge.

Everything else is automatic: it captures your Telegram chat id (it asks you to
message the bot, then reads the id off that message), generates the dashboard
token, links `mystical` onto your `PATH`, and offers to add `~/.local/bin` to
your shell rc if it isn't there. The web clients ship prebuilt, so there is **no
build step**.

Then message your bot, or open the dashboard URL setup prints at the end.

**Day-to-day**

```
mystical            start in the background (logs → ~/.bridge_state/mystical.log)
mystical stop       graceful stop
mystical restart    stop, then start
mystical status     running? + ports, dashboard URL, public link
mystical doctor     check prerequisites
mystical logs       follow the log
mystical run        run in the foreground (Ctrl-C to quit)
```

**If something's off**

| Symptom | Fix |
|---|---|
| `mystical: command not found` | open a new shell, or `export PATH="$HOME/.local/bin:$PATH"` |
| `claude not found` from `mystical doctor` | install the CLI and run `claude` once to log in |
| Setup said "No message received in time" | re-run `./setup.sh` — it resumes at the chat-id step |
| Bot ignores you | your chat id isn't in `ALLOWED_CHAT_IDS`; check `mystical logs` |
| No 🛠 Open Panel button | `MINIAPP_ENABLE="0"` in `.env`, or the tunnel client is missing |
| Port already in use | set `DASH_PORT` / `MINIAPP_PORT` in `.env`, then `mystical restart` |

**Config & advanced**

- **Config lives in `.env`** (git-ignored, `chmod 600`; `setup.sh` writes it).
  `.env.example` documents every option. Required: `TELEGRAM_BOT_TOKEN`,
  `BASE_PATH`, `ALLOWED_CHAT_IDS`.
- **Dashboard only, no tunnel:** set `MINIAPP_ENABLE="0"`.
- **Stable preview URL:** `/preview` hands out a throwaway public link by
  default. For a fixed hostname, provision a named tunnel and set
  `PREVIEW_HOSTNAME` / `TUNNEL_NAME` / `TUNNEL_ID` / `TUNNEL_CREDENTIALS_FILE`.
- **Rebuild the web UI** (only if you change the frontend):
  `npm --prefix bridge/miniapp/web ci && npm --prefix bridge/miniapp/web run build`
  (same for `bridge/dashboard/web`). The dashboard build also needs the selector
  plugin's deps: `npm --prefix tools/selector-plugin install`.
- **Chat-id discovery mode:** start `mystical` with `ALLOWED_CHAT_IDS` empty,
  message the bot, and copy the id it prints. Setup only; never leave it empty
  otherwise.

<br />

## ✦ Features

- **Cross-surface session continuity.** Every session — bot, Mini App, dashboard,
  or one you started natively in VS Code — appears in one unified list and is
  resumable from any surface. Resume runs in the session's own working directory
  with its own permission posture. Native VS Code sessions are discovered from
  `~/.claude/projects/**.jsonl`, rendered on demand, and adopted into the store on
  first continuation.
- **Live streaming.** Assistant text, tool calls, results, and errors stream in
  real time; all surfaces poll the same SQLite store, so a turn sent on one device
  shows up live on another.
- **Interactive cards.** Permission prompts (Allow/Deny) and `AskUserQuestion`
  prepared answers render as cards you can act on from phone or desktop.
- **Live agent activity.** When a run spawns subagents (the `Task` tool), a pill
  at the end of the chat shows "⚡ N agents working"; open it for a modal listing
  each subagent (what it's doing, its type, running/done) with a live per-agent
  activity feed. Read-only, derived from Claude Code's on-disk subagent
  transcripts — on both the Mini App and dashboard.
- **Per-project sessions & history.** Sessions are keyed by repo; a per-repo
  history view rolls up turn counts, cost, models, and last activity, with
  running / "awaiting your answer" indicators.
- **Model / effort / permission per message.** Pick `opus`/`sonnet`/`haiku`,
  reasoning effort, and the operating mode. Sessions started from the dashboard or
  Mini App default to full autonomy (`bypassPermissions`), persisted per session.
- **Dev server + preview.** Start/stop the project's dev server and watch its logs;
  expose it on a stable public URL via a named tunnel.
- **Claude usage.** Live 5-hour / 7-day utilization shown in both clients.
- **Project memory.** After a turn, a cheap Haiku pass proposes durable facts —
  conventions, decisions, your preferences, the active goal — as **Keep/Skip** cards.
  Kept facts are injected (project- and branch-scoped) into every future turn's system
  prompt, so a session knows its repo without re-deriving it. Curate them in the Memory
  view; set `MEMORY_ENABLE=0` to disable.
- **Teacher mode + review log.** After a turn that edits code, a cheap Haiku pass
  proposes 1–2 concepts to review as **Keep/Skip** cards on any surface. Kept items
  live in a Teacher view (dashboard **TEACHER** tab in the project analyze modal)
  with on-demand Explain, Explain-back (graded), Quiz, and Exercise. Set
  `LEARNING_ENABLE=0` to disable.
- **One shared design system.** The dashboard and Mini App share the "Mystic"
  violet theme, tokens, and components.

<br />

## ✦ Architecture

- **`claude_telegram_bridge.py`** — entry point; wires the package together and
  runs the Telegram long-poll loop.
- **`bridge/`** — the implementation:
  - `store.py` — SQLite source of truth: `sessions → turns → events`. One row per
    conversation, keyed by owner + project, carrying the native `claude_session_id`
    used for `--resume`. The single store is shared by the bot, Mini App, and dashboard.
  - `runner.py` — invokes the `claude` CLI (blocking for the bot, streaming
    stream-json for the chat clients); resolves each run's session, cwd, and
    permission mode; journals events to the store + pub/sub.
  - `native.py` — discovers native Claude Code sessions under `BASE_PATH` and
    indexes them into the store.
  - `transcript_jsonl.py` — translates Claude's native `.jsonl` transcripts into the
    bridge's `{turns, events}` shape so native sessions render with full fidelity.
  - `machine.py` — machine-wide view of live external Claude Code sessions.
  - `dashboard/`, `miniapp/` — the two HTTP servers + their React clients (`web/`).
  - `tunnel.py`, `devserver.py`, `usage.py`, `browser.py`, `state.py`, `pubsub.py`.

Design specs live in [docs/superpowers/specs/](docs/superpowers/specs/).

<br />

## ✦ Security

Whoever is in `ALLOWED_CHAT_IDS` can run Claude Code and start dev servers on this
machine. With `--dangerously-skip-permissions` that is arbitrary command execution.

- Keep `ALLOWED_CHAT_IDS` locked to your own chat id(s); never leave it empty in
  production (discovery mode is for setup only).
- Treat `TELEGRAM_BOT_TOKEN` as a secret (it also signs Mini App `initData`).
  It lives in `.env`, which is git-ignored; keep it `chmod 600`.
- The Mini App server binds `127.0.0.1` and is reachable only through the
  tunnel; unauthenticated requests get 401 (signed `initData` required).
- The dashboard binds `127.0.0.1` and is **never exposed publicly**; it is gated by
  a Host allow-list (anti DNS-rebinding) and `DASH_TOKEN` (anti-CSRF).
- `RUN_TIMEOUT` caps a single Claude run; the session auto-resumes afterwards, so
  the brake on a runaway is the resume cap (5 consecutive dead turns), not the clock.

See the SECURITY section at the bottom of `claude_telegram_bridge.py` before
exposing this.
