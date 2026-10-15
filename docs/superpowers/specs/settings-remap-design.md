# Settings remap: 17 tabs to 11, every tab one question, integrations as installable plugins

2026-10-15 · approved in chat (variant A, the rail) · audit in `.mystical/docs/reports/settings-audit.md` ·
mockups in `.mystical/design-drafts/settings-remap/` (`SPEC.md`, `00`–`07` HTML, `shots/`; the Claude Design
push waits on a one-time `/design-login` on this Mac) · plan: `docs/superpowers/plans/settings-remap.md` (next).

## Problem

The dashboard's Settings modal grew a tab per feature: 17 tabs in two groups, 5,800 lines in one file.
Measured on this machine (bridge.db, the state files, the Mac app's saved `hud-settings`, re-read
2026-10-15):

- "Who runs a session" is split over ACCOUNTS, SESSION and CONFIG, and SESSION ▸ RUN DEFAULTS duplicates
  the composer's own dropdowns (the session-run-settings design made model and mode the session's).
- Integrations are scattered: PLUGINS (Rivendell) is a tab, TRACKERS hides inside SYSTEM, HOOKS is a tab,
  the Claude Design link is an AI card. All of them show for every install, including one that will never
  use any of them, which blocks publishing.
- SYSTEM is 46 environment rows in nine groups; one override was ever saved, and it is a dead key.
- Four things in Settings are not settings: the week REPORT (two other homes), MOVE's 13 dock-look
  preferences (all default), the BOOT SEQUENCE replay, the Projects IMPORT row (browser-local, the bridge
  never sees it).
- Dead weight: HOOKS (0 hooks, 0 events ever), PER EVENT sound packs (never assigned), the nyan / piano /
  tiles indicators (untouched; STATUS is what runs), Claude·FM (volume never moved), CONFIG (a textarea
  for files `claude /config` already edits).

## Goals

1. Eleven tabs in four groups; each answers one question, named in its first line.
2. The rail reads its state: a live second line per tab, so most answers need no click.
3. Integrations ship with Mystical but stay off and invisible until installed from Settings ▸ Integrations.
   Someone who installs Mystical for the session list never meets Rivendell, Teamwork, Jira or Claude Design.
4. Settings holds what you change after install. What a setup script writes once stays in `.env`.
5. Delete what nobody uses rather than regroup it.

Non-goals: out-of-tree plugins (a folder dropped into the state dir) — the registry is shaped for it,
nothing loads from outside the repo in this round; the Mini App's own SYSTEM page beyond what the cuts
force; themes and typefaces (untouched).

## The rail

| Group | Tab | Live readout (source) | Holds |
|---|---|---|---|
| THE HUD | Appearance | `Flint · Geist · auto size` (settings) | theme dark/light · CRT effects (CRT themes only) · type |
| | Transcript | `Dossier · matrix · compact · status` (settings) | layout · composer (send key, show every model) · reading (scheme, ground, auto-open results, collapse steps) · working indicator |
| | Notify | `Banner · blip · Telegram on` (settings + env `NOTIFY_ENABLE`) | desktop banners · sound (tone, volume) · a note pointing at Telegram ▸ Push |
| | Mac app | `Session in title · in Dock` (lib/mac) | unchanged; Mac only |
| THE RUNS | Accounts | `2 logins · 2 profiles · auto` (accounts, profiles) | Claude logins · other agents · profiles · on usage limit |
| | AI | `7 of 10 spending` (aifeatures) | the AI switches, each priced; ponytail's default level on its card |
| CONNECTIONS | MCP | `17 servers · 2 need auth` + warn pip (mcp) | servers · add a server · AI browser |
| | Integrations | `Rivendell · 3 available` (integrations) | installed plugins with their settings · available plugins with INSTALL |
| | Telegram | `Bot · Mini App · named tunnel` (env, tunnel) | bot token · allowed chat ids · Mini App on/off · tunnel status · ping on finish |
| THE BRIDGE | Projects | `23 repos · 2 hidden` (projects) | repo rows · defaults (base path read-only, default run command) |
| | System | `Up to date · at login` (update, startup) | start at login · open the window · platform (branch, update, restart, open inspector) · runs (new-session mode, run timeout, auto-resume) |
| | Move | `Imported Oct 9` (move jobs) | export · import |

Rules the pages share:

- **Readouts** are built from data the modal already fetches when it opens (one round of GETs, no new
  polling). Until a readout's data lands, the row shows its static hint.
- **Scope pill** on every section head: `This browser` · `This bridge` · `This machine` · `Next start`.
  Replaces the header's "where these are stored" ⓘ and the per-row "· next start" suffix.
- **FLINT styling is the house style for this modal** on FLINT themes (sentence case, Geist, pills,
  12px-radius cards), the HUD styling elsewhere — both exist today; the remap changes content, not skins.
- **Deep links keep working:** `openSettings("plugins")` lands on Integrations, `("session","new")` on
  Accounts with the profile form open, `("accounts", slot)`, `("mcp")`, `("move")` as today. The `Tab`
  union becomes the eleven keys; `"plugins"` and `"session"` stay accepted as aliases.
- **Search** indexes the eleven tabs' sections; the env registry's remaining rows fold in as before.
- **Phone layout** (`max-width: 600px`): the rail collapses into the grid of variant B (mockup 02) —
  icon, name, readout per card — instead of today's scrolling strip.

## Pages

**Appearance.** Today's page minus BOOT SEQUENCE; "Replay the boot intro" becomes a ⌘K palette command.

**Transcript.** LAYOUT (default / compact) · COMPOSER (send key; *show every model*, from SESSION) ·
READING: one card — colour scheme (phosphor / contrast), the ground (none + four), auto-open results,
collapse steps · WHILE IT WORKS: working indicator, a two-way segmented control, *Equalizer* / *Status*.
The output-style picker goes: DOSSIER is the one language.

**Notify.** DESKTOP and SOUND as today (switch, tone, volume, a chime on change). PER EVENT and the pack
board go. A note under SOUND: "A Telegram ping for the same moments is under Telegram ▸ Push."

**Accounts.** CLAUDE LOGINS (rows as today; `+ ADD ANOTHER ACCOUNT`; `COPY CURRENT LOGIN` goes) · OTHER
AGENTS (today's AGENTS section) · PROFILES (today's panel, moved from SESSION; `+ NEW PROFILE`) · ON USAGE
LIMIT (today's segmented control, last because it is the rarest). The composer's `+ NEW PROFILE` opens
this tab with the form open and scrolled into view.

**AI.** Today's cards minus `tasks` and `design` (they move into their plugins). No tuning rows; the eight
`RELEVANCE_*` / `NEXTUP_*` knobs stay in `.env`. Two cards become dependency-aware: **Ponytail** renders
only when the ponytail Claude Code plugin is installed (`~/.claude/plugins/installed_plugins.json`) and
carries the default-level control (from SESSION); **Project map** shows "Needs graphify on PATH — not
found" with the install line when `graphmap.graphify_bin()` is None, switch disabled. The AI tab's
`on of total` counts only cards shown.

**MCP.** Today's MCP SERVERS and ADD A SERVER, plus an AI BROWSER card holding the three browser rows
(hidden, binary, profile folder) that configure the Playwright and chrome-devtools servers.

**Integrations.** See below.

**Telegram.** BOT (`Next start`): bot token (masked), allowed chat ids · MINI APP (`Next start`): the
switch; a read-only tunnel line — `Named · connected` / `Quick tunnel` / `Off`, hostname, port, "set up
by `mystical setup`" · PUSH (`This bridge`): ping on finish (`NOTIFY_ENABLE`).

**Projects.** Today's rows (rename, hide/show, remove, default profile; IMPORT goes) plus a DEFAULTS
card: base path (read-only, with "change it in .env and restart"), default run command (`START_CMD`).

**System.** STARTUP: start at login, open the window too, the browser-profile picker where it applies;
*install as app* only where a browser can install (hidden inside Mystical.app) · PLATFORM: one line with
branch, commit, host:port and the store path, RESTART BRIDGE; UPDATE; API TRAFFIC → open inspector · RUNS:
new sessions start in (`NEW_SESSION_PERMISSION_MODE`), run timeout, auto-resume.

**Move.** EXPORT and IMPORT as today. PROGRESS goes; `MoveDock` keeps today's defaults as constants
(line bar, regular, accent/violet, bottom-right, pill, all four card parts, hide after success, motion on).

**Mac app.** Unchanged.

## Integrations as plugins

**Model.** Bundled, off by default, installed from Settings. "Install" flips a switch; nothing is
downloaded. Installed, a plugin's routes answer, its worker runs, its env rows and Telegram callbacks are
live, its session origins are listed, and its UI appears. Not installed, none of that exists: no tab, no
card, no header button, no `LINK TASKS`, no DESIGN tab, no move section, 404 on its routes. Removing a
plugin switches it off and leaves its state file on disk, so reinstalling restores it.

**Registry: `bridge/integrations.py`.** One table, the shape of `aifeatures.FEATURES`:
`{id, label, blurb, needs, env_keys, origins}` for `rivendell`, `trackers`, `design`. `installed(id)`
reads `~/.bridge_state/plugins.json` (same lock-and-cache pattern as `aifeatures`). `set_installed(id,
bool)` writes it and calls the plugin's `start()` / `stop()` (Rivendell: `rivendell.reconfigure()`;
trackers and design have no worker). **First boot without `plugins.json` adopts existing state:** any
`rivendell_instances.json` instance installs `rivendell`, any `trackers.json` connection installs
`trackers`, any project with `design_project` installs `design` — this machine keeps working after the
upgrade without a click.

**Gating contract.**

- Backend: every plugin route in `dashboard/server.py` and `miniapp/server.py` checks `installed()` first
  (404 `not installed`); `config.PLUGIN_ORIGINS` becomes `integrations.origins()` over installed plugins;
  `dispatch.py`'s Rivendell callbacks, `runner.py`'s plugin-session branches, `queue_manager`'s Rivendell
  lanes, `move.py`'s Rivendell section, `github.py`'s Rivendell PR hints, `native_activity` / `nextup` /
  `dream` tracker reads, `skills.py`'s design pull all go through `installed()`. The env registry lists a
  plugin's `env_keys` only while it is installed; `envsettings.apply()` is unchanged.
- Frontend: `GET /local/integrations` → `{plugins:[{id,label,blurb,needs,installed,summary}]}`,
  `POST /local/integrations {id, action: install|remove}`. `lib/integrations.ts` exposes
  `useIntegrations()` the way `lib/ai.ts` exposes `useAiFeatures()`; `App.tsx`'s `rivendellOn`, the
  SessionsPanel plugins mode, AnalyzeModal's TASKS/LINK TASKS and DESIGN tab, the composer's DESIGN
  button, MoveDock's Rivendell actions and the Mini App's WORK route all read it. The Mini App gets the
  flags on `/state`.
- Tests: one parametrised test per plugin asserts that with it not installed its routes 404, its origins
  are not plugin origins, and its env keys are absent from the registry; one test covers first-boot
  adoption; the existing Rivendell and tracker suites run with the plugin installed in `conftest`.

**Ownership.**

| Plugin | Code it owns | Settings inside its card |
|---|---|---|
| **Rivendell** | `rivendell.py`, `rivendell_instances.py`, `rivendell_video.py`, origins `rivendell:*`, env `FFMPEG_BIN` `WHISPER_BIN` `WHISPER_MODEL`, the RIVENDELL right-rail tab, the queue cards, Telegram approvals, the video kind | instances (today's form minus `ws url`), TEST LINK / SEND TEST JOB, a VIDEO JOBS line showing whether ffmpeg, whisper-cli and the model file are found |
| **Trackers** (Teamwork, Jira) | `trackers.py`, the TASKS tab, LINK TASKS, the Task digest switch, the tracker MCP entries, Mini App WORK | connections (today's TRACKERS panel), the Task digest switch |
| **Claude Design** | `designsync.py`, `design_project` in project config, DesignTab, the composer DESIGN button, `/design-first` and `/design-implement`, the design pull in `skills.py` | nothing beyond the per-repo link in ANALYZE; the card says what it adds |

Integrations shows two cards per tracker kind (Teamwork, Jira) over one `trackers` plugin; both install it.

## What goes

**Tabs:** Hooks (feature and code: `hooks.py`, both server routes, the Mini App endpoint, `HooksPanel`,
`test_hooks.py`, `test_hooks_endpoint.py`; the two DB tables stay, empty) · Config (`agentconfig.py`, its
route, `AgentConfigPanel`, `test_agentconfig.py`) · Report (the tab only; `WeekPanel` keeps its two homes)
· Ambient (weather stays in the clock popover; the radio goes) · Session (run defaults are the composer's;
profiles move) · Indicator (folds into Transcript) · Plugins (renamed Integrations).

**Features:** nyan / piano / tiles (`lib/nyan.ts`, `lib/songs.ts`, `lib/piano.ts`, `usePianoEngine.ts`,
`PianoKeyboard.tsx`, `PianoIndicator.tsx`, `TilesIndicator.tsx`, their branches in `WorkingIndicator.tsx`)
· Claude·FM (`lib/ambient.ts`, the header pill and its App state) · the five extra transcript languages
(`TOOL_STYLES` shrinks to DOSSIER on both surfaces; `[data-style="stamp|wire|signal|press|halo"]` CSS
goes on both; the Mini App's `/output` route becomes scheme + collapse steps) · per-event sound packs
(`lib/sounds.ts`, `SoundBoard`, `PUSH_EVENTS` keep only the tone path) · Move ▸ Progress (`MovePrefs`, the
page, the bar/thickness/corner/mini variants in `MoveDock`) · the Projects import stub · the Boot sequence
section.

**Browser settings (`HudSettings`), 37 → 22.** Delete `agent`, `nyan`, `nyanSound`, `nyanVolume`,
`nyanExtra`, `pianoVoice`, `pianoVolume`, `tilesSong`, `tilesSpeed`, `radioVolume`, `pushSounds`, `move`,
`toolStyle`. `loadSettings` already reads known keys only, so a stored blob with the old keys loads clean;
`indicator` maps any value other than `status` to `bar`.

**Environment rows in the UI, 46 → 10 (+3 plugin-owned).** Stay: `TELEGRAM_BOT_TOKEN`,
`ALLOWED_CHAT_IDS`, `MINIAPP_ENABLE`, `NOTIFY_ENABLE`, `NEW_SESSION_PERMISSION_MODE`, `RUN_TIMEOUT`,
`AUTO_RESUME`, `AI_BROWSER_HEADLESS`, `AI_BROWSER_EXECUTABLE`, `AI_BROWSER_PROFILE`, `START_CMD`.
Plugin-owned (Rivendell): `FFMPEG_BIN`, `WHISPER_BIN`, `WHISPER_MODEL`. Everything else leaves the registry
and stays a plain `.env` value read by `config.py` as today: `DASH_TOKEN`, `DASH_CHAT_ID`, `DASH_ENABLE`,
`DASH_PORT`, `MINIAPP_PORT`, `LANDING_PORT`, `BRIDGE_DB`, `BASE_PATH`, `DEFAULT_PROJECT`,
`PREVIEW_HOSTNAME`, `TUNNEL_NAME`, `TUNNEL_ID`, `TUNNEL_CREDENTIALS_FILE`, `TUNNEL_CONFIG_FILE`,
`CLOUDFLARED_BIN`, `PREVIEW_PORT`, `CLAUDE_BIN`, `CONTEXT_WINDOW`, `ASK_SYSTEM_PROMPT`, `UPLOAD_MAX_MB`,
`UPLOAD_MAX_COUNT`, `UPLOAD_KEEP_DAYS`, `EXTRA_CLAUDE_ARGS`, `MINIAPP_PERMISSION_MODE`, `MCP_SERVERS`,
`RELEVANCE_MODEL`, `RELEVANCE_MIN_CHARS`, `RELEVANCE_CONTEXT_TURNS`, `RELEVANCE_TIMEOUT`, `NEXTUP_MODEL`,
`NEXTUP_DAYS`, `NEXTUP_MAX_REPOS`, `NEXTUP_SCOUT_TIMEOUT`. (The bot path keeps `EXTRA_CLAUDE_ARGS` and
its `acceptEdits` default: a plain-text Telegram turn stays the least autonomous path.) A saved override
for a key that left the registry is dropped by `_load` as today. `.env.example` and the README's env
table are the documentation for the env-only keys.

**AI switches, 12 → 10:** `tasks` → Trackers plugin card, `design` → Claude Design plugin card.

**Rows and buttons:** Accounts `COPY CURRENT LOGIN`; Rivendell form `ws url`; Projects `IMPORT`;
Appearance `BOOT SEQUENCE` (palette command instead); System's HOST / PORT card (folds into the Platform
line); Startup `AS PROFILE` only where it applies (as today), `INSTALL AS APP` hidden inside Mystical.app.

## Cross-surface

- **Mini App:** SYSTEM page keeps limits, theme, collapse steps; the OUTPUT STYLE row becomes COLOUR
  SCHEME (phosphor / contrast). WORK's tracker section shows only with the Trackers plugin installed.
- **Bot:** `/policy`, `/profile`, `/accounts` unchanged. Rivendell's Telegram approval buttons exist only
  while the plugin is installed.
- **Mac app:** unchanged.

## Data and migration

- New file `~/.bridge_state/plugins.json`, `{"rivendell": true, ...}`, mode 0600 like its siblings.
  First boot without it adopts existing state (above).
- `env_settings.json` keeps whatever it holds; keys that left the registry are ignored on load.
- Browser `hud-settings` blobs with removed keys load clean; nothing is rewritten until the next save.
- Hooks tables stay in the schema; no migration touches data.

## Testing

Backend: `tests/test_integrations.py` (registry, install/remove, first-boot adoption, route gating per
plugin), `test_envsettings.py` updated for the ten-row registry and plugin-owned keys, `test_aifeatures.py`
for the two moved switches, hooks and agentconfig tests deleted, the Rivendell and tracker suites install
their plugin in `conftest`. Frontend: `tsc -p tsconfig.app.json` and the `.check.ts` files; `toolwidget`
checks shrink with the languages. Visual: the bridge-eyes capture of each of the eleven tabs in FLINT and
AURORA, compared against the mockups.

## Risks

- The transcript-language removal touches `index.css` on both surfaces (~480 lines each) and every
  component that branched on `toolStyle`; the chat-language-coverage harness goes with it.
- Gating is many small edits across twelve backend files and eighteen frontend files; the parametrised
  not-installed test is what catches a missed one.
- The Claude Design draft push is pending until `/design-login` runs once interactively on this Mac.
