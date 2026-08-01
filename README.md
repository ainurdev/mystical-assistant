<div align="center">

<img src="docs/assets/mystical.svg" width="128" alt="mystical-assistant" />

# mystical-assistant

**Claude stops at your limit. This picks the work back up.**

[![MIT License](https://img.shields.io/badge/license-MIT-b9a6ff?style=flat-square&labelColor=060a0a)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-7fe9d8?style=flat-square&labelColor=060a0a)](https://www.python.org/)
[![Dependencies 0](https://img.shields.io/badge/dependencies-0-b9a6ff?style=flat-square&labelColor=060a0a)](#)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-required-7fe9d8?style=flat-square&labelColor=060a0a)](https://claude.com/claude-code)

[mystical-assistant.pages.dev](https://mystical-assistant.pages.dev)

</div>

<!-- DEMO_GIF: 45–60s screen recording (marketing track) goes here -->

A local dashboard for every Claude Code session on your machine — the one in VS
Code, the one in a terminal tab behind three others, the one you started here —
grouped by repo and marked alive or not. When a usage limit kills a turn it parks
the session and finds a way on: another Claude account of yours, a free agent on a
different provider, or the reset itself. Off your desk, the same sessions are
drivable from your phone through a Telegram bot and Mini App.

The bridge runs `claude` locally and reuses its login (no API key). Your phone or
browser is just a remote control; the work happens on your machine, in your repos.

**MIT licensed** · **reads the sessions you already have** · **no API key** ·
**Python standard library only** · **macOS, Linux, WSL**

<br />

## ✦ The gap this closes

Claude Code is happy to run a session per window. It just won't tell you they
exist. So the dashboard asks your machine directly: it reads Claude Code's own
session registry, checks whether each process is actually alive, and puts the
answer in one list — which repo, which branch, how long, working or waiting on you.

| Before | After |
|---|---|
| A client per project — an editor window here, a terminal tab there | One page for every project, wherever the session started |
| Alt-tab through every window to find the live one | One list of everything alive, per repo and branch |
| No idea which repo a session belongs to | Sessions grouped by project, with turns and cost |
| Find out it stopped for an answer 20 minutes ago | A marker on anything sitting there waiting on you |

A turn you opened in VS Code this morning can be read, answered and carried on
here — or from your phone — without reopening the project it came from.

<br />

## ✦ Why this one

Session lists, file explorers, git panes, worktrees and live subagent feeds exist
in plenty of good tools, so they're not the pitch. These five are.

**1. A limit parks the turn, then looks for another way.** Hit a 5-hour or weekly
cap and the work is parked, not lost — and parking is only the floor. It walks a
ladder: another Claude account you own, if one still has quota; a free agent on a
different provider, if none do; otherwise it reads the real reset time off the
usage endpoint, waits, and picks the turn back up with its context intact. Each
session decides whether it asks first or just switches. Server errors take their
own path — the first retry is immediate, then a minute, out to thirty. All of it
survives a restart.
*Elsewhere: shell wrappers watching the terminal from outside, and account-switchers that swap one global credential file — changing the account under every session already running.*

**2. It teaches you what it just wrote.** After a turn that changed code, a cheap
pass picks at most two things you probably accepted without fully reading and
offers them as Keep/Skip cards. The review itself — explanation, graded
explain-back, quiz, exercise — is written and served by the bridge, but the
dashboard doesn't open it yet (`hud/TeacherTab.tsx` is built and unmounted).
*Elsewhere: other dashboards show you the diff and leave it there.*

**3. Memory you approve, scoped to the branch.** Facts are proposed as Keep/Skip
cards and typed as a convention, decision, preference, goal or gotcha. Only what
you keep is injected, and it's scoped to that project and that branch, so a spike
doesn't leak its assumptions into `main`.
*Elsewhere: memory plugins ingest your sessions automatically into one bank per project.*

**4. Liveness from the process, not a timestamp.** It reads Claude Code's session
registry and asks the OS whether that PID is alive. A VS Code session shows as
running because the process is running.
*Elsewhere: detection leans on file modification times, which go stale and lie about long, quiet turns.*

**5. The standard library, and nothing else.** No `pip install`, no Node on the
server — Python 3.10+ and the files Claude Code already writes. Nothing sits
between your machine and the CLI at runtime, and you can read the whole server in
an afternoon. (The browser UI is a normal Vite app, built once on first start.)
*Elsewhere: comparable web UIs ship a Node server and its dependency tree.*

<br />

## ✦ Surfaces

| Surface | How you reach it | What it's for |
|---|---|---|
| **Desktop dashboard** | `http://127.0.0.1:8790/?token=…` (localhost only, never exposed) | The main event: project-grouped session sidebar, chat + cards, the repo's editor/git/terminal/issues, dual live logs, usage |
| **Telegram Mini App** | bot menu → 🛠 Open Panel | The dashboard's reach off your machine: prompts + screenshots, model/effort/permission pickers, live stream, answer cards, session history, GitHub issues as prompt sources |
| **Telegram bot** | DM your bot | Quick plain-text prompts, `/projects`, `/server`, `/preview`, `/logs` |
| **Native Claude Code** (VS Code / terminal) | the `claude` you already run | Discovered automatically and made resumable from the surfaces above |

All four share one SQLite store, so a session started on any of them continues on
any other.

<br />

## ✦ The workspace

It runs on localhost and is never published. Point it at the folder your repos
live in and it picks up the sessions already there — nothing to migrate, nothing
to re-create.

- **Sessions, grouped by repo.** Every session keyed to its project, so a repo's
  whole history sits in one place — turn counts, cost, which models ran, when it
  was last touched.
- **One list of what's alive.** From Claude Code's own registry, checked against
  the real process. VS Code, terminal, or started here — they all show up the same.
- **The repo, right there.** Jump between the diff, the editor, git, worktrees,
  open issues, a real terminal and a map of the codebase without leaving the
  session you're reading.

Everything the workspace opens:

`CHAT` · `HISTORY` · `MEMORY` · `PROJECTS` · `FILES` · `QUEUE` · `EDITOR` ·
`GIT` · `WORKTREES` · `TERMINAL` · `ISSUES` · `SKILLS` · `MAP` · `PREVIEW` ·
`TEACHER` *(built, not yet opened)*

<br />

## ✦ What's underneath

No pane here is a homemade version of a tool you already use. Where a good one
exists, that's the one running — and where the work belongs on your machine, it's
your `git`, your `gh`, your `claude` login doing it.

| Pane | What's actually running |
|---|---|
| **EDITOR** | **CodeMirror 6** — selection, folding and keymaps behave as they do everywhere else CodeMirror runs; JS, TS, Python, HTML, CSS, JSON and Markdown ship with it |
| **TERMINAL** | **xterm.js** in front of a real PTY. Curses apps and colour work because it's a terminal, not a command box |
| **GIT · WORKTREES** | **your git**, invoked the way you'd invoke it. Nothing is modelled twice, so nothing drifts |
| **ISSUES** | **the `gh` CLI**, under the auth you already granted it. No second token to mint |
| **MAP** | **graphify** — repo structure from tree-sitter ASTs; no LLM pass, no embedding bill |
| **PREVIEW** | **cloudflared** — your dev server reaches your phone without opening a port on your router |
| **SKILLS** | **community `SKILL.md`** — installing one downloads the maintained original from GitHub, verbatim |
| **THE ENGINE** | **`claude`** — the CLI you already logged into, reading the transcripts it already writes. No API key, no wrapper between you and the model |
| **FALLBACK** | **opencode** — the open-source CLI itself, run headlessly on a free provider. Not a second route into your subscription |

This is the same claim as *dependencies: 0*, seen from the other side: the server
needs nothing installed **because** the work goes to tools already on your
machine, and the browser panes are the real projects rather than lookalikes.

<br />

## ✦ Features

- **Cross-surface session continuity.** Every session — bot, Mini App, dashboard,
  or one you started natively in VS Code — appears in one unified list and is
  resumable from any surface, in its own working directory with its own permission
  posture. Native sessions are discovered from `~/.claude/projects/**.jsonl`,
  rendered on demand, and adopted into the store on first continuation.
- **Live stream, answerable inline.** Text, tool calls, results and errors land as
  they happen. Permission prompts (Allow/Deny) and `AskUserQuestion` answers render
  as cards you act on in place, from phone or desktop.
- **You can see the subagents.** When a run fans out (the `Task` tool), a pill
  shows "⚡ N agents working"; open it for what each one is doing and a live feed
  per agent — read-only, straight from Claude Code's own subagent transcripts.
- **Queue it up, or steer mid-run.** Stack the next few prompts while a turn is
  still going and they run in order, or fold a correction into the turn that's
  already running instead of stopping it and starting over.
- **Per-message controls.** Pick `opus`/`sonnet`/`haiku`, the reasoning effort and
  the permission posture — for this message, not forever. Whatever you choose
  sticks to the session. Sessions started from the dashboard or Mini App default to
  full autonomy (`bypassPermissions`), persisted per session.
- **Per-project sessions & history.** Sessions are keyed by repo; a per-repo
  history view rolls up turn counts, cost, models and last activity, with running /
  "awaiting your answer" indicators.
- **It remembers the repo.** After a turn, a cheap Haiku pass proposes durable
  facts — conventions, decisions, your preferences, the active goal — as Keep/Skip
  cards. Kept facts are injected (project- and branch-scoped) into every future
  turn's system prompt. Curate them in the Memory view; `MEMORY_ENABLE=0` disables.
- **Skills, per repo.** Which skills this project has, in the sidebar next to the
  chat that's using them — and a catalog to add more from, without leaving for a
  terminal or hand-writing a `SKILL.md`.
- **Dev server + preview.** Start or stop the project's dev server from the session
  working on it and watch its log tail beside the page it's serving; expose it on a
  stable public URL via a named tunnel.
- **Usage in plain sight.** Live 5-hour and 7-day utilisation on screen in both
  clients, so the first sign you're near a limit isn't Claude stopping mid-task.
  Each Claude account you add carries its own meter.
- **Watch the context fill.** A meter on the composer for how full the window is,
  in per cent and tokens, with `/compact` one tap away.
- **⌘K for the rest.** New chat, compact, jump between chat/history/memory, analyze
  the project, switch model, open settings — from the keyboard.
- **Fallback ladder.** A turn killed by a usage limit is parked, then walked up the
  ladder: another Claude account of yours with quota left (each in its own profile
  directory — your existing login is untouched), then a free agent on a different
  provider, then the reset itself. Per-session policy: ask, auto-switch, or only
  ever wait. Managed in the dashboard's **ACCOUNTS** tab; see
  [docs/superpowers/specs/2026-07-30-fallback-ladder-design.md](docs/superpowers/specs/2026-07-30-fallback-ladder-design.md).
- **Teacher mode + review log.** After a turn that edits code, a cheap Haiku pass
  proposes 1–2 concepts to review as Keep/Skip cards on any surface. Kept items get
  a review — Explain, Explain-back (graded), Quiz, Exercise — written and served by
  the bridge, but nothing in the dashboard opens it yet. `LEARNING_ENABLE=0` disables.
- **It doesn't have to look like a dashboard.** Sixteen display profiles, light and
  dark, from plain daylight to newsprint to a drafting table. CRT scanlines, a
  roaming sweep and phosphor glow if you want them. And while a turn runs: an
  equalizer, or nyan cat, or a piano you can play.
- **One shared design system.** The dashboard and Mini App share the "Mystic"
  violet theme, tokens and components.

<br />

## ✦ Setup

**Before you start**

| You need | Why | Note |
|---|---|---|
| [`claude` CLI](https://claude.com/claude-code), installed and logged in | the bridge shells out to it | reuses your existing login — no API key |
| Python 3.10+ | runs the bridge | stdlib only — nothing to `pip install` |
| `npm` | builds the dashboard UI on first start | only the build; nothing Node runs at runtime |
| A Telegram account | phone control, and setup asks for a bot token | see the note below |

A small tunnel client (only for the phone Mini App) and `opencode` (only for the
free-provider fallback) are optional — setup offers to install both.

> **On the bot token:** the project began as a Telegram bridge and `setup.sh` still
> requires a token even though the dashboard doesn't use one. Making it optional for
> a dashboard-only install is on the list; until then, a throwaway bot takes about a
> minute and nothing will message it.

**Install**

```bash
git clone https://github.com/ainurdev/mystical-assistant
cd mystical-assistant
./setup.sh
```

`setup.sh` asks six questions and handles everything else. It's idempotent —
re-run it any time and it only asks for what's still missing.

1. **Bot token.** It walks you through [@BotFather](https://t.me/BotFather) →
   `/newbot` → paste the token. Setup checks the token against Telegram and
   prints your bot's `t.me` link, so a typo fails here instead of at first run.
2. **Projects root** — the folder your repos live in (default `~/projects`).
3. **Permission posture** — whether sessions you start from the dashboard or
   phone ask before running commands (default) or run with full autonomy. There
   is no silent default: it decides what Claude may do on your machine unwatched.
4. **Mini App?** — the phone control panel; it needs a small tunnel client, and
   if that's missing setup offers to install it (Homebrew on macOS, a release
   binary into `~/.local/bin` on Linux). Say no and you still get the bot +
   dashboard.
5. **Free-provider fallback?** — offers to install `opencode` (~60MB), which
   lets a session hand off to a non-Anthropic model when your Claude accounts
   run out of quota. Add the provider key later in the dashboard.
6. **Start it now?** — launches the bridge.

Everything else is automatic: it captures your Telegram chat id (it asks you to
message the bot, then reads the id off that message), generates the dashboard
token, links `mystical` onto your `PATH`, and offers to add `~/.local/bin` to
your shell rc if it isn't there. The Mini App ships prebuilt; the dashboard's
bundle is not committed, so the first `mystical` start builds it — that one needs
`npm` and takes a minute longer.

Then open the dashboard URL setup prints at the end. It finds the sessions
already on your machine straight away.

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
  (same for `bridge/dashboard/web`).
- **Chat-id discovery mode:** start `mystical` with `ALLOWED_CHAT_IDS` empty,
  message the bot, and copy the id it prints. Setup only; never leave it empty
  otherwise.

<br />

## ✦ Cost, privacy, and what it sends

Nothing to buy — MIT licensed, and it drives the Claude Code you already pay for.
There's no telemetry and no account; your code stays on your machine and the
dashboard talks only to localhost.

The one caveat worth stating plainly: the memory, teacher, auto-title and
new-session-relevance checks each run their own cheap Haiku pass through your CLI
after a turn, so they do send that turn's output to Anthropic in a second call.
Small, but not free on your quota. Each is one env var away from off:

```
MEMORY_ENABLE=0      # no memory-candidate pass
LEARNING_ENABLE=0    # no teacher pass
TITLE_ENABLE=0       # no auto-titling
RELEVANCE_CHECK=0    # no "should this be a new session?" check
```

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
  - `limits.py`, `ladder.py`, `accounts.py`, `freeagent.py` — the parking and
    fallback path: usage-limit detection, the ask/auto/wait policy, per-account
    profile directories, and the opencode hand-off.
  - `dashboard/`, `miniapp/` — the two HTTP servers + their React clients (`web/`).
  - `tunnel.py`, `devserver.py`, `usage.py`, `browser.py`, `state.py`, `pubsub.py`.
- **`site/`** — the public landing page (standalone Vite app, no runtime tie to
  the bridge).

Design specs live in [docs/superpowers/specs/](docs/superpowers/specs/).

<br />

## ✦ Security

Whoever is in `ALLOWED_CHAT_IDS` can run Claude Code and start dev servers on this
machine. With `--dangerously-skip-permissions` that is arbitrary command execution.
That's the point of the tool and also the risk: Claude Code runs with your user's
permissions in your own repos, so anything that can slip a prompt past you runs as
you too.

- Keep `ALLOWED_CHAT_IDS` locked to your own chat id(s); never leave it empty in
  production (discovery mode is for setup only).
- Treat `TELEGRAM_BOT_TOKEN` as a secret (it also signs Mini App `initData`).
  It lives in `.env`, which is git-ignored; keep it `chmod 600`.
- The Mini App server binds `127.0.0.1` and is reachable only through the
  tunnel; unauthenticated requests get 401 (signed `initData` required).
- The dashboard binds `127.0.0.1` and is **never exposed publicly**; it is gated by
  a Host allow-list (anti DNS-rebinding) and `DASH_TOKEN` (anti-CSRF).
- The parts that watch your existing sessions only read. Subagent views derive
  entirely from files Claude Code already wrote, and never touch a live run.
- `RUN_TIMEOUT` caps a single Claude run; the session auto-resumes afterwards, so
  the brake on a runaway is the resume cap (5 consecutive dead turns), not the clock.

See the SECURITY section at the bottom of `claude_telegram_bridge.py` before
exposing this.
