# Device runs: Mystical implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A Mac whose owner turns on **Share this device** runs teammates' device runs as a hidden macOS user.
- Any Mystical can list the shared devices that are on, send a run from a chat, and get the report back into that chat with its screenshots.

**Architecture:** new modules, each with one job and a thin hook into the existing Rivendell worker, so the in-flight settings remap (`feat/integrations`, which rewrites the PLUGINS tab) merges cleanly.
- `device_share` — what this device is and whether it's ready.
- `device_setup` — the one-password setup and the root helper.
- `device_side` — running a teammate's run.
- `device_ask` — snapshot, file, hand-back.

**Tech Stack:** Python 3 stdlib (bridge), the system `/usr/bin/python3` for the root helper, bash (setup/remove, run as root through `osascript … with administrator privileges`), React + TypeScript (dashboard), pytest.

**Spec:** `/Users/mhzrerfani/Projects/.worktrees/rivendell/feat-device-runs/docs/superpowers/specs/2026-10-16-own-mystical-and-device-runs-design.md`, Part 2 ("Mystical", "Isolation and authorship"). The Rivendell half: `…/feat-device-runs/docs/superpowers/plans/2026-10-16-device-runs-rivendell.md`, whose **Contract** section is the API both sides build against. Visual target: drafts E–J in `/Users/mhzrerfani/Projects/ainurhq/rivendell/.mystical/design-drafts/device-runs/` (`04-mystical-pick-a-device.html`, `05-mystical-share-this-device.html`, `shots/`).

## Global Constraints

- **Naming:** a person reads *device* ("Share this device", "device run", "Which device should run it?"). macOS, Xcode and iOS appear only in a device's own facts. The hidden user is `mysticalruns`, and its full name is `Mystical Runs`.
- **Stdlib only** in the bridge. No new npm dependency in the dashboard.
- **Work in this worktree**, per the `bridge-worktree` skill.
  - Never `mystical restart`, and never touch `~/.bridge_state/bridge.db`. Tests pin `BRIDGE_DB` already.
  - **Never run `setup.sh` or `remove.sh`** in a task. They create and delete a macOS user. The owner runs Set up once at the end.
- **Commits:** `area: sentence`, with no Claude attribution or co-author line (user rule), committed with `git commit -- <paths>`.
- **Backend suite:** `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q`. Baseline on master `d1ce4f5`: the 7 known macOS failures (`test_clip_panel` ×1, `test_map_command` ×4, `test_startup` ×2). Anything else red is yours.
- **Type-check:** from `bridge/dashboard/web`, `./node_modules/.bin/tsc -p tsconfig.app.json --noEmit`. `node_modules` is missing in a fresh worktree; `npm ci` there first.
- **Paths:**
  - `/usr/local/libexec/mystical-run-helper` — the helper (root:wheel 0755)
  - `/usr/local/etc/mystical-runs.json` — `{"owner": "<short name>", "uid": <int>, "launch": "sudo"}` (root 0644)
  - `/etc/sudoers.d/mystical-runs` (0440)
  - `/Users/Shared/Mystical Runs/<run id>/` — the owner's stage (0700)
  - `/Users/mysticalruns/runs/<run id>/{code,out,config}`
- **Device id:** `hashlib.sha256(IOPlatformUUID.encode()).hexdigest()[:16]`.
- **Run id:** a UUID, matched by `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` everywhere it crosses a privilege boundary.
- **Limits:** snapshot ≤ 9 MB after gzip; at most 20 screens, each ≤ 5 MB; run timeout = the instance's `impl_timeout`.
- **Frames and routes:** exactly the Rivendell plan's Contract. Device calls carry `X-Mystical-Device-Id`.

## Rulings

1. **Instance.**
   - The tools use the **first enabled instance with a token**.
   - `RunOnDevice` also needs that instance's `device_token`. Without one it answers `Save your Claude token for device runs in Settings › Plugins first.`
   - Share this device is per instance: on by default, and it only advertises when READY.
2. **One device run at a time on a device.** A second is acked `queued` and starts by itself when the first ends: no ACCEPT tap and no Telegram ask, because the Rivendell permission is the consent. The owner's own runs never block one, since a run is another macOS user.
3. **"Started on …" is a notice, not a turn.** On `device-run-update` RUNNING, the asking bridge records it and sends `telegram.send(config.DASH_CHAT_ID, …)`. Only the final result queues a turn, so nobody pays for a Claude turn that says "started".
4. **The helper launches with `sudo -u` by default.** `launch: "asuser"` (`launchctl asuser <uid> sudo -u …`) is the one alternative it accepts, picked from `/usr/local/etc/mystical-runs.json` after the Simulator test. Anything else is refused.
5. **The PR section** sits between `<!-- mystical:device-run -->` and `<!-- /mystical:device-run -->`, titled `### Device run on {device}`. A later run replaces it.
6. **The settings live in a new `DeviceRunsPanel`**, mounted under `RivendellPanel` (one line). `Section`, `Row` and `Switch` become exports of `SettingsModal.tsx` so the panel can use them. The settings remap later wraps both panels in the Rivendell integration card.

## Review Focus

1. **A run reaching the owner's account.** The helper must refuse:
   - a caller other than the recorded owner uid;
   - a run id that isn't a UUID;
   - a stage that is a symlink, isn't owned by the owner, or isn't 0700.

   It must extract the code **as `mysticalruns`**, never as root. Tests: Task 2.
2. **The token left behind.**
   - The stage's `token` file and `/Users/mysticalruns/runs/<id>/` must be gone after success, failure, timeout and stop.
   - Claude must get the token only through the environment of the `mysticalruns` process.

   Tests: Task 2 (helper cleanup paths), Task 3 (stage cleanup on every outcome).
3. **Another device wins the claim.** A 409 on claim must drop the run quietly: no FAILED post, no notice, the queue freed. Test: Task 3.
4. **A snapshot over 9 MB, a folder that isn't a git checkout, or an origin that isn't GitHub.** Expect one clear sentence back to Claude, and nothing filed on Rivendell. Tests: Task 4.
5. **The result arrives while the asking session is gone or busy.**
   - Session gone: the PR section and `delivered` still happen, plus a Telegram notice.
   - Session busy: the turn is queued (`queue_manager` waits for idle).

   Tests: Task 4.

---

### Task 1: What this device is — `device_share` and the handshake

**Files:**
- Create: `bridge/device_share.py`, `tests/test_device_share.py`
- Modify:
  - `bridge/rivendell_instances.py`: `_clean` and `_masked` gain `share_device` (bool, default True) and `device_token` (secret, kept when blank on edit, masked to `"…"+last4`)
  - `bridge/dashboard/server.py`: the POST `/local/rivendell` `fields` whitelist
  - `bridge/dashboard/web/src/api.ts`: `RivendellInstance`, `RivendellInput`
  - `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`: `riToInput` carries both, so a toggle doesn't reset them
  - `bridge/rivendell.py`: `_connect` adds the headers; `_api` and `_api_put_bytes` take `headers: dict | None = None`
- Test: `tests/test_device_share.py`, `tests/test_rivendell_instances.py`, `tests/test_rivendell_channel.py` (the handshake)

**Interfaces:**
- Produces:
  - `device_facts(run=subprocess.run) -> dict | None`: `{id, name, os: "macOS", osVersion, chip, xcode, iosRuntimes: list[str], node, pods}`, or None off macOS (`platform.system() != "Darwin"`). Cached 300 s; `refresh()` drops the cache.
  - `developer_dir(run=…) -> str | None`:
    - `xcode-select -p`, when it doesn't end in `CommandLineTools`;
    - else `/Applications/Xcode.app/Contents/Developer` when it exists;
    - else None.
  - `setup_state(exists=os.path.exists, run=…) -> dict`: `{user: bool, helper: bool, claude: bool}` — `dscl . -read /Users/mysticalruns` rc 0, the helper path, `/Users/mysticalruns/.local/bin/claude`.
  - `share_state(inst: dict) -> dict`: `{"state": "NOT_MAC" | "OFF" | "XCODE_MISSING" | "NEEDS_SETUP" | "READY", "checks": [{"key", "label", "ok"}], "facts": dict | None}`.
    - **The check order** is `MACOS {v}`, `XCODE {v}`, `IOS {v} SIMULATOR`, `NODE {major}`, `COCOAPODS {v}`, `USER MYSTICALRUNS`.
    - **The state rule:**
      - not Darwin → NOT_MAC;
      - `share_device` False → OFF;
      - no Xcode or no iOS runtime → XCODE_MISSING;
      - any `setup_state` False → NEEDS_SETUP;
      - else READY.
  - `handshake_headers(inst: dict) -> list[str]`: `["X-Mystical-Features: device-runs", "X-Mystical-Device: " + base64url(json)]` when READY, else `[]`.

Parsers, each a pure function tested on captured output:
- `xcodebuild -version` first line `Xcode 27.0` → `"27.0"`
- `xcrun simctl list runtimes -j` → the `version`s whose `platform` is `iOS` and that are `isAvailable`
- `node -v` `v26.11.0` → `"26"`
- `pod --version` → stripped
- `sw_vers -productVersion` → stripped
- `sysctl -n machdep.cpu.brand_string` `Apple M5 Pro` → `"M5 Pro"`
- `scutil --get ComputerName` → the name
- `ioreg -rd1 -c IOPlatformExpertDevice` → the `IOPlatformUUID` value

Run every binary with `DEVELOPER_DIR` from `developer_dir()` and a 10 s timeout. A missing binary means a missing fact, not an exception.

- [ ] **Step 1: Failing tests.**
  - Parsers on real captured strings. This Mac: `Xcode 27.0`, runtime `27.0`, `v26.11.0`, `1.17.0`, `27.0.1`, `Apple M5 Pro`, `Mahziyar’s MacBook Pro`.
  - `share_state` for each state.
  - `handshake_headers` decodes back to the facts.
  - Instances: `share_device` defaults True and survives `riToInput`; `device_token` is masked and kept on a blank edit.
  - The channel: the handshake includes both headers when READY and neither otherwise. Use the socketpair fake in `tests/test_rivendell.py:107-142`.
- [ ] **Step 2: Run** `…/pytest tests/test_device_share.py tests/test_rivendell_instances.py tests/test_rivendell_channel.py -q` → FAIL.
- [ ] **Step 3: Implement.** `Worker` reads `device_share.handshake_headers(self.inst)` in `_connect`. `rivendell.reconfigure()` already reconnects on an instance edit.
- [ ] **Step 4: Run** the same → PASS. Also run the full suite → baseline only.
- [ ] **Step 5: Commit:** `rivendell: a shared Mac tells Rivendell it is a device for runs, with its macOS, Xcode, iOS runtimes, Node and CocoaPods; Share this device and the device-run token are per instance`

### Task 2: Set up, Remove and the root helper

**Files:**
- Create:
  - `bridge/device_setup/setup.sh`, `bridge/device_setup/remove.sh`, `bridge/device_setup/mystical_run_helper.py`
  - `bridge/device_setup.py` (the bridge side: run a script through osascript)
  - `tests/test_device_setup.py`, `tests/test_run_helper.py`

**Interfaces:**
- Produces:
  - `device_setup.run(action: "setup" | "remove", owner: str = getpass.getuser(), run=subprocess.run) -> dict`.
    - It runs `osascript -e 'do shell script "/bin/bash <script> <owner>" with administrator privileges'`, with the script path and owner quoted for both the shell and AppleScript.
    - The timeout is 900 s.
    - It returns the last stdout line parsed as JSON (`{"ok": bool, "checks": [...], "error": str | null}`), or `{"ok": False, "error": "Cancelled."}` when the user cancels the password prompt (osascript rc 1 with `-128`).
  - The helper CLI: `mystical-run-helper start <run-id>` and `mystical-run-helper stop <run-id>`. Exit 0 on a finished run, whatever Claude's verdict. Non-zero with one stderr line on a refusal.
  - Its pure functions, importable for tests:
    - `valid_run_id(s) -> bool`
    - `check_stage(path, owner_uid, lstat=os.lstat) -> str | None` (the error, or None)
    - `claude_env(job: dict, token: str, run_dir: str) -> dict`
    - `claude_argv(prompt: str) -> list[str]`
    - `launch_argv(launch: str, uid: int, inner: list[str]) -> list[str]`

**`setup.sh <owner>`** (as root). Each step is idempotent, and its last line prints JSON:
1. Fail unless `$(id -u) = 0` and the owner exists.
2. If `mysticalruns` is missing:
   - `sysadminctl -addUser mysticalruns -fullName "Mystical Runs" -password "$(openssl rand -base64 24)" -home /Users/mysticalruns -shell /bin/zsh`
   - `createhomedir -c -u mysticalruns`
   - `dscl . -create /Users/mysticalruns IsHidden 1`
3. `chmod +a "user:mysticalruns deny list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit" /Users/<owner>`, only when not already present.
4. Install the runs folders and the helper:
   - `install -d -o <owner> -g staff -m 0755 "/Users/Shared/Mystical Runs"`
   - `install -d -o mysticalruns -m 0700 /Users/mysticalruns/runs`
   - install the helper as root:wheel 0755
   - write `/usr/local/etc/mystical-runs.json` `{"owner", "uid", "launch": "sudo"}`
5. Write the sudoers rule `<owner> ALL=(root) NOPASSWD: /usr/local/libexec/mystical-run-helper` to a temp file. Install it only if `visudo -cf` passes, then chmod 0440.
6. `sudo -u mysticalruns -H /bin/bash -c 'curl -fsSL https://claude.ai/install.sh | bash'`, unless `/Users/mysticalruns/.local/bin/claude` exists.
7. Checks: Xcode (`DEVELOPER_DIR=… xcodebuild -version`, plus `xcodebuild -checkFirstLaunchStatus`), an iOS runtime, node, pod. Print `{"ok": true, "checks": [...]}`.

**`remove.sh <owner>`:**
1. `pkill -u mysticalruns`
2. `sysadminctl -deleteUser mysticalruns`
3. `chmod -a "user:mysticalruns deny …same rights…" /Users/<owner>`
4. `rm -f` the helper, the config and the sudoers file
5. `rm -rf "/Users/Shared/Mystical Runs"`
6. print `{"ok": true}`

**Helper `start <id>`:**
1. Refuse unless `os.environ["SUDO_UID"]` equals the config's uid, and `valid_run_id`.
2. `check_stage("/Users/Shared/Mystical Runs/<id>")`: not a symlink, owned by that uid, mode 0700. It must contain `job.json`, `token` and `code.tar.gz`.
3. Make `runs/<id>/{code,out/screens,config}` as `mysticalruns`, with `sudo -u mysticalruns install -d -m 0700`.
4. Copy `code.tar.gz` into `runs/<id>/` and chown it to `mysticalruns`. Extract it **as `mysticalruns`** with `sudo -u mysticalruns /usr/bin/tar -xzf … -C runs/<id>/code --no-same-owner`.
5. Run `launch_argv(config.launch, mysticalruns uid, ["/usr/bin/env", "-i", *KEY=VAL from claude_env, *claude_argv(prompt)])` with cwd `runs/<id>/code`.
   - Use its own process group, and write the pid to `runs/<id>/pid` (root 0600).
   - Stdout goes to `runs/<id>/out/claude.json`.
   - The timeout is `job["timeoutSeconds"]`.
6. Write `out/exit.json` `{"code": rc, "timedOut": bool}`. Copy `runs/<id>/out` into the stage's `out/` and chown it to the owner.
7. `rm -rf runs/<id>` and delete the stage `token`. Steps 6–7 run in a `finally`.

**Helper `stop <id>`:** the same caller and id checks. Kill the process group in `runs/<id>/pid` (TERM, then KILL after 10 s). Exit 0 if nothing runs.

**`claude_env`:**
- `HOME=/Users/mysticalruns`
- `PATH=/Users/mysticalruns/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
- `CLAUDE_CODE_OAUTH_TOKEN=<token>`
- `CLAUDE_CONFIG_DIR=runs/<id>/config`
- `MYSTICAL_RUN_OUT=runs/<id>/out`
- `DEVELOPER_DIR=job["developerDir"]`, when given
- `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` from the job
- `LANG=en_US.UTF-8`

**`claude_argv`:** `["/Users/mysticalruns/.local/bin/claude", "-p", prompt, "--output-format", "json", "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']`.

**`launch_argv`:**
- `sudo` → `["/usr/bin/sudo", "-u", "mysticalruns", "-H", *inner]`
- `asuser` → `["/bin/launchctl", "asuser", str(uid), "/usr/bin/sudo", "-u", "mysticalruns", "-H", *inner]`
- anything else → `ValueError`

- [ ] **Step 1: Failing tests.**
  - **`test_run_helper.py`** imports the helper by path:
    - `valid_run_id` on good, bad and `../x` ids;
    - `check_stage` refuses a symlink, a stranger's dir and 0755 (using `os.lstat` fakes);
    - `claude_env` has exactly the keys above, with no inherited vars;
    - `claude_argv` and `launch_argv` exactly as above, and `ValueError` for `"root"`;
    - `start` refuses a SUDO_UID that doesn't match the config (main called with a temp config path override, `MYSTICAL_RUNS_CONFIG`, read only in tests);
    - the cleanup runs on a timeout. Drive `start` with a fake runner that raises `TimeoutExpired`, against temp dirs standing in for the real paths, through module constants `RUNS_HOME` and `STAGE_ROOT` that tests monkeypatch.
  - **`test_device_setup.py`:**
    - the osascript argv quotes an owner with a space and a quote safely;
    - a cancel (`-128`) maps to `{"ok": False, "error": "Cancelled."}`;
    - the last-line JSON is parsed;
    - `bash -n` passes on both scripts (run `bash -n` in the test).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** The scripts and the helper never interpolate an unvalidated string into a shell. The helper uses argv lists only.
- [ ] **Step 4: Run** the two test files plus the full suite → PASS, baseline only.
- [ ] **Step 5: Commit:** `device runs: Set up makes a hidden macOS user for teammates' runs, keeps it out of your home, and installs a root helper that runs Claude as that user with the asker's token; Remove undoes it`

### Task 3: The device side — run a teammate's run

**Files:**
- Create: `bridge/device_side.py`, `tests/test_device_side.py`
- Modify:
  - **`bridge/rivendell.py`:**
    - `_handle_message`: `device-run-request` → `self._enqueue("device-run", obj["requestId"], obj.get("repository"))`, and `device-run-cancel` → `device_side.stop(obj["requestId"])` on a thread;
    - `_KIND_PATH["device-run"] = "device-run-requests"`, `_KIND_LABEL["device-run"] = "Device run"`;
    - `_apply_policy`: Ruling 2; a not-READY device does nothing (no ack);
    - `_run_accepted`: a `device-run` branch → `self._run_device_run(item)`;
    - `_catch_up`: device runs only when READY, with the header
  - `tests/test_rivendell.py`: the dispatch guard at :583 lists the new kind

**Interfaces:**
- Consumes: Task 1 (`share_state`, `device_facts`, `developer_dir`, `_api(headers=)`) and Task 2 (the helper CLI).
- Produces:
  - `device_side.run(worker, request_id: str) -> None`, the whole flow below, testable with a fake worker exposing `_api`, `_api_put_bytes`, `inst`, `log`.
  - `device_side.stop(request_id: str, run=subprocess.run) -> None`
  - `device_side.parse_report(claude_json: str) -> tuple[str, list[dict]]` — the summary and `[{file, caption}]`, taken from the last `{…}` JSON object in Claude's `result` text. On no JSON it returns `(the whole result text, [])`.
  - `device_side.stage_dir(request_id) -> str`

Flow of `run`:
1. `claim = worker._api(f"/plugin/device-run-requests/{id}/prompt", headers=H)`. A 409 HTTPError → return quietly (Review Focus 3).
2. `telegram.send(config.DASH_CHAT_ID, f"{claim['requester']['name']} is testing {claim['repository']} on this device.")`.
3. Write the stage (0700):
   - `job.json`: `{prompt, gitAuthorName, gitAuthorEmail, developerDir: developer_dir(), timeoutSeconds: inst["impl_timeout"]}`
   - `token` (0600)
   - `code.tar.gz`, downloaded from `claim["snapshotUrl"]` (urllib, 60 s)
4. `subprocess.run(["/usr/bin/sudo", "-n", HELPER, "start", id], timeout=impl_timeout + 120)`.
5. Read `out/exit.json` and `out/claude.json`, then `parse_report`.
6. Upload `out/screens/<file>` for each listed screen (then any unlisted PNGs, in name order) as indexes 1…20, each ≤ 5 MB. Skip the ones over, with a note appended to the summary. Each is a PUT with `application/octet-stream` and the header.
7. POST the result:
   - `{"status": "COMPLETED", "result": summary, "screens": [{index, caption}]}` when rc 0 and a summary exists;
   - otherwise `{"status": "FAILED", "error": …}`, one of `The run timed out after N min.`, `The run stopped with exit code N.`, `No report came back.`, or the helper's stderr line.
8. `shutil.rmtree(stage)` in a `finally`.

- [ ] **Step 1: Failing tests.** In `tests/test_device_side.py`:
  - a 409 claim drops quietly (no result POST, no telegram send);
  - success uploads two screens and posts COMPLETED with captions in index order;
  - a 6 MB screen is skipped with the note;
  - helper rc 3 → FAILED `The run stopped with exit code 3.`;
  - a timeout → FAILED and the stage is removed;
  - `parse_report` on a result with prose then JSON, and on prose only;
  - `stop` calls `sudo -n HELPER stop <id>`.

  In `tests/test_rivendell.py`:
  - a `device-run-request` frame enqueues kind `device-run`;
  - with READY and idle it's acked `received` and accepted;
  - while another device run is active it's acked `queued` with no telegram ask;
  - when not READY nothing is acked;
  - `device-run-cancel` calls `stop`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `_run_device_run` delegates to `device_side.run(self, item["id"])`, then frees the queue (`_untrack`, `_active_runs`) like the other kinds.
- [ ] **Step 4: Run** the two test files plus the full suite → PASS, baseline only.
- [ ] **Step 5: Commit:** `rivendell: a shared device takes a teammate's run when it's free — claims it, runs it through the helper as the hidden user, uploads the screenshots and posts the report; a cancel stops it`

### Task 4: The asking side — tools, snapshot and hand-back

**Files:**
- Create: `bridge/device_ask.py`, `tests/test_device_ask.py`
- Modify:
  - **`bridge/verify_mcp.py`:** `_TOOLS` gains `ListDevices`, `RunOnDevice` and `CancelDeviceRun`; `_call` posts to `$MYSTICAL_DASH/local/device-runs/{list,start,cancel}` with `X-Dash-Token` and `{"claude_session_id": os.environ.get("MYSTICAL_CLAUDE_SESSION_ID"), …args}`
  - **`bridge/dashboard/server.py`:** the three POST routes (behind `X-Dash-Token`), calling `device_ask`
  - **`bridge/rivendell.py`:**
    - `_handle_message`: `device-run-update` → `device_ask.on_update(self, obj)` on a thread;
    - after `_catch_up`: `device_ask.catch_up(self)` when the instance has a `device_token`
- Test: `tests/test_device_ask.py`, `tests/test_verify_mcp.py` (create it if missing)

**Interfaces:**
- Consumes: the Rivendell routes (Contract), `queue_manager.enqueue(sid, *, text, prompt, images, model, effort, permission_mode, width, sel, surface, chat_id, project, …)`, `store.get_by_claude_session_id`, `github._run`, and `rivendell_instances.raw_instances()`.
- Produces:
  - `snapshot(folder: str) -> dict`: `{"tar_gz": bytes, "repository": "owner/repo", "commitSha": str, "dirty": bool, "gitAuthorName": str, "gitAuthorEmail": str}`. It raises `DeviceAskError(sentence)`.
  - `list_devices(inst) -> dict`: the Rivendell `DeviceListDto`.
  - `start(claude_session_id: str, request: str, task: str | None, pull_request: str | None, device: str | None, folder: str | None) -> dict`: `{"id", "device", "sentence"}`.
  - `cancel(run_id: str | None, claude_session_id: str) -> dict`: with no id, it cancels that session's newest open run.
  - `on_update(worker, frame: dict) -> None` and `catch_up(worker) -> None`.
  - `pr_section(body: str, section: str) -> str`: replace between the markers, or append after a blank line.
  - The store: `device_runs.json` beside `config.BRIDGE_DB` (0600): `{run_id: {"instance": id, "session": bridge sid, "task": key|None, "pr": "owner/repo#n"|None, "device": name|None, "started_on": name|None}}`.

`snapshot`:
- `git -C folder rev-parse --show-toplevel` → the root; otherwise `This folder isn't a git checkout.`
- `git stash create`, falling back to `HEAD`
- `git archive --format=tar <ref>`
- append the untracked root `.env*` files with `tarfile` (`.env`, `.env.local`, …; no subfolders)
- gzip; over 9 MB → `` `Your code packs to {x:.1f} MB; device runs take up to 9 MB.` ``
- `git remote get-url origin` parsed with `(?:github\.com[:/])([\w.-]+/[\w.-]+?)(?:\.git)?$`; otherwise `Its origin isn't a GitHub repository.`
- `git config user.name` and `user.email`

`pull_request` input forms: `owner/repo#57`, `#57` (meaning this repo), or a github.com PR URL (`github.pr_ref`).

Tool texts (the `description` fields carry the behaviour Claude must follow):
- **ListDevices:** `List the shared devices (Macs for now) your team can run a test on, with which are free. Before RunOnDevice, call this and ask the user which device with AskUserQuestion: "First free device (Recommended)" first, then each free device, then the busy ones, with the description from this list; devices that are off are not options. With none on, offer "Queue it for the next device (Recommended)" and "Don't send it".`
- **RunOnDevice:** `Send a test to a shared device: it builds and runs this checkout's app in the iOS Simulator as an isolated user, under your own Claude account, and posts the report and screenshots on the task, the PR and back in this chat. Needs a task key (like NR-31) or a pull request; ask the user when they named neither.` Params:
  - `request` (string, required)
  - `task` (string)
  - `pullRequest` (string)
  - `device` (string: a device id from ListDevices; omit for the first free one)
  - `folder` (string; default: this session's folder)
- **CancelDeviceRun:** `Stop a device run you sent. Without an id, stops the newest one this chat sent.` Params: `run` (string).
- **List result text**, one line per device:
  - `` `{name} — {free|busy|off} · {os} {osVersion} · Xcode {x} · iOS {runtimes joined}{busy ? ` · ${requester}'s ${task} run, ${m} min in · yours would go next` : ''}` `` — followed by `id: {id}`;
  - then `` `{on} on, {free} free.` ``
- **Start result sentence:**
  - `Sent to {device name}.`
  - `Sent to the shared devices ({n} on).`
  - `No shared device is on; it starts when one connects.`

`on_update(worker, frame)`:
- **RUNNING:** record `started_on`, then `telegram.send(config.DASH_CHAT_ID, f"Started on {device}: {task or repository}.")` (Ruling 3).
- **COMPLETED, FAILED or CANCELLED:**
  1. Download each screen URL into `config.UPLOAD_DIR/device-run-<id>/<index>.png`.
  2. Find the session (`store.get_session(rec["session"])`). If it exists, enqueue into it with `text` = `prompt`:
     ```
     The device run you sent finished on {device} ({minutes} min): {Done|Failed|Cancelled}.

     {result or error}

     {task line: "It is posted on {key}." and/or "The PR description has it too."}
     ```
     The call: `images=[paths]`, `surface="rivendell"`, `chat_id=session["chat_id"]`, `project=session["project"]`, `model=None`, `effort=None`, `permission_mode=None`, `width=None`, `sel=[]`. Otherwise send `telegram.send(...)` with the same first line.
  3. If there's a PR, put `pr_section(body, section)` through `github._run("gh", "pr", "view", n, "-R", repo, "--json", "body", "-q", ".body")` and `github._run("gh", "pr", "edit", n, "-R", repo, "--body-file", tmp, timeout=40)`. The section is `### Device run on {device}`, then the result, then `![{caption}]({url})` per screen.
  4. `POST /plugin/device-run-requests/{id}/delivered`, and drop the record.

`catch_up(worker)`: `GET /plugin/device-run-requests/mine?undelivered=1`, then `on_update` for each (the same body as a frame).

- [ ] **Step 1: Failing tests:**
  - **`snapshot`:**
    - a temp git repo with an uncommitted change → `dirty` True, and the tar holds the changed file and `.env`;
    - a non-repo folder → its sentence;
    - an origin `git@github.com:ainurhq/app.git` → `ainurhq/app`;
    - an origin on gitlab → its sentence;
    - an oversize pack (monkeypatch the limit to 1 KB) → its sentence.
  - **`start`:**
    - posts the Contract's create body with the token from the instance;
    - PUTs the code as octet-stream;
    - records the session;
    - returns each sentence;
    - with no `device_token` → its sentence.
  - **`on_update`:**
    - COMPLETED enqueues one turn with both images and the exact text, edits the PR section (replace and append cases of `pr_section`), and posts `delivered`;
    - a missing session → Telegram plus `delivered`;
    - RUNNING → Telegram only.
  - **`catch_up`** processes two undelivered runs.
  - **`verify_mcp`:**
    - `tools/list` includes the three tools with those descriptions;
    - `RunOnDevice` posts `/local/device-runs/start` with the session id from the environment.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** The local routes return `{"text": …}`, and `_call` wraps it as one text block. Errors come back as text too, as the existing tools do.
- [ ] **Step 4: Run** the test files plus the full suite → PASS, baseline only.
- [ ] **Step 5: Commit:** `device runs: from any chat, list the shared devices, send this checkout to one with a task or PR, and get the report back as a new turn with its screenshots, plus a Device run section in the PR`

### Task 5: Settings — Share this device, Set up, and the token

**Files:**
- Create: `bridge/dashboard/web/src/components/hud/DeviceRunsPanel.tsx`
- Modify:
  - **`SettingsModal.tsx`:** `export` on `Section`, `Row` and `Switch`, and `{shown === "plugins" && <DeviceRunsPanel />}` after the RivendellPanel line (:4346)
  - **`bridge/dashboard/web/src/api.ts`:** `rivendellDevices()`, `updateRivendellDevice(body)`, `rivendellDeviceSetup(action)`, and their types
  - **`bridge/dashboard/server.py`:**
    - `GET /local/rivendell/devices`;
    - `POST /local/rivendell/devices` (`{id, share_device?, device_token?, clear_token?}`);
    - `POST /local/rivendell/devices/setup` (`{action: "setup" | "remove"}`, runs `device_setup.run`, then `device_share.refresh()` and `rivendell.reconfigure()`)
  - **`docs/rivendell.md`:** a "Device runs" section — what Share this device does, the one password prompt, what the hidden user can't see, Remove, and the token
- Test: `tests/test_dashboard_device_routes.py`, plus `tsc`

**Interfaces:**
- Consumes: Task 1 (`share_state`, the instance fields), Task 2 (`device_setup.run`), Task 4 (`list_devices`, used for the Linux view's "on now").
- Produces: `GET /local/rivendell/devices` → `{"instances": [{"id", "name", "enable", "share_device", "token_saved", "token_last4", "share": share_state(inst), "shared_on": {"on", "free"} | null, "last_run": {"at", "by", "task"} | null}]}`.
  - `shared_on` is fetched from Rivendell and cached 30 s; null on error.
  - `last_run` is the newest finished run this device ran. Task 3 records it in `device_share` state.

Copy (drafts H/I/J; voice through `useVoice()`, so FLINT reads it sentence-case):
- **Section title:** `DEVICE RUNS · THIS DEVICE`, with the description `teammates allowed in Rivendell can test iOS apps on this device.` On Linux it is `DEVICE RUNS` with `send iOS Simulator tests to the team's shared devices.`
- **Rows:**
  - `SHARE THIS DEVICE` [Switch]. On Linux the chip reads `MACOS ONLY` instead.
    - Description: `Runs execute as the hidden user mysticalruns, with the asker's own code and Claude account. They can't see your files, keychain or logins.`
  - `STATE` [chip READY | NEEDS SETUP | XCODE MISSING | OFF]. The right-hand text is `idle · last run {HH:MM}, {by}, {task}`, or `not shared until it is set up`.
    - The checks line: ✓/✗ per check.
  - `SETUP`, holding [SET UP] (primary) when NEEDS_SETUP, or [REMOVE] (destructive) when READY.
    - SET UP description: `Creates a hidden macOS user for runs, keeps it out of your home folder and installs Claude Code for it. Asks for your Mac password once.`
    - REMOVE description: `Deletes the hidden user and everything runs left behind. Asks for your Mac password.`
    - A running setup shows `WAITING FOR YOUR PASSWORD…`.
  - `SHARED DEVICES ON NOW`, Linux only: `{on} on · {free} free`.
  - `CLAUDE TOKEN FOR DEVICE RUNS`:
    - saved: `SAVED ····{last4}` [REPLACE];
    - not saved: a password field [SAVE], and `Needed before you can send a run.` in the warn colour.
    - Description: `Your runs use your own Claude account, so the usage is yours. Make a token with claude setup-token.`
- One block per enabled instance, headed `{NAME} · {api host} · {CONNECTED|…}` the way RivendellPanel shows status.

- [ ] **Step 1: Failing tests** (`tests/test_dashboard_device_routes.py`, the server test harness the other route tests use):
  - GET returns the shape;
  - POST updates `share_device` and the token, and never echoes the token;
  - a setup POST calls `device_setup.run("setup", owner)` and returns the new share state;
  - a missing `X-Dash-Token` → 403.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the routes and the panel. Poll GET every 4 s while open, as RivendellPanel does.
- [ ] **Step 4: Check.**
  - Run the pytest file and the full suite → baseline only.
  - Run `tsc -p tsconfig.app.json --noEmit` → clean.
  - Build the dashboard dist **in the worktree** (`npm run build` in `bridge/dashboard/web`).
  - Serve it with `.mystical/probe/probe.py`, per the `bridge-eyes` skill. Capture the Settings › Plugins panel at 2x with `node .claude/skills/bridge-eyes/shot.mjs`, and compare it with drafts H and J.
  - Keep the shots in the worktree's `.mystical/`.
- [ ] **Step 5: Commit:** `settings: Share this device, its state and checks, Set up and Remove behind one Mac password prompt, and your Claude token for device runs`

## Self-review notes

- **Spec coverage, asking side:** tools → Task 4; snapshot → Task 4; hand-back (turn with images, `gh` PR section, delivered, catch-up) → Task 4; Telegram text only → Task 4 (Ruling 3, the missing-session path).
- **Device side:** kind (frame, catch-up, claim, run, upload, result) → Task 3; helper (DEVELOPER_DIR, no MCP, token, snapshot in that home, outputs via `/Users/Shared/Mystical Runs/<id>`) → Task 2.
- **Set up and Remove, with the 5 steps** → Task 2.
- **Settings:** Share this device (state, checks, Set up and Remove), token, and the Linux view → Task 5.
- **Handshake:** features and device facts → Task 1.
- **The Simulator test** (build order step 4) isn't a task. It needs the owner to press Set up, enter the Mac password, and run one device run against this Mac. If the Simulator won't boot under `sudo -u`, set `"launch": "asuser"` in `/usr/local/etc/mystical-runs.json` (Ruling 4) and try again.
