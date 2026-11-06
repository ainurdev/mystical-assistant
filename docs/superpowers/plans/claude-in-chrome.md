# Claude in Chrome Implementation Plan

**Goal:** A Claude session run by the bridge can use the Chrome the user already uses, through
Claude Code's own Chrome integration, on by default once the machine is set up, switchable per
session, and never offered to one-shots or agent sessions.

**Architecture:** One machine setting (`CHROME_ACCESS`: auto / on / off), one resolver
(`chrome.wanted`), one flag on every Claude argv (`--chrome` or `--no-chrome`), one status and
set-up module (`bridge/chrome.py`) behind `GET/POST /local/chrome`, one card in SETTINGS →
SYSTEM → BROWSER, one row in the Tools modal, one note in the appended system prompt.

**Tech Stack:** Python 3 stdlib (`subprocess`, `json`, `threading`, `sqlite3`), React 19 +
TypeScript + Vite in `bridge/dashboard/web` and `bridge/miniapp/web`, pytest, Claude Code CLI
2.1.318.

**Spec:** [`docs/superpowers/specs/claude-in-chrome-design.md`](../specs/claude-in-chrome-design.md)

## Global constraints

- Backend stdlib only; no new dependency on either frontend.
- Work in a worktree (`bridge-worktree`): `git worktree add -b feat/claude-in-chrome
  ~/workspace/ainur/.worktrees/mystical-assistant/feat-claude-in-chrome`, copy `.env`, scratch
  DB for any manual run (`BRIDGE_DB=/tmp/wt-chrome.db`). Never restart the live bridge from a
  session; ship through ⟳ (`bridge-ship`).
- `tests/conftest.py` pins env before `bridge.config` imports; no env setup in test modules.
- Every `os.environ.get` added to `config.py` needs a row in `envsettings.SETTINGS` and a line
  in `.env.example` (`tests/test_envsettings.py:140-156`, `tests/test_env_example.py`).
- `ponytail:` comments are load-bearing; module docstrings carry the why.
- Commit messages are one line, no trailers, no AI attribution.
- Routes are matched by hand: specific paths before `startswith` matches
  (`bridge/dashboard/server.py:406`, `:1019`).
- The flag is Claude-only by construction (`runner.start_streaming_job`, `:2970-2975` sends
  agents to `AcpJob`); nothing in this plan touches `acp*.py`.

## Review focus

1. **A one-shot must never carry `--chrome`.** The titler and commit-message runs embed
   untrusted text (`runner.py:629-637`); a browser there is an injection vector. Task 3's
   `test_one_shots_always_get_no_chrome` covers both branches.
2. **A session that switched Chrome off must get `--no-chrome`, not a deny rule.** Otherwise
   the connection and the CLI's Chrome prompt section still cost the run. Task 3's
   `test_session_rule_becomes_no_chrome`.
3. **The probe must never touch the live DB or a project.** It runs in a scratch cwd under
   `TMPDIR` with `--no-session-persistence`, and only SET UP passes `--chrome`. Task 2's
   `test_check_never_passes_chrome`.
4. **Auto mode before the latch is off.** A fresh machine must not promise a browser. Task 2's
   `test_auto_is_off_until_connected`.
5. **A stale dashboard against a new bridge, and the reverse.** `GET /local/chrome` 404 reads as
   "needs a restart" (as `McpPanel`, `SettingsModal.tsx:2075-2097`); an old session row without
   the rule still resolves (`toolsets.clean` keeps unknown rules out, `toolsets.py` end).

## File structure

| File | Change | Responsibility |
|------|--------|----------------|
| `bridge/chrome.py` | create | status, probe, latch, `wanted()` |
| `bridge/config.py` | modify | `CHROME_ACCESS` beside `AI_BROWSER_*` (`:95-103`) |
| `bridge/envsettings.py` | modify | BROWSER group row for `CHROME_ACCESS` (`:172-191`) |
| `.env.example` | modify | the new key with its three values |
| `bridge/runner.py` | modify | flag in `_base_cmd`, `_CHROME_NOTE`, init log row + latch |
| `bridge/toolsets.py` | modify | `CHROME_RULE`, known in `clean()`, offered as a builtin row |
| `bridge/store.py` | modify | nothing structural; `chrome_ready` is a `settings` row |
| `bridge/dashboard/server.py` | modify | `GET/POST /local/chrome`; `/local/toolsets` carries the row |
| `bridge/miniapp/server.py` | modify | `GET /api/chrome` (status only) |
| `bridge/dispatch.py` | modify | one line in `/status` (`:345`) |
| `setup.sh` | modify | one `doctor()` line (`:42-79`) |
| `bridge/dashboard/web/src/api.ts` | modify | `chrome()`, `chromeAction()`, types |
| `bridge/dashboard/web/src/components/hud/SettingsModal.tsx` | modify | `ChromePanel` above `<EnvPanel />` (`:4516`) |
| `bridge/dashboard/web/src/components/hud/ToolsModal.tsx` | modify | CHROME row (`:107`) |
| `bridge/miniapp/web/src/routes/system.tsx` | modify | `CHROME · …` line (`:16-20`) |
| `tests/test_chrome.py` | create | resolver, status, probe parsing |
| `tests/test_chrome_endpoint.py` | create | both servers' routes |
| `tests/test_mcp_startup.py` | modify | argv cases |
| `tests/test_toolsets.py` | modify | the rule is known and never hits `--disallowedTools` |
| `.mystical/docs/chrome-spike.md` | create (git-ignored) | the spike's findings |

Bridge-feature-slice rows: 1 `chrome.py`; 2 skipped (a settings row, no schema); 3, 4, 5, 6, 7,
8 as listed; 9 one `/status` line, `HELP` unchanged; 10 skipped (nothing changes mid-turn);
11 the two test files.

---

### Task 0: Spike at the Mac (needs the user present)

Answers the six *Verify first* questions in the spec before any code. Nothing from it is kept
but the notes.

- [ ] **Step 1: Install and connect once, by hand.** In Chrome: install the extension from
  `https://claude.ai/chrome`, sign in with the same account the bridge's default slot uses
  (`/status` in a terminal `claude` shows it). In a terminal: `claude --chrome`, accept the
  one-time dialog, run `/chrome` until it shows *Status: Enabled* and *Extension: Installed*.
  Restart Chrome if the docs' troubleshooting says so. Confirm the manifest exists at
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`.
- [ ] **Step 2: The bridge-shaped run.** From a scratch dir, with `BRIDGE_DB=/tmp/wt-chrome.db`,
  reproduce the bridge's argv by hand (`_base_cmd` at `runner.py:524-663`): `claude -p
  --output-format stream-json --verbose --input-format stream-json --permission-mode
  bypassPermissions --permission-prompt-tool stdio --mcp-config <a file with only goals/verify>
  --strict-mcp-config --chrome --model claude-haiku-5-5 --session-id <uuid4>`, send one user
  message asking it to open `https://example.com` in a new tab and read the heading. Record the
  `init` event (`tools`, `mcp_servers`), the first browser tool call's timing, any
  `control_request` of subtype `can_use_tool` and its fields, and the result.
- [ ] **Step 3: The off switches.** Repeat with `--no-chrome` (expect no `claude-in-chrome` in
  `mcp_servers`, no browser tools) and with `--chrome --disallowedTools mcp__claude-in-chrome`
  (expect the server listed but no tools).
- [ ] **Step 4: A second session while the first browses.** Two runs at once from two dirs;
  note whether both connect and whether each gets its own tab group, and whether a *resumed*
  session (`--resume <id>`) reuses the first turn's group or opens a new one.
- [ ] **Step 5: A site the extension has not allowed.** Ask the run to open a site never
  visited; record whether a permission request arrives on stdout, whether the extension asks
  in Chrome, or whether the tool result explains.
- [ ] **Step 6: Write it down.** `.mystical/docs/chrome-spike.md` with the raw `init` event, the
  timings, and one line per question. Update the spec's *Verify first* section into *Verified*.
  If Step 2 fails outright under `-p`, stop: the plan changes to a `CLAUDE_CODE_ENABLE_CFC=1`
  env experiment first, and the user decides.

### Task 1: The setting

**Files:** `bridge/config.py:95-103`, `bridge/envsettings.py:172-191`, `.env.example`,
`tests/test_envsettings.py`.

- [ ] **Step 1: Failing test.** In `tests/test_envsettings.py`, a case that `CHROME_ACCESS` is in
  `envsettings.SETTINGS` with `type == "enum"`, `choices == ["auto", "on", "off"]`, `live` true,
  group `BROWSER`, and that `coerce("CHROME_ACCESS", "maybe")` raises `ValueError`
  (pattern: `NEW_SESSION_PERMISSION_MODE`, `envsettings.py:102-110`, `:360-364`).
- [ ] **Step 2: Config.** After `AI_BROWSER_PROFILE`:
  `CHROME_ACCESS = os.environ.get("CHROME_ACCESS", "auto").strip().lower() or "auto"`, with a
  comment in the file's voice: the user's own Chrome through Claude Code's extension; `auto`
  waits for the first connection.
- [ ] **Step 3: Registry row.** Label `CLAUDE IN CHROME`, hint "sessions drive the Chrome you
  use, through the Claude in Chrome extension", `about` naming the three values and that `auto`
  turns on once the extension has connected once. Add `CHROME_ACCESS=auto` to `.env.example`
  under the browser block.
- [ ] **Step 4: Run** `python3 -m pytest tests/test_envsettings.py tests/test_env_example.py -q`.
- [ ] **Step 5: Commit** `chrome: the CLAUDE IN CHROME setting`.

### Task 2: `bridge/chrome.py`

**Files:** create `bridge/chrome.py`; create `tests/test_chrome.py`.

**Interfaces:**
- `supported() -> tuple[bool, str]`: `(False, "Chrome integration isn't supported under WSL")`
  via `startup._wsl()` (`startup.py:110-112`); True elsewhere.
- `chrome_app() -> str | None`: macOS `/Applications/Google Chrome.app` or
  `~/Applications/…`, else Edge/Brave/Chromium/Arc/Vivaldi/Opera by the same rule; Linux
  `shutil.which` over `google-chrome`, `google-chrome-stable`, `microsoft-edge`, `brave-browser`,
  `chromium`, `chromium-browser`.
- `manifest_paths() -> list[str]`: every candidate manifest path for the browsers found
  (macOS: `~/Library/Application Support/<vendor dir>/NativeMessagingHosts/`
  `com.anthropic.claude_code_browser_extension.json`; Linux `~/.config/<browser>/…`).
- `ready() -> bool` / `set_ready(flag)`: the `chrome_ready` settings row (`store.get_setting`,
  `store.py:873-887`).
- `mode() -> str`: `config.CHROME_ACCESS` normalised to one of the three.
- `wanted(disabled_tools: list[str] | None) -> bool`: `supported()[0]` and
  `toolsets.CHROME_RULE not in (disabled_tools or [])` and (`mode() == "on"` or
  (`mode() == "auto"` and `ready()`)).
- `probe(enable: bool = False, timeout: float = 12.0) -> dict`: spawns the CLI as the spec says,
  in `tempfile.mkdtemp(prefix="mystical-chrome-")` under `TMPDIR`, env from
  `runner._run_env(None)` so the default account's profile applies, sends the status request
  and the login status request, re-sends the status request every second until `connected` or
  the deadline, closes stdin, waits, kills on overrun. Returns
  `{ok, connected, installed, allowed, subscriber, wsl, enabled_by_default, urls, email,
  login, version, error, at}`. `enable=False` passes `--no-chrome`; `enable=True` passes
  `--chrome`. A connected result calls `set_ready(True)`.
- `status() -> dict`: `{mode, supported, reason, app, manifest, manifest_paths, wrapper,
  ready, effective, probe}` where `effective` is `wanted(None)` and `probe` the cached last
  result (`None` before any).
- `invalidate()`; one `threading.Lock` around the probe; a second caller gets the cached
  result, never a second CLI.

- [ ] **Step 1: Failing tests** in `tests/test_chrome.py`:
  - `test_auto_is_off_until_connected`: `monkeypatch.setattr(config, "CHROME_ACCESS", "auto")`,
    no latch → `wanted(None) is False`; `set_ready(True)` → True; the rule in the list → False.
  - `test_on_and_off_ignore_the_latch`.
  - `test_wsl_is_unsupported` via `monkeypatch.setattr(startup, "_wsl", lambda: True)`.
  - `test_check_never_passes_chrome` and `test_setup_passes_chrome`: a fake `claude` script on
    PATH (pattern: `tests/test_launchd_handover.py:24-60`) that records argv to a file and
    answers each stdin line `{"type":"control_request",…}` with a canned
    `control_response` (connected false, then true on the second ask), so the probe's polling
    and parsing are exercised; assert `--no-chrome` / `--chrome` in the recorded argv,
    `--no-session-persistence` present, cwd under `TMPDIR`.
  - `test_probe_survives_a_missing_binary`: `config.CLAUDE_BIN` is conftest's
    `no-real-claude`; `probe()` returns `ok False` with an `error`, raises nothing.
  - `test_connected_probe_sets_the_latch`.
- [ ] **Step 2: Write the module** with a docstring that says why "connected" and not
  "installed" (the EPERM finding), why SET UP is a button, and why the status request is
  best-effort (internal to the CLI; the `init` event is the documented fallback). Mark the
  machine-wide latch with `ponytail: one latch for every account slot; per-slot readiness
  when a second signed-in extension exists.`
- [ ] **Step 3: Run** `python3 -m pytest tests/test_chrome.py -q`.
- [ ] **Step 4: Commit** `chrome: status, probe and the readiness latch`.

### Task 3: The runner

**Files:** `bridge/runner.py:181-201` (notes), `:524-663` (`_base_cmd`), `:2276-2281` (init);
`bridge/toolsets.py` (rule); `tests/test_mcp_startup.py`, `tests/test_toolsets.py`.

- [ ] **Step 1: Failing tests** in `tests/test_mcp_startup.py` (helper `_cmd`, `:27-32`):
  - `test_interactive_run_gets_chrome_when_wanted`: `monkeypatch.setattr(chrome, "wanted",
    lambda d: True)` → `"--chrome" in cmd` and `"--no-chrome" not in cmd`.
  - `test_interactive_run_gets_no_chrome_when_not_wanted`.
  - `test_session_rule_becomes_no_chrome`: `disabled_tools=[toolsets.CHROME_RULE]` →
    `--no-chrome`, and the rule is absent from the `--disallowedTools` value.
  - `test_one_shots_always_get_no_chrome`: `runner._base_cmd("t", 555, stream=False,
    skip_pack=True)` and the next-up variant (`permission_mode="plan"`) → `--no-chrome` even with
    `wanted` patched True.
  - `test_note_names_chrome_only_on_chrome_runs`: the `--append-system-prompt` value contains
    `_CHROME_NOTE` only when wanted.
  In `tests/test_toolsets.py`: `clean([toolsets.CHROME_RULE, "nonsense"]) ==
  [toolsets.CHROME_RULE]` with `servers` patched to `[]`.
- [ ] **Step 2: `toolsets.py`.** `CHROME_RULE = "mcp__claude-in-chrome"`; `clean()`'s `known`
  gains it; `BUILTINS`-shaped row `CHROME_ROW = {"rule": CHROME_RULE, "label": "Chrome",
  "hint": "your Chrome, through the Claude in Chrome extension"}` exported for the servers to
  add only when `chrome.status()["supported"]`.
- [ ] **Step 3: `_base_cmd`.** Compute `on = interactive and claude_session_id and not skip_pack
  and chrome.wanted(disabled_tools)`; strip `CHROME_RULE` from the list that reaches
  `--disallowedTools`; append `["--chrome"] if on else ["--no-chrome"]` right after the
  permission block. Local import of `bridge.chrome` inside the function, as `toolsets` does
  for `runner`.
- [ ] **Step 4: The note.** `_CHROME_NOTE` next to `_HIDDEN_BROWSER_NOTE` (text per the spec's
  step 4); `_compose_system_prompt` takes `chrome: bool` and inserts it after the hidden note.
  Only `_base_cmd` passes it.
- [ ] **Step 5: Init.** In `_handle_event` (`:2276`), on `system/init` read
  `d.get("mcp_servers")`; if the job asked for Chrome (`job.chrome`, set in `_run_streaming`
  from the same resolver) and `claude-in-chrome` is missing or not `connected`, add
  `{"type": "log", "src": "chrome", "text": "Chrome not connected — SETTINGS → SYSTEM →
  BROWSER"}`; if connected, `chrome.set_ready(True)` when not already.
- [ ] **Step 6: Run** `python3 -m pytest tests/test_mcp_startup.py tests/test_toolsets.py
  tests/test_chrome.py -q`, then the whole suite.
- [ ] **Step 7: Commit** `chrome: every Claude run says --chrome or --no-chrome`.

### Task 4: Routes

**Files:** `bridge/dashboard/server.py` (`_get_api` near `:526`, `_post_api` near `:1225`,
`/local/toolsets` `:963-967`), `bridge/miniapp/server.py` (near `:395`);
create `tests/test_chrome_endpoint.py`.

- [ ] **Step 1: Failing tests** with the `Handler.__new__` pattern
  (`tests/test_toolset_endpoints.py:19-23`): `GET /local/chrome` returns `chrome.status()`'s
  keys; `POST /local/chrome {"action": "check"}` calls `probe(enable=False)` (patched) and
  returns the fresh status; `"setup"` calls `probe(enable=True)`; `"reset"` clears the latch;
  an unknown action is a 400; `GET /api/chrome` on the Mini App returns `{mode, effective,
  ready, supported}` only; `/local/toolsets` carries the Chrome row only when supported.
- [ ] **Step 2: Dashboard routes.** `GET /local/chrome` → `self._json(chrome.status())`.
  `POST /local/chrome` behind the existing `X-Dash-Token` gate; `setup` and `check` run the
  probe synchronously (bounded by its timeout) and answer the status.
- [ ] **Step 3: Mini App route** `GET /api/chrome`, `X-Telegram-Init-Data` like `/api/profiles`.
- [ ] **Step 4: Run** the two endpoint files, then the suite.
- [ ] **Step 5: Commit** `chrome: /local/chrome and /api/chrome`.

### Task 5: Dashboard

**Files:** `bridge/dashboard/web/src/api.ts` (near `:1905`), `SettingsModal.tsx`
(`ChromePanel` before `<EnvPanel />` at `:4516`; `SEC_DESC.BROWSER` `:438`), `ToolsModal.tsx:107`.

- [ ] **Step 1: `api.ts`.** `ChromeStatus` type mirroring `status()`; `chrome: () =>
  req<ChromeStatus>("/local/chrome")`; `chromeAction: (action) => req<ChromeStatus>(
  "/local/chrome", {method: "POST", body: {action}})`.
- [ ] **Step 2: `ChromePanel`.** A `Section`-less card inside the BROWSER section, built from
  `Row`, `Chip`, `Segmented`, `MiniBtn` (`SettingsModal.tsx:492-517`, `:599-642`, `:2770`):
  - STATE row: chip `READY` (ok) / `NOT CONNECTED` (warn) / `OFF` (muted) / `UNSUPPORTED` (warn
    with the reason as `desc`).
  - CHECKS row: `✓/✗ CHROME FOUND`, `✓/✗ CLAUDE CODE 2.1.3xx`, `✓/✗ SIGNED IN · email`,
    `✓/✗ MANIFEST`, `✓/✗ EXTENSION CONNECTED` (the DeviceRuns check-line style).
  - MODE row: `Segmented` AUTO / ON / OFF writing `CHROME_ACCESS` through
    `api.setEnvSetting`, so the env row for it is hidden from `EnvPanel` (filter the key out
    of the BROWSER group there).
  - ACTIONS row: `CHECK` and `SET UP` (`MiniBtn primary`, `desc` "writes Claude Code's
    native-messaging manifest; restart Chrome afterwards"), busy text `CHECKING…` /
    `CONNECTING…`; links `INSTALL EXTENSION`, `RECONNECT`, `PERMISSIONS` rendered as `<a
    target="_blank" rel="noreferrer">` to the URLs the status carries.
  - A 404 on `GET /local/chrome` renders `NEEDS A RESTART` like `McpPanel`.
  - Update `SEC_DESC.BROWSER` to mention both browsers (the one the AI drives hidden, and your
    own Chrome).
- [ ] **Step 3: Tools modal.** Render the Chrome row from `sets.builtins` as it already does
  (`ToolsModal.tsx:107`); nothing new if the server adds the row there. If the row should sit
  apart, a `Chrome` group under the builtins.
- [ ] **Step 4: Typecheck and build.** `cd bridge/dashboard/web && node_modules/.bin/tsc -p
  tsconfig.app.json` from master's `node_modules`, then `npm run build`.
- [ ] **Step 5: Look at it** with `bridge-eyes`: the BROWSER section in all four states, saved to
  `.mystical/shots/chrome-*.png`.
- [ ] **Step 6: Commit** `chrome: the CLAUDE IN CHROME card and the Tools row`.

### Task 6: The small surfaces

**Files:** `bridge/miniapp/web/src/routes/system.tsx:16-20`, `bridge/dispatch.py:345`,
`setup.sh:42-79`, `tests/test_bridge.py` (status text) if it pins `/status`.

- [ ] **Step 1: Mini App.** A `CHROME · READY / NOT CONNECTED / OFF / UNSUPPORTED` line from
  `GET /api/chrome`; a 404 hides the line.
- [ ] **Step 2: Bot.** One line in `/status`: `Chrome: ready` / `off` / `not set up` from
  `chrome.status()` (cached, no probe).
- [ ] **Step 3: doctor.** Under Optional: `ok "Claude in Chrome — manifest in place"` when any
  `manifest_paths()` exists, else `warn "Claude in Chrome — not set up: SETTINGS → SYSTEM →
  BROWSER → SET UP"`. Shell only; no Python call.
- [ ] **Step 4: Tests** for the `/status` line (pattern of the existing `/status` test) and
  run the suite.
- [ ] **Step 5: Commit** `chrome: status line in the Mini App, the bot and doctor`.

### Task 7: Docs and ship

- [ ] **Step 1:** Changelog entry (`changelog` skill). One line in `CLAUDE.md` under *Project
  skills* is not needed; add a sentence to the BROWSER settings `about` text instead.
- [ ] **Step 2:** Full suite green (`python3 -m pytest tests/ -q`; on this Mac
  `.mystical/testenv/bin/python -m pytest tests/ -q -p no:cacheprovider`, with the seven
  environmental failures as the floor).
- [ ] **Step 3:** Merge `feat/claude-in-chrome` into master, remove the worktree, tell the user
  ⟳ on the right rail rebuilds the dashboard and restarts the bridge (`bridge-ship`).
- [ ] **Step 4:** First real use: a session asked to open a page the user is logged in to, from
  Telegram, with the user away from the Mac. Watch for the card when a page needs them.
