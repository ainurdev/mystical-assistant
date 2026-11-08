# Claude in Chrome: sessions drive the Chrome you use

**Ask (2026-11-06, Telegram):** "plan adding support for Claude Chrome access, mainly on macOS
if other systems are tricky, so the sessions can always by default use the chrome installed on
our macbooks and get their work done by going through websites."

Design written from research only; not yet approved. The open questions in *Verify first* are
the spike that starts the plan.

## Before

- **A session's browser is a throwaway.** `_with_browser` (`bridge/runner.py:422-438`) adds
  `--headless`, a binary and a profile folder to the Playwright and chrome-devtools MCP
  definitions, and `_HIDDEN_BROWSER_NOTE` (`runner.py:181-187`) tells every run never to open
  a visible browser. Those MCPs launch their own Chrome with their own profile: no logins, no
  tabs the user can see, and a profile the user's Chrome refuses to share
  (`envsettings.py:186-191`).
- **Claude Code already ships the thing we want.** `claude --chrome` (CLI 2.1.318 here, `claude
  --help`) connects a session to the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome):
  the session opens its own tabs in the user's running Chrome, in a tab group tied to the
  session, with the user's logins, and pauses for the human on a login page or CAPTCHA. The
  tools are `mcp__claude-in-chrome__*` (navigate, read_page, read_console_messages,
  javascript_tool, tabs_*, gif_creator, browser_batch, …).
- **Nothing in the bridge knows about it.** No `--chrome`, no `claude-in-chrome`, no
  `NativeMessagingHosts` anywhere under `bridge/`, `macos/`, `docs/` or the skills.

## What Claude Code requires (from the docs, 2026-11-06)

- Google Chrome, Edge, or another Chromium browser (Brave, Arc, Vivaldi, Opera), running.
- The *Claude in Chrome* extension 1.0.36+ from the Chrome Web Store, **signed in to the same
  claude.ai account and organization** as the CLI session.
- A direct Anthropic plan and a `/login` sign-in. An API key or a `claude setup-token` token
  keeps Chrome off even with `--chrome`. The bridge's accounts are `claude auth login`
  profiles (`bridge/accounts.py:1-20`), so they qualify.
- Not supported under WSL. Linux desktop and macOS use the same mechanism.
- The first time a session enables Chrome, the CLI writes a native-messaging host manifest
  (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`
  on macOS, `~/.config/google-chrome/NativeMessagingHosts/…` on Linux) and a small host
  wrapper under `~/.claude/chrome/`. Chrome reads the manifest at startup, so the first
  set-up ends with a Chrome restart.
- Enabling: `--chrome` / `--no-chrome` per session, `CLAUDE_CODE_ENABLE_CFC=1` in the
  environment, or the "Enabled by default" setting `/chrome` writes. The flags take
  precedence over both.
- Site permissions are the extension's. The user manages them in the extension
  (`https://clau.de/chrome/permissions`); when Claude Code asks before a browser action,
  it is an ordinary permission request, which the bridge already turns into a card.
- At exit, Claude Code closes the session's tab group only when it holds nothing but empty
  tabs, so pages the user is reading stay open.

## What this Mac showed (probed 2026-11-06)

- Chrome is installed and running; the manifest folder is empty; `~/.claude/chrome` does not
  exist: Chrome integration has never been enabled here.
- From the bridge's process tree the manifest folder is **writable** (probe file created and
  removed), but Chrome's profile folders are **not readable**: `ls "…/Chrome/Default"` and
  the `Local State` file return *Operation not permitted*, sandbox off. So the CLI's own
  "is the extension installed" file scan cannot answer from a bridge session. The reliable
  signal is **connected**, which exists only once the extension actually talks to a session.
- In `-p` stream-json mode the CLI answers a read-only status request on stdin in 0.3 s and
  without an API call: `{"allowed":true,"subscriber":true,"wsl":false,"installed":false,
  "connected":false,"enabled_by_default":false,"urls":{"install":"https://claude.ai/chrome",
  "reconnect":"https://clau.de/chrome/reconnect","permissions":"https://clau.de/chrome/permissions"}}`.
  The same channel reports the login method, email and organization, and the binary version.
  This request is marked internal in the CLI, so the bridge treats it as a best-effort
  accelerator; the documented `system/init` event (`mcp_servers[].status`) is the fallback.

## How it works

1. **One machine setting, three values.** `CHROME_ACCESS` in `bridge/config.py` beside the
   `AI_BROWSER_*` trio (`config.py:95-103`), registered in `bridge/envsettings.py` under the
   BROWSER group with the label **CLAUDE IN CHROME**: `auto` (default), `on`, `off`.
   - `auto` means on as soon as this machine has seen the extension connected once (a
     `chrome_ready` row in the settings table, `store.get_setting`), and off before that, so a
     fresh install never promises a browser it does not have.
   - `on` passes `--chrome` regardless; `off` passes `--no-chrome` regardless.
   - WSL resolves to off with the reason shown, like Device Runs on non-macOS
     (`SettingsModal.tsx:1479-1480`).
2. **Every Claude run says which it is.** `_base_cmd` (`runner.py:524-663`) appends
   `--chrome` or `--no-chrome` to every interactive run with a session id, and `--no-chrome`
   to every one-shot (titler, commit message, next-up scout) and `skip_pack` run. Always one of
   the two, so a user's terminal default never leaks into a bridge run and the titler never
   loads browser tools. ACP agents never reach `_base_cmd`, so this is Claude-only by
   construction, like everything in `profiles.CLAUDE_ONLY` (`profiles.py:488-507`).
3. **A session can switch it off.** The Tools modal gets a **CHROME** row backed by the deny
   rule `mcp__claude-in-chrome`, a known rule in `toolsets.clean()` so a stored session can
   carry it. The runner translates that rule into `--no-chrome` rather than into
   `--disallowedTools`, so a switched-off session pays neither the connection nor the CLI's
   Chrome prompt section. Profiles' `tools` lists carry it the same way.
4. **The run is told what it has.** `_compose_system_prompt` (`runner.py:190-201`) adds a
   `_CHROME_NOTE` on Chrome runs: this is the user's own Chrome on their screen, signed in
   where they are; open your own tabs and leave theirs alone; when a page needs the human
   (login, CAPTCHA, 2FA, a site the extension has not allowed), save a screenshot under
   `.mystical/` and ask with a card rather than wait; never `open <url>` or launch a headed
   browser from Bash. `_HIDDEN_BROWSER_NOTE` stays for the headless MCPs. The CLI's own Chrome
   guidance and bundled skill are left in place.
5. **`bridge/chrome.py` owns status and set-up** (stdlib, never raises into a turn):
   - `status()` → platform support, the Chrome app found, manifest present, wrapper present,
     the `chrome_ready` latch, the last probe result and when it ran, the mode in force.
   - `probe(enable=False)` spawns `claude -p --input-format stream-json --output-format
     stream-json --verbose --no-session-persistence --strict-mcp-config` with `--no-chrome`
     (CHECK) or `--chrome` (SET UP) in a scratch cwd, sends the status request plus the login
     status request, polls for `connected` for up to ~10 s, closes stdin. SET UP is what
     writes the manifest, so it is a button the user presses, never something a turn does.
     One probe at a time (`threading.Lock`), result cached stale-while-revalidate like
     `toolsets.servers()`.
   - `wanted(disabled_tools) -> bool` is the resolver the runner calls: mode, platform, latch,
     session rule.
   - A session's `system/init` event with `claude-in-chrome` connected sets the latch too, so
     a user who set Chrome up from a terminal is ready without pressing anything.
6. **Dashboard: SETTINGS → SYSTEM → BROWSER grows a card** above the env rows, drawn like Device
   Runs (`DeviceRunsPanel.tsx:180-260`): a STATE chip (READY, NOT CONNECTED, OFF, UNSUPPORTED),
   check rows (Chrome found, Claude Code ≥ 2.1.3xx, signed-in account and email, manifest
   installed, extension connected), the MODE segmented control (AUTO / ON / OFF), and buttons:
   CHECK, SET UP (explains that the first run writes the manifest and that Chrome must be
   restarted after it), INSTALL EXTENSION and RECONNECT and PERMISSIONS as plain links the page
   opens itself (the user's click opens the browser, not the bridge). Routes `GET /local/chrome`
   and `POST /local/chrome {action: check|setup|reset}`; a 404 reads as "needs a restart" as in
   `McpPanel`.
7. **The rest of the surfaces say little.** A transcript `log` row when a run asked for Chrome
   and `init` reports it not connected ("Chrome not connected — SETTINGS → SYSTEM → BROWSER"), the
   Mini App SYSTEM tab shows `CHROME · READY/OFF` from `GET /api/chrome`, the bot's `/status`
   gains one line, and `setup.sh doctor` prints whether the manifest is in place.

## Decisions

1. **Explicit flags over the CLI's global default.** Deterministic, testable from `_base_cmd`,
   and the only way one-shots stay browser-free.
2. **`auto` latches on first connection, machine-wide.** The extension is signed in to one
   claude.ai account; the bridge can run several (`accounts.env_for`, `CLAUDE_CONFIG_DIR`). A
   turn handed to another slot by the ladder still gets `--chrome`; if that account is not the
   extension's, the tools report "not connected" and the CLI's own guidance tells the model to
   continue without them. Per-slot readiness is a later step, marked with a `ponytail:`.
3. **Extension detection is "connected", not "installed".** The file scan is blind from the
   bridge on this Mac (EPERM), and a manifest without a signed-in extension is not a browser.
4. **Site permissions stay with the extension.** The bridge changes nothing about which sites
   Claude may act on; it only relays the permission requests the CLI already sends over stdio
   as cards, now with a CHROME badge, and tells the run to screenshot and ask when a page needs
   the human.
5. **macOS first, Linux desktop second, WSL never.** The code path is the same on Linux (manifest
   under `~/.config`, sockets in `/tmp`, the bridge in the user's session); only the "Chrome
   found" check differs. WSL shows the reason and resolves to off.
6. **No Mystical.app change.** Nothing here needs a macOS permission the app holds; the Web
   Store and reconnect pages open from the dashboard page as links.

## Verify first (the spike, at the Mac)

The design assumes these; the spike answers them before Task 1.

1. `claude -p --chrome` with `--input-format stream-json`, `--mcp-config` **and**
   `--strict-mcp-config` still wires `claude-in-chrome`: the `init` event lists it in
   `mcp_servers` with a status, and the tools appear in `tools`.
2. `--disallowedTools mcp__claude-in-chrome` hides every browser tool (the rule the Tools modal
   would store), and `--no-chrome` on a run drops both the tools and the CLI's Chrome prompt
   section.
3. How long after spawn the extension reaches a new session, so `probe()` and the init log row
   wait the right amount, and whether a session that spawns while another is browsing connects
   too.
4. What a `bypassPermissions` run sees on a site the extension has not allowed: a permission
   request over stdio (then the card flow covers it) or a tool result that says so (then the
   note's "screenshot and ask" covers it).
5. Whether one tab group per *process* means one per turn, since every bridge turn is a new
   `-p` process resumed by id; if so, say it in the note and accept it for v1.
6. Whether Chrome needs the restart after SET UP, or picks the manifest up live.

## Out of scope

- The macOS computer-use integration (native apps). Separate feature.
- Making the extension's site permissions configurable from the bridge.
- Per-account readiness and the Windows app. Chrome integration is unsupported under WSL.
- Recording what a session did in the browser beyond what the transcript already keeps (tool
  rows and `_save_result_images`, `runner.py:2312`).
