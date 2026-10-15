# Settings remap: fewer tabs, every tab one question, integrations as installable plugins

2026-10-15 · approved in chat (variant A) · **slice 1 shipped 2026-10-15 as baea7c3 (feat/settings-cuts, 11 commits)** · **v2, same evening: reconciled with the AI MANAGEMENT page
(bf3c71f, 5e3653c, e92c1ac) that landed and shipped meanwhile — kept as is, the remap now builds on it** ·
audit in `.mystical/docs/reports/settings-audit.md` · mockups in `.mystical/design-drafts/settings-remap/`
(`SPEC.md`, `00`–`07` HTML, `shots/`, `after/aimgmt.png` is the live page; the Claude Design push waits on a
one-time `/design-login` on this Mac) · plan: `docs/superpowers/plans/settings-remap-cuts.md` (slice 1; slices 2 and 3 get their own).

## Problem

The dashboard's Settings modal grew a tab per feature: 17 tabs in two groups, 5,800 lines in one file.
Measured on this machine (bridge.db, the state files, the Mac app's saved `hud-settings`, re-read
2026-10-15):

- "Who runs a session" was split over ACCOUNTS, SESSION and CONFIG. **Solved since by AI MANAGEMENT:**
  logins with their profiles beneath them, other agents, skills + the model-spending extras, MCP, the
  default profile and projects, as five folds of one page.
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

1. Fewer tabs, each answering one question named in its first line. The AI MANAGEMENT page is the model:
   one question per page, folds inside it, counts in the fold heads.
2. Integrations ship with Mystical but stay off and invisible until installed from Settings ▸ Integrations.
   Someone who installs Mystical for the session list never meets Rivendell, Teamwork, Jira or Claude Design.
3. Settings holds what you change after install. What a setup script writes once stays in `.env`.
4. Delete what nobody uses rather than regroup it.

Non-goals: out-of-tree plugins (the registry is shaped for it; nothing loads from outside the repo in
this round); the Mini App's SYSTEM page beyond what the cuts force; themes and typefaces; re-opening the
AI MANAGEMENT layout (its run-defaults block duplicates the composer, noted below, left alone).

## The rail — 13 today, 8 after (7 off the Mac)

| Group | Tab | Holds |
|---|---|---|
| THE HUD | Appearance | theme dark/light · CRT effects (CRT themes only) · type |
| | Transcript | layout · composer (send key) · reading (scheme, ground, auto-open results, collapse steps) · working indicator (Equalizer / Status) |
| | Notify | desktop banners · sound (tone, volume) · a note pointing at System ▸ Telegram ▸ push |
| | Mac app | unchanged; Mac only |
| THE WORK | AI management | **as shipped:** Accounts (logins + their profiles, other agents, limit policy) · Skills (installed, catalog, plugins, the model-spending extras) · MCP (+ the AI browser rows) · Default profile · Projects |
| | Integrations | installed plugins with their settings · available plugins with INSTALL |
| | System | folds, in the AI MANAGEMENT grammar: Startup · Platform · Runs · Telegram |
| | Move | export · import |

Gone from the rail: Indicator (folds into Transcript), Ambient (weather stays in the clock popover; the
radio goes), Config, Hooks, Report, Plugins (becomes Integrations).

Rules:

- **Deep links keep working.** `normalizeTab` already maps `projects` / `session` / `accounts` / `mcp` /
  `ai` onto AI MANAGEMENT folds; `plugins` maps onto Integrations, `indicator` onto Transcript, and
  `system` + a fold name onto its fold. `openSettings("plugins", instanceId)` opens the Rivendell card.
- **Scope on a section** where it is not obvious: `This browser` on Appearance / Transcript / Notify
  sections, `Next start` on the System rows that wait for a restart. The header's "where these are
  stored" ⓘ goes.
- **Search** indexes the eight tabs' sections; the env registry's remaining rows fold in as before.
- **Live rail readouts** (mockup 01) are a later polish: FLINT's rail hides the hint line by design today,
  so a readout needs that line back first. The fold heads already carry the counts on the one page that
  has folds.

## Pages

**Appearance.** Today's page minus BOOT SEQUENCE; "Replay the boot intro" becomes a ⌘K palette command.

**Transcript.** LAYOUT (default / compact) · COMPOSER (send key) · READING: one card — colour scheme
(phosphor / contrast), the ground (none + four), auto-open results, collapse steps · WHILE IT WORKS: working
indicator, a two-way segmented control, *Equalizer* / *Status*. The output-style picker goes: DOSSIER is
the one language. (*Show every model* stays where AI MANAGEMENT put it, in Default profile.)

**Notify.** DESKTOP and SOUND as today (switch, tone, volume, a chime on change). PER EVENT and the pack
board go. A note under SOUND: "A Telegram ping for the same moments is under System ▸ Telegram."

**AI management.** Kept as shipped. Changes inside its folds, each in the fold's own idiom:
- Accounts: `COPY CURRENT LOGIN` goes (`+ ADD ACCOUNT` signs in right here).
- Skills ▸ extras: `tasks` and `design` leave for their plugins; **Ponytail** renders only when the
  ponytail Claude Code plugin is installed (`~/.claude/plugins/installed_plugins.json`); **Project map**
  shows "Needs graphify on PATH — not found" with the install line when `graphmap.graphify_bin()` is
  None, switch disabled; the fold's `on of total` counts only cards shown.
- MCP: an AI BROWSER card holding the three browser rows (hidden, binary, profile folder) that configure
  the Playwright and chrome-devtools servers.
- Projects: the IMPORT row goes (browser-local stub). A DEFAULT COMMAND row (`START_CMD`) at the foot.
- Default profile: unchanged. (Its model / mode / effort block repeats the composer; the page's own note
  says the session owns them. Left alone; a candidate for a later trim.)

**Integrations.** INSTALLED: one card per installed plugin with its settings inside (Rivendell: instances
with today's form minus `ws url`, TEST LINK / SEND TEST JOB, a VIDEO JOBS line showing whether ffmpeg,
whisper-cli and the model file are found; Trackers: today's TRACKERS panel plus the Task digest switch;
Claude Design: the card says what it adds) · AVAILABLE: a card per plugin not installed — Teamwork, Jira
(both install `trackers`), Claude Design, Rivendell — with what it adds, what it needs, INSTALL. Mockup 07.

**System.** Four folds. STARTUP: start at login, open the window too, the browser-profile picker where it
applies, *install as app* only where a browser can install · PLATFORM: one line with branch, commit,
host:port and the store path, RESTART BRIDGE; UPDATE; API TRAFFIC → open inspector · RUNS: new sessions
start in (`NEW_SESSION_PERMISSION_MODE`), run timeout, auto-resume · TELEGRAM (`Next start` where it
applies): bot token (masked), allowed chat ids, the Mini App switch, a read-only tunnel line (`Named ·
connected` / `Quick tunnel` / `Off`, hostname, port, "set up by `mystical setup`"), ping on finish
(`NOTIFY_ENABLE`). Mockups 04 and 05 are these folds' contents.

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
  button, MoveDock's Rivendell actions, the SKILLS fold's extras and the Mini App's WORK route all read
  it. The Mini App gets the flags on `/state`.
- Tests: one parametrised test per plugin asserts that with it not installed its routes 404, its origins
  are not plugin origins, and its env keys are absent from the registry; one test covers first-boot
  adoption; the existing Rivendell and tracker suites run with the plugin installed in `conftest`.

**Ownership.**

| Plugin | Code it owns | Settings inside its card |
|---|---|---|
| **Rivendell** | `rivendell.py`, `rivendell_instances.py`, `rivendell_video.py`, origins `rivendell:*`, env `FFMPEG_BIN` `WHISPER_BIN` `WHISPER_MODEL`, the RIVENDELL right-rail tab, the queue cards, Telegram approvals, the video kind | instances (today's form minus `ws url`), TEST LINK / SEND TEST JOB, a VIDEO JOBS line |
| **Trackers** (Teamwork, Jira) | `trackers.py`, the TASKS tab, LINK TASKS, the Task digest switch, the tracker MCP entries, Mini App WORK | connections (today's TRACKERS panel), the Task digest switch |
| **Claude Design** | `designsync.py`, `design_project` in project config, DesignTab, the composer DESIGN button, `/design-first` and `/design-implement`, the design pull in `skills.py` | nothing beyond the per-repo link in ANALYZE; the card says what it adds |

## What goes

**Tabs:** Hooks (feature and code: `hooks.py`, both server routes, the Mini App endpoint, `HooksPanel`,
`test_hooks.py`, `test_hooks_endpoint.py`; the two DB tables stay, empty) · Config (`agentconfig.py`, its
route, `AgentConfigPanel`, `test_agentconfig.py`) · Report (the tab only; `WeekPanel` keeps its two homes)
· Ambient (weather stays in the clock popover; the radio goes) · Indicator (folds into Transcript) ·
Plugins (becomes Integrations).

**Features:** nyan / piano / tiles (`lib/nyan.ts`, `lib/songs.ts`, `lib/piano.ts`, `usePianoEngine.ts`,
`PianoKeyboard.tsx`, `PianoIndicator.tsx`, `TilesIndicator.tsx`, their branches in `WorkingIndicator.tsx`)
· Claude·FM (`lib/ambient.ts`, the header pill and its App state) · the five extra transcript languages
(`TOOL_STYLES` shrinks to DOSSIER on both surfaces; `[data-style="stamp|wire|signal|press|halo"]` CSS
goes on both; the Mini App's `/output` route becomes scheme + collapse steps) · per-event sound packs
(`lib/sounds.ts`, `SoundBoard`, `PUSH_EVENTS` keep only the tone path) · Move ▸ Progress (`MovePrefs`, the
page, the bar/thickness/corner/mini variants in `MoveDock`) · the Projects import stub · the Boot sequence
section · `COPY CURRENT LOGIN`.

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

**Rows and buttons:** Rivendell form `ws url`; System's HOST / PORT card (folds into the Platform line);
Startup `AS PROFILE` only where it applies (as today), `INSTALL AS APP` hidden inside Mystical.app.

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

## Delivery order

Three slices, each shippable alone, oldest risk first. Every cut is its own commit so a regret is one
revert.

1. **Cuts that touch nothing of AI MANAGEMENT** — Hooks, Config, Report tab, Ambient + radio, Indicator
   fold-in + games, sound packs, Move progress, Boot replay → palette, import stub, `COPY CURRENT LOGIN`,
   the `HudSettings` fields. Then the transcript languages as the last and largest cut (both surfaces).
2. **Integrations as plugins** — registry, adoption, gating, the Integrations page replacing PLUGINS,
   Trackers out of SYSTEM, `tasks` / `design` into their cards, Mini App gating, the parametrised test.
3. **System as folds** — Telegram fold, env registry 46 → 10, AI TUNING rows out of the UI, browser rows
   into the MCP fold, HOST/PORT into the Platform line. Then the polish: dependency-aware extras cards,
   live rail readouts when FLINT's rail shows a second line.

## Testing

Backend: `tests/test_integrations.py` (registry, install/remove, first-boot adoption, route gating per
plugin), `test_envsettings.py` updated for the ten-row registry and plugin-owned keys, `test_aifeatures.py`
for the two moved switches, hooks and agentconfig tests deleted, the Rivendell and tracker suites install
their plugin in `conftest`. Frontend: `tsc -p tsconfig.app.json` and the `.check.ts` files; `toolwidget`
checks shrink with the languages. Visual: the bridge-eyes capture of each of the eight tabs in FLINT and
AURORA, compared against the mockups and the live `after/aimgmt.png`.

## Risks

- The transcript-language removal touches `index.css` on both surfaces (~480 lines each) and every
  component that branched on `toolStyle`; the chat-language-coverage harness goes with it.
- Gating is many small edits across twelve backend files and eighteen frontend files; the parametrised
  not-installed test is what catches a missed one.
- AI MANAGEMENT is a day old and a collaborator's; edits inside its folds stay small and in its idiom
  (`aim-*` classes, `SkillsFold` card grammar) so two people are not reshaping one file at once.
- The Claude Design draft push is pending until `/design-login` runs once interactively on this Mac.
