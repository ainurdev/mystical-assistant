# mystical-assistant

> Control Claude Code on your own machine from your phone — Telegram-native.

<!-- DEMO_GIF: 45–60s screen recording (marketing track) goes here -->

A remote dev workflow backed by **Claude Code on your own machine**, driven from
anywhere — a **Telegram bot**, a **Telegram Mini App** control panel, and a
**localhost desktop dashboard** — all sharing one conversation store. Start a
session on any surface (including Claude Code running natively in VS Code) and
continue it from any other, without caring where it started.

The bridge runs `claude` locally and reuses its login (no API key). Your phone or
browser is just a remote control; the work happens on your machine, in your repos.

---

## Surfaces

| Surface | How you reach it | What it's for |
|---|---|---|
| **Telegram bot** | DM your bot | Quick plain-text prompts, `/projects`, `/server`, `/preview`, `/logs` |
| **Telegram Mini App** | bot menu → 🛠 Open Panel | Full chat: prompts + screenshots, model/effort/permission pickers, live stream, dev-server controls, preview link, per-repo history |
| **Desktop dashboard** | `http://127.0.0.1:8790/?token=…` (localhost only, never tunneled) | A full-parity Claude client: project-grouped session sidebar, chat + cards, dual live logs, usage |
| **Native Claude Code (VS Code / terminal)** | the `claude` you already run | Discovered automatically and made resumable from the surfaces above |

---

## Features

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
  expose it on a stable public URL via a named Cloudflare Tunnel.
- **Claude usage.** Live 5-hour / 7-day utilization shown in both clients.
- **Project memory.** After a turn, a cheap Haiku pass proposes durable facts —
  conventions, decisions, your preferences, the active goal — as **Keep/Skip** cards.
  Kept facts are injected (project- and branch-scoped) into every future turn's system
  prompt, so a session knows its repo without re-deriving it. Curate them in the Memory
  view; set `MEMORY_ENABLE=0` to disable.
- **Teacher mode + review log.** After a turn that edits code, a cheap Haiku pass
  proposes 1–2 concepts to review as **Keep/Skip** cards on any surface. Kept items
  live in a Teacher view (Mini App `/teacher` tab, dashboard **TEACHER** tab in the
  project analyze modal) with on-demand Explain, Explain-back (graded), Quiz, and
  Exercise. Set `LEARNING_ENABLE=0` to disable.
- **One shared design system.** The dashboard and Mini App share the "Mystic"
  violet theme, tokens, and components.

---

## Architecture

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

---

## Quick start

**Prerequisites:** the `claude` CLI (installed and logged in) and Python 3.10+
with `requests`. `cloudflared` and Node are optional (only for the Mini App panel
and rebuilding the web UI).

```bash
git clone https://github.com/mhzrerfani/mystical-assistant
cd mystical-assistant
./setup.sh      # checks prereqs, walks you through @BotFather, writes .env
mystical        # start it — then message your bot
```

`./setup.sh` captures your Telegram chat id automatically (just message the bot
when it asks) and links a `mystical` launcher onto your `PATH`. The web clients
ship prebuilt, so there is **no build step**.

```
mystical            start in the background (logs → ~/.bridge_state/mystical.log)
mystical stop       graceful stop
mystical restart    stop, then start
mystical status     running? + ports, dashboard URL, public tunnel link
mystical doctor     check prerequisites
mystical logs       follow the log
mystical run        run in the foreground (Ctrl-C to quit)
```

### Manual / advanced setup

- **Config lives in `.env`** (git-ignored; `setup.sh` writes it). See
  `.env.example` for every option. Required: `TELEGRAM_BOT_TOKEN`, `BASE_PATH`,
  `ALLOWED_CHAT_IDS`.
- **Dashboard only (no cloudflared):** set `MINIAPP_ENABLE="0"` in `.env`.
- **Stable preview URL:** by default `/preview` uses ephemeral
  `*.trycloudflare.com` links. To get a fixed hostname, provision a named
  Cloudflare Tunnel and set `PREVIEW_HOSTNAME`/`TUNNEL_NAME`/`TUNNEL_ID`/
  `TUNNEL_CREDENTIALS_FILE` in `.env`.
- **Rebuild the web UI** (only if you change the frontend):
  `npm --prefix bridge/miniapp/web ci && npm --prefix bridge/miniapp/web run build`
  (same for `bridge/dashboard/web`). The dashboard build also needs the selector
  plugin's deps: `npm --prefix tools/selector-plugin install`.
- **First-run discovery mode:** if chat-id capture times out, start `mystical`
  with `ALLOWED_CHAT_IDS` empty, message the bot, and copy the printed id.

---

## Security

Whoever is in `ALLOWED_CHAT_IDS` can run Claude Code and start dev servers on this
machine. With `--dangerously-skip-permissions` that is arbitrary command execution.

- Keep `ALLOWED_CHAT_IDS` locked to your own chat id(s); never leave it empty in
  production (discovery mode is for setup only).
- Treat `TELEGRAM_BOT_TOKEN` as a secret (it also signs Mini App `initData`).
  It lives in `.env`, which is git-ignored; keep it `chmod 600`.
- The Mini App server binds `127.0.0.1` and is reachable only through the
  cloudflared tunnel; unauthenticated requests get 401 (signed `initData` required).
- The dashboard binds `127.0.0.1` and is **never tunneled**; it is gated by a Host
  allow-list (anti DNS-rebinding) and `DASH_TOKEN` (anti-CSRF).
- `RUN_TIMEOUT` caps runaway Claude runs.

See the SECURITY section at the bottom of `claude_telegram_bridge.py` before
exposing this.
