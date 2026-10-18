# Device runs: a live read-only view, never in the owner's way — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teammate's device run on this Mac shows up in the dashboard's PLUGINS tab as a read-only session whose steps stream live. The run survives Mystical restarts, runs at low priority, and can be stopped by the owner.

**Architecture:**
- The root helper writes Claude's `stream-json` output to `<stage>/live.jsonl`, an owner-readable file, and runs Claude under a `utility` QoS clamp.
- The bridge turns each line into the dashboard's existing event types, through a new side-effect-free converter (`bridge/device_view.py`). It stores them on a session with origin `device-run:<instance>`.
- Rivendell machinery, boot recovery and the run-start path all treat that session as read-only. After a restart, `device_side` takes back a helper that is still running instead of stopping it.
- The dashboard lists these sessions in a DEVICE RUNS lane and swaps the composer for a read-only plate.

**Tech Stack:**
- Python 3 stdlib (bridge).
- `/usr/bin/python3` 3.9 for the root helper.
- React + TypeScript + Vite (dashboard).
- SQLite (`bridge/store.py`).

**Spec:** `docs/superpowers/specs/device-run-view.md`. Mockups (local only, not in git) are in `.mystical/device-run-view-mockups/` (`01-plugins-tab.html`, `02-run-live.html`, `03-run-done.html`), drawn in FLINT VIOLET.

## Global Constraints

- **The bridge is stdlib only.** The helper must run on `/usr/bin/python3` 3.9: no `match`, no `X | Y` types, no `Popen(process_group=)`.
- **Tests never run a real system command.** That includes `sudo`, `launchctl`, `pkill`, `osascript`, `crontab`, `taskpolicy`, `dscl` and `ps` against the live machine. Every seam (`run=`, `popen=`, `call=`, `alive=`) defaults to a refusing fake in its test module's autouse fixture; extend the existing fixtures.
- **Running the tests:** `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q -p no:cacheprovider` from the worktree root. The baseline is 2596 passed with 7 known failures (`test_clip_panel::test_clip_marks_round_trip`, `test_map_command` ×4, `test_startup` ×2). Any other red is yours.
- **Running the frontend checks:** from `bridge/dashboard/web`, `npx tsc -b` and `node --experimental-strip-types src/lib/<name>.check.ts`. The build is `npm run build`.
- **Copy:** user-visible strings are exactly these:
  - lane: `DEVICE RUNS` and `teammates on this device`
  - divider: `Mystical restarted HH:MM · this run kept going`
  - button: `STOP RUN`
  - posted error: `Stopped by this device's owner.`
  - status tab: `RUNNING · LOW PRIORITY`, or `DONE · N MIN`, `FAILED · N MIN`, `STOPPED · N MIN`
  - refusal: `This is a teammate's device run on this device. It's read only.`
- **Naming:** say "device", never "Mac", in names and copy, except where a device's own facts are listed.
- **The device-run accent is `var(--info)` (blue).** Your own sessions stay violet (`--acc`) and Rivendell stays purple (`--purple`).
- **Commits:** on `feat/device-run-view` in the worktree. Never push. No `Co-Authored-By` lines.
- **Comments:** module docstrings carry the why. Mark a deliberate shortcut with `shortcut: <the limit>, <when to upgrade>`.

## Review Focus

1. **A Mystical restart mid-run.** The helper keeps running. The view gains one divider and continues from where it stopped, re-adding at most one batch of events. The result is posted exactly once. The turn ends `done`/`error`, never stuck `running`. *(Task 4: `test_sweep_adopts_a_live_helper_and_resume_posts_once`.)*
2. **A hostile or garbled stream line.** That covers a tool id like `../../x`, a non-JSON line, a 50 MB line, an `image/svg+xml` block, and a token `sk-ant-…` in text or output. These are dropped, sanitised or redacted. No file is ever opened, copied or moved from a path the stream names. *(Task 3: `test_feed_never_touches_paths_the_stream_names`, `test_feed_sanitises_ids_and_media`.)*
3. **Boot recovery meets a device-run turn left `running`.** The turn is neither flipped to `error` nor resumed on the owner's Claude account. No `claude_session_id` is ever stored on a device-run session. *(Task 3: `test_claim_orphaned_turns_skips_device_runs`, `test_feed_drops_session_ids`.)*
4. **The owner presses STOP RUN before the helper has started Claude** (the code is still unpacking). The stop is resent on each beat until it lands. FAILED `Stopped by this device's owner.` is posted once, and the view ends `stopped`. *(Task 4: `test_owner_stop_during_unpack_posts_failed_once`.)*
5. **A device that hasn't re-run Set up**, so the old helper writes `--output-format json` and no `live.jsonl`.
   - The run still completes and posts as today.
   - The view shows the ask, then the summary when the run ends.
   - The device stays READY and offers SET UP.

   *(Task 2: `test_outdated_helper_stays_ready_and_offers_setup`; Task 4: `test_run_without_live_file_still_reports`.)*

Also pinned: POST `/local/run` against a device-run session refuses and spawns no Claude *(Task 3: `test_runs_are_refused_on_device_run_sessions`)*.

---

### Task 1: The helper streams to the stage and yields the CPU

**Files:**
- Modify: `bridge/device_setup/mystical_run_helper.py` (`claude_argv` :195, `launch_argv` :203, `_start` :476-536, `_hand_back` :423, `main` :578-596, the docstring)
- Test: `tests/test_run_helper.py` (the `Runner` at :250-309 strips only a leading `/usr/bin/sudo`; argv assertions at :155-159 and :465)

**Interfaces:**
- Produces:
  - `<stage>/live.jsonl`: a regular file that root makes, owned by the stage's owner, mode 0600. It holds every stdout line Claude writes (stream-json), as the run goes. Task 3 reads it.
  - `<stage>/out/claude.json`: a single JSON object, the stream's last `{"type":"result",…}` line. `device_side.parse_report` reads it unchanged.
  - `last_result(data: bytes) -> bytes`: returns that line, or `b""` if there is none.

- [ ] **Step 1: Write the failing tests** in `tests/test_run_helper.py`.
  - Update the existing argv assertions to the new `claude_argv` / `launch_argv` output.
  - Teach `Runner` to strip a leading `["/usr/sbin/taskpolicy", "-c", "utility"]` before the `sudo` prefix, and to refuse any other taskpolicy form.
  - Add these tests:

```python
def test_claude_streams_json_verbosely():
    argv = h.claude_argv("hi", "/c")
    assert argv[argv.index("--output-format") + 1] == "stream-json" and "--verbose" in argv

def test_the_run_is_clamped_to_utility_qos():
    assert h.launch_argv("sudo", 502, ["/c"])[:3] == ["/usr/sbin/taskpolicy", "-c", "utility"]
    assert h.launch_argv("asuser", 502, ["/c"])[:4] == ["/usr/sbin/taskpolicy", "-c", "utility", "/bin/launchctl"]

def test_last_result_is_the_final_result_line():
    lines = b'{"type":"system"}\n{"type":"result","result":"a"}\n{"type":"assistant"}\n{"type":"result","result":"b"}\nnot json\n'
    assert json.loads(h.last_result(lines))["result"] == "b"
    assert h.last_result(b'{"type":"assistant"}\n') == b""

def test_a_run_writes_its_stream_to_the_stage_live(box):     # mirror test_a_run_that_times_out… (:557)
    _claude(box, 'echo \'{"type":"assistant","message":{"content":[]}}\'\necho \'{"type":"result","result":"ok"}\'\n')
    st = _stage(box)
    assert h.main(["start", RUN_ID], popen=_watching(box)) == 0
    live = (st / "live.jsonl").read_bytes().splitlines()
    assert [json.loads(l)["type"] for l in live] == ["assistant", "result"]
    assert json.loads((st / "out" / "claude.json").read_text())["result"] == "ok"
    # box fakes os.fchown: assert the live file was handed to the owner's uid

def test_a_planted_live_file_refuses_the_run(box): ...          # a symlink named live.jsonl in the stage -> exit 2, nothing followed

def test_main_survives_a_closed_stderr(monkeypatch):            # sys.stderr whose write raises BrokenPipeError
    assert h.main(["nonsense"]) == 2
```

- [ ] **Step 2: Run them and see them fail.**
  Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_run_helper.py -q -p no:cacheprovider`
  Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - `claude_argv` puts `"--output-format", "stream-json", "--verbose"` where `"json"` was.
  - `launch_argv` puts the `TASKPOLICY = ["/usr/sbin/taskpolicy", "-c", "utility"]` prefix before both forms. `taskpolicy` execs in place, so `p.pid` stays the group leader that `_kill_group` and the pid file need.
  - In `_start`:
    - Make the live file through the checked `stage_fd`: `os.open("live.jsonl", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage_fd)`, then `os.fchown(fd, cfg["uid"], -1)`.
    - Any `OSError` there becomes `Refused("The stage already has a live.jsonl.")`.
    - Pass `os.fdopen(fd, "w+b")` to `_launch` in place of the `TemporaryFile`.
  - `_hand_back` writes `last_result(...)` of the file's last 8 MB as `out/claude.json`, in place of the whole stream.
  - In `main`, the two `print(..., file=sys.stderr)` calls go through `_say(line)`, which swallows `OSError`. The bridge that started the helper may have re-exec'd, closing its stderr pipe.
  - Update the docstring: the stream goes to the owner's stage while it runs, and why that's safe. Root only writes through an fd it opened on a name that can't be a link, and the run already controls its own stdout. Also document the QoS clamp.

- [ ] **Step 4: Run the helper tests until they pass, then the whole suite.**
  Expected: only the 7 known failures remain.

- [ ] **Step 5: Commit** with `git commit -m "device runs: the helper streams Claude's steps into the stage as they happen and runs them at utility QoS"`.

---

### Task 2: An outdated helper is offered SET UP without taking the device offline

**Files:**
- Modify: `bridge/device_share.py` (`setup_state` :159, `share_state` :193-228)
- Modify: `bridge/dashboard/web/src/api.ts` (`RivendellDevice.share` :554-571), `bridge/dashboard/web/src/lib/deviceruns.ts` (`setupActions` :29-34), `bridge/dashboard/web/src/components/hud/DeviceRunsPanel.tsx` (the SETUP row's description)
- Test: `tests/test_device_share.py`, `bridge/dashboard/web/src/lib/deviceruns.check.ts`

**Interfaces:**
- Produces:
  - `device_share.helper_outdated(read=_read_bytes) -> bool`: True only when the installed helper exists and its bytes differ from this checkout's `bridge/device_setup/mystical_run_helper.py`.
  - `share_state(...)["outdated"]: bool`. `state` and the four `setup_state` keys are unchanged.
  - TS: `share.outdated?: boolean`.

- [ ] **Step 1: Write the failing tests.**
  - pytest `test_outdated_helper_stays_ready_and_offers_setup`: fake `read` returns different bytes. The state stays `READY`, `outdated` is True, and `handshake_headers` still offers the device.
  - pytest: identical bytes give `outdated` False; a missing helper gives `outdated` False.
  - check.ts: `setupActions` returns `["setup", "remove"]` for a READY, installed, outdated device, and the old results otherwise.
- [ ] **Step 2: Run them.** Expected: they fail.
- [ ] **Step 3: Implement.**
  - `REPO_HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "device_setup", "mystical_run_helper.py")`.
  - `helper_outdated` compares bytes. An unreadable file counts as not outdated.
  - `share_state` adds the key. `setupActions` pushes `"setup"` when `share.outdated && state === "READY"`.
  - The SETUP row's description for that case is: `Updates the run helper for the live view and low priority. Asks for your Mac password once.`
- [ ] **Step 4: Run the tests, `npx tsc -b`, and the check file.** Expected: all pass.
- [ ] **Step 5: Commit** with `git commit -m "device runs: a device whose run helper is older than Mystical's offers SET UP and stays shared"`.

---

### Task 3: Device-run sessions — the store, the read-only guards, and a side-effect-free stream converter

**Files:**
- Create: `bridge/device_view.py`
- Modify:
  - `bridge/store.py`: a `device TEXT` column in `_SCHEMA` and an ALTER in `init()`; `set_device`; `delete_session`; `claim_orphaned_turns` (:1186)
  - `bridge/miniapp/server.py` (`_session_brief` :189-219)
  - `bridge/integrations.py` (the rivendell entry's `"origins"` :50)
  - `bridge/runner.py` (`start_streaming_job`'s refusal, :2729)
- Test: create `tests/test_device_view.py`; modify `tests/test_outcomes_store.py`, `tests/test_integrations.py`

**Interfaces:**
- Consumes:
  - `store.create_session`, `store.start_turn`, `store.append_event`, `store.finish_turn`, `store.rename`, `store.set_ref`, `store.sessions_for_refs`
  - `pubsub.publish(f"session:{sid}", {**ev, "seq": seq})`
  - From `bridge/transcript_jsonl.py`: `_summarize_tool`, `agent_meta`, `tool_done(rid, name, ms, block, result)`, `THINK_MIN_MS`
  - `device_side.redact`
  - `config.UPLOAD_DIR`, `config.DASH_CHAT_ID`, `config.BASE_PATH`
- Produces:
  - `store.set_device(session_id: str, meta: dict) -> None`, which stores JSON.
  - `store.delete_session(session_id: str) -> None`, which deletes the session's events, turns and shares, then the row.
  - `store.parse_device(raw) -> dict | None`.
  - `SessionBrief["device"]`, shaped `{request, instance, by, repo, sha, pr, task, outcome}` or None. `outcome` is one of `None` (running), `"done"`, `"failed"` or `"stopped"`.
  - `device_view.ORIGIN = "device-run"` and `device_view.is_device_run(origin) -> bool`.
  - `device_view.request_text(prompt: str) -> str`: the block between `The request, verbatim:\n---\n` and `\n---`, else the whole prompt. Mark it `shortcut:`, since it couples to Rivendell's `device-run-prompt.template.ts`.
  - `device_view.display_text(text: str) -> str`: a trailing JSON object holding a string `summary` is replaced by that summary.
  - `class Feed(upload_dir: str)` with `.events(rec: dict, now: float) -> list[dict]` (stateful: open tools, last time, image counter).
  - `class Run` with:
    - `open(instance: str, request_id: str, claim: dict) -> Run`
    - `reopen(request_id: str) -> Run | None`
    - `.pump(stage: str) -> int` (new events)
    - `.divider(text: str)`
    - `.screens(files: list[tuple[str, bytes]])`
    - `.close(outcome: str, body: dict)`
    - `.sid`, `.tid`
  - `device_view.running_session() -> str | None`, the session of the run going now.
  - `device_view.prune(days: int = 7, now: float | None = None) -> int`.
  - `device_view.orphans(keep: set[str]) -> int`.

- [ ] **Step 1: Write the failing tests** in `tests/test_device_view.py`, all against conftest's temp DB, with `UPLOAD_DIR` pointed at `tmp_path`.

```python
def test_feed_converts_a_real_stream():   # system/init, assistant text+thinking+tool_use(Bash), user tool_result, result
    # -> [text, thinking?, tool{name:"Bash",id,summary}, tool_done{id, output, is_error:False}, result{result, cost, elapsed}]
    # shapes equal to the runner's (copy the shapes from bridge/runner.py:2042-2124)

def test_feed_drops_session_ids():   # no event carries session_id; Run never calls store.set_claude_session_id
def test_feed_never_touches_paths_the_stream_names(tmp_path, monkeypatch):
    # a Read tool_use with file_path=<a real file> and an *__Record tool_result naming a path:
    # the named file is untouched and not copied; os.open/shutil.copy* are never called on it
def test_feed_sanitises_ids_and_media():
    # tool_use id "../../x" -> replaced by a safe id (regex ^[A-Za-z0-9_-]{1,100}$); image/svg+xml dropped;
    # png base64 saved as <upload_dir>/dr-1.png (<= 8 MB, at most 4 per result) and listed in tool_done.images
def test_feed_redacts_tokens():      # "sk-ant-abc" in text and Bash output -> "[redacted]"
def test_display_text_swaps_the_report_for_its_summary():
    assert device_view.display_text('All good.\n{"summary": "Built and ran.", "screens": []}') == "All good.\nBuilt and ran."
def test_request_text_takes_the_verbatim_block():
def test_open_makes_a_read_only_session():   # origin "device-run:<inst>", ref "device-run:<rid>", title = request_text first line[:60],
                                              # title_source manual, one running turn whose prompt is the request, device meta set
def test_pump_reads_new_lines_once_and_keeps_its_offset(tmp_path):  # two pumps, file grows between: no duplicate events;
                                                                    # offset stored in <stage>/live.offset; reopen() continues from it
def test_close_marks_the_turn_and_outcome():  # close("stopped", body) -> turn status error, device.outcome "stopped", a {"type":"stopped"} event
def test_prune_deletes_finished_runs_older_than_7_days():   # running ones and newer ones stay
def test_orphans_closes_running_turns_not_kept():
def test_claim_orphaned_turns_skips_device_runs():          # in test_outcomes_store.py
def test_device_run_sessions_count_as_plugin_sessions():     # in test_integrations.py: is_plugin_origin("device-run:x") with rivendell on
def test_runs_are_refused_on_device_run_sessions():          # start_streaming_job(session_id=<device-run sid>) -> job.refusal == the refusal copy,
                                                             # no subprocess spawned (patch the spawn seam the runner tests use)
```

- [ ] **Step 2: Run them.** Expected: they fail.
- [ ] **Step 3: Implement.**
  - **`Feed`** mirrors `transcript_jsonl._parse_full`'s per-block handling, but for the live stream's record shapes:
    - `assistant`: content blocks become `text`, `thinking` and `tool`.
    - `user`: `tool_result` blocks become `tool_done`, using `rec["tool_use_result"]`.
    - `result`: becomes `result`, with `cost=total_cost_usd` and `elapsed=duration_ms//1000`.
  - **Every string** passes through `redact`. Lines over 4 MB are skipped.
  - **Images** come only from inline base64 blocks, for `image/png|jpeg|gif|webp`. They are written under `upload_dir` with names the Feed makes itself.
  - **`Run.open`:**
    - Creates the session with `store.create_session(config.DASH_CHAT_ID, "/", origin=f"device-run:{instance}", cwd=config.BASE_PATH)`.
    - Then calls `rename` with the title, `set_ref(f"device-run:{request_id}")`, and `set_device(meta)`.
    - `start_turn` takes `request_text(claim["prompt"])`.
    - It prunes old runs (prune on write) and registers itself as running.
  - **`pump`** reads complete lines from `<stage>/live.jsonl` past the saved offset. For each line it calls `append_event` and `publish`, then writes `live.offset`. A missing file is no error, because an old helper writes none. Mark this `shortcut:`: a crash between the store and the offset write repeats at most one batch.
  - **`close`:**
    - Calls `finish_turn` with `"done"` or `"error"` and sets `device.outcome`.
    - Emits `{"type":"stopped"}` for a stopped run.
    - If no `text` event was ever stored, it adds the body's summary or error as one `text`.
    - It unregisters the run.
  - **`claim_orphaned_turns`** excludes sessions whose `origin LIKE 'device-run:%'`, in both the SELECT and the UPDATE.
  - **`integrations`:** the rivendell entry's `origins` becomes `("rivendell", "device-run")`.
  - **`start_streaming_job`:** right after `_resolve_session`, a session whose origin is a device run gets `refusal = "This is a teammate's device run on this device. It's read only."`. This is the existing refusal path, so nothing spawns and no Claude id is minted.
  - **`_session_brief`** adds `"device": store.parse_device(s.get("device"))`.
  - **Docstring:** `device_view.py` explains why it doesn't reuse `runner._handle_event`. That code copies or moves files named in the stream, stores the teammate's Claude session id (which boot recovery would then resume on the owner's account), and registers a Job that Rivendell's progress tick would report.
- [ ] **Step 4: Run the new tests, then the whole suite.** Expected: only the 7 known failures remain.
- [ ] **Step 5: Commit** with `git commit -m "device runs: a teammate's run is a read-only session fed from its own stream, never resumed or run on this account"`.

---

### Task 4: Live view during the run, owner STOP, and taking a run back after a restart

**Files:**
- Modify:
  - `bridge/device_side.py` (`_run` :172-213, `_start` :241-264, `_result` :267, `sweep` :370, the docstring)
  - `bridge/rivendell.py` (`_catch_up` :869-935, a new `Worker._adopt_device_run`, `start()` :2937-2942)
  - `bridge/notices.py` (CATALOG :44 and VERBS)
- Test: `tests/test_device_side.py` (FakeHelper :88-135, fake Worker :51-85, the autouse seam fixture :176-194), `tests/test_rivendell.py` (device-run tests :2610-2760), `tests/test_notices.py`

**Interfaces:**
- Consumes: Task 3's `device_view.Run`, `reopen`, `orphans` and `prune`; Task 1's `live.jsonl` and `claude.json` contract.
- Produces:
  - `device_side.stop_by_owner(request_id: str, run=subprocess.run) -> None`
  - `device_side.helper_alive(request_id: str, run=subprocess.run) -> bool`: `/bin/ps -axo command=`, then any line ending in `mystical-run-helper start <request_id>`.
  - `device_side.take_adopted(instance: str) -> list[str]`
  - `device_side.resume(worker, request_id: str, call=subprocess.run, alive=helper_alive) -> None`
  - The notice kind `"rv_ended"`, mapped to `("started", "fyi", "rivendell")` with verb `"ENDED"`.

- [ ] **Step 1: Write the failing tests.**
  - `test_a_run_streams_into_its_view`: FakeHelper appends stream lines to `<stage>/live.jsonl` across beats. The view's session gains the events before the helper exits, and `close("done")` follows the result POST.
  - `test_owner_stop_during_unpack_posts_failed_once`: `stop_by_owner` before the helper starts. The stop is resent each beat, exactly one FAILED with `"Stopped by this device's owner."` is posted, and the outcome is `"stopped"`.
  - `test_a_rivendell_cancel_still_posts_nothing`: a regression guard for the existing `_cancelled` path.
  - `test_sweep_adopts_a_live_helper_and_resume_posts_once`, in two parts:
    - `sweep(run=…, alive=lambda rid: True)` keeps the stage, stops nothing, and lists the id under its instance.
    - `resume` with `alive` true for two beats, then false and an `exit.json` in place, adds the divider `Mystical restarted HH:MM · this run kept going`, pumps from the saved offset, posts once, closes the view and drops the stage.
  - `test_sweep_still_stops_a_dead_helpers_stage`: the existing behaviour when `alive` is false, plus `device_view.orphans` closing that run's turn.
  - `test_resume_without_exit_json_fails_clearly`: FAILED `"The run ended before it handed back its results."`.
  - `test_run_without_live_file_still_reports`: an old helper. With no `live.jsonl` and a single-object `claude.json`, the run is COMPLETED as today, and the view's only text is the summary.
  - `test_a_finished_run_rings_once_more`: `_note("rv_ended", …)` with `job_kind="device-run"`, and Telegram only when `notices.telegram_ok("rv_ended")`.
  - In test_rivendell: `test_catch_up_adopts_before_listing_device_runs`. `take_adopted` ids start through `_adopt_device_run`, which sets `_device_run`, before the pending list is read. A pending run that arrives meanwhile is acked `"queued"`.
- [ ] **Step 2: Run them.** Expected: they fail.
- [ ] **Step 3: Implement.**
  - **`_run`:**
    - Calls `device_view.Run.open(worker.inst["id"], request_id, claim)` right after the `rv_started` note.
    - `_start` takes the view and calls `view.pump(stage)` on every beat and once after the helper exits.
    - `_start` also resends the stop on a beat while `request_id in _owner_stopped`, just as it does for `_cancelled`.
    - After `_result`, an owner-stopped run's body becomes `{"status": "FAILED", "error": "Stopped by this device's owner.", "screens": []}` and is posted.
    - Rivendell-cancelled runs still post nothing.
  - **`_upload`** also hands the uploaded `(name, bytes)` to `view.screens`.
  - **`view.close`** takes the outcome: done, failed or stopped.
  - **`sweep(run, alive=helper_alive)`:**
    - A stage whose helper is alive is filed in `_adopted[instance]` and kept.
    - Others go as today.
    - It ends with `device_view.orphans(keep=set(all adopted ids))`.
  - **`resume`:**
    - Reads `job.json`.
    - Gets `device_view.reopen(request_id)` and adds the divider (time = now, `HH:MM`).
    - Loops on beats while `alive(...)`. Each beat it pumps, and it calls `_stop` when the run is cancelled or owner-stopped. The deadline is `job.json`'s mtime plus `timeoutSeconds + _SLACK + _GIVE_UP`.
    - Then it does a final pump and builds `_result(..., rc=0, err="", late=…)`. A missing `out/exit.json` gives the clear error above.
    - Then it posts (unless cancelled), records the last run, closes the view and drops the stage.
    - Mark it `shortcut:`: the old sudo child is a zombie of the re-exec'd bridge, never reaped, which is harmless.
  - **`rivendell.py`:**
    - In `_catch_up`, before the device-run catch-up listing at :930, start every id from `device_side.take_adopted(self.inst["id"])` through `_adopt_device_run`.
    - `_adopt_device_run` mirrors `_run_device_run`'s `_device_run` bookkeeping and its `finally` (clear the slot, `_start_next_device_run`). It starts a `rivendell-adopt-<id>` thread.
    - `start()` calls `device_view.prune()` after `sweep()`.
  - **`_run` and `resume`** each emit `rv_ended` once after posting. The title is `"<name>'s run on this device ended"`. The body is the outcome and minutes.
- [ ] **Step 4: Run the device, rivendell and notices tests, then the whole suite.** Expected: only the 7 known failures remain.
- [ ] **Step 5: Commit** with `git commit -m "device runs: the owner watches a run live, can stop it, and a Mystical restart no longer ends it"`.

---

### Task 5: Dashboard routes — STOP RUN and the running run's session

**Files:**
- Modify: `bridge/dashboard/server.py` (`_device_rows` :215-240; a new POST case right before the `/local/device-runs/list|start|cancel` tuple at :1607)
- Test: `tests/test_dashboard_device_routes.py` (autouse refusal fixture :41-77; add `device_side` there; `dpost` :120)

**Interfaces:**
- Consumes: `device_view.running_session()`, `device_side.stop_by_owner`, and `store.get_session(sid)["ref"]`.
- Produces:
  - `GET /local/rivendell/devices` rows gain `running_session: str | None`.
  - `POST /local/device-runs/stop` with `{"session": sid}` answers `{"ok": true}`. It answers 404 `{"error": "not a device run going on this device"}` unless `sid` is the running device-run session.

- [ ] **Step 1: Write the failing tests.** The device row carries `running_session`. A stop with the running sid calls the faked `stop_by_owner(request_id)`. A wrong or finished sid returns 404 and stops nothing. The route sits behind the usual POST gate (copy `_post_through_the_gate` :331).
- [ ] **Step 2: Run them.** Expected: they fail.
- [ ] **Step 3: Implement.** The request id comes from the session's `ref` (`device-run:<rid>`). The stop runs on a thread, because it can take up to 60 s.
- [ ] **Step 4: Run the tests and the whole suite.** Expected: pass.
- [ ] **Step 5: Commit** with `git commit -m "device runs: STOP RUN and the running run's session for the dashboard"`.

---

### Task 6: Dashboard — the DEVICE RUNS lane, the read-only view, and the link from Settings

**Files (all under `bridge/dashboard/web/src/`):**
- Create: `lib/devicerun.ts`, `lib/devicerun.check.ts`, `components/DeviceRunPlate.tsx`
- Modify:
  - `api.ts`: `SessionBrief.device`; the `RunEvent` union gains `{ type: "divider"; text: string }`; `RivendellDevice.running_session`; `api.stopDeviceRun(session)`
  - `components/hud/SessionsPanel.tsx` (`PLUGINS` :86, lanes :456, `SessionRow` :171-288, `modeTabs` :886)
  - `App.tsx`: `projectGroups` :1633; the composer swap at :2366; a `hud:open-session` listener beside `hud:settings` at :1199; hide "Attach & resume" for device runs at :1903
  - `components/Terminal.tsx`, `components/Transcript.tsx`, `components/PromptBubble.tsx` (`who`)
  - `components/RunStream.tsx` (a `case "divider"` in `renderEvent` :2022)
  - `lib/segments.ts` (`PROSE` :37)
  - `components/hud/DeviceRunsPanel.tsx` (STATE row :227)
  - `index.css`

**Interfaces:**
- Consumes: Tasks 3 and 5's JSON (`device`, `running_session`, `/local/device-runs/stop`) and the `divider` event.
- Produces, in `lib/devicerun.ts`:
  - `isDeviceRun(origin?: string|null): boolean`
  - `rowAge(s: SessionBrief, working: boolean, now: number): { text: string; tone: "run"|"ok"|"bad"|"idle" }`, where `text` is the elapsed time while working and `✓`/`✕` plus the age after
  - `plateStatus(working: boolean, outcome: string|null, minutes: number): string`, giving `RUNNING · LOW PRIORITY`, `DONE · 33 MIN`, `FAILED · …` or `STOPPED · …`
  - `openSession(id)`, which dispatches `hud:open-session`

- [ ] **Step 1: Write `lib/devicerun.check.ts`** with one assertion per output above, including that `rowAge` uses `s.created` for the elapsed time. Run it. Expected: it fails, because the module is missing.
- [ ] **Step 2: Implement the lib.** Run the check again. Expected: ok.
- [ ] **Step 3: Implement the UI, reading the mockups for layout and copy.**
  - **SessionsPanel:**
    - `PLUGINS` gets `{ origin: "device-run", label: "DEVICE RUNS", sub: "teammates on this device", tint: "var(--info)" }` first. The RIVENDELL entry keeps `tint: "var(--purple)"`.
    - `mine = sorted.filter(s => !isDeviceRun(s.origin))` feeds ATTENTION, RECENT, PROJECTS and the attention count.
    - In `SessionRow`, a device-run row's second line is a phone badge, the asker (`--info`), and `repo #pr` in mono. Its age comes from `rowAge`.
    - The Plugins tab icon carries a blue dot while any device-run session is working.
  - **App:**
    - `projectGroups` skips device runs.
    - `composer` is `<DeviceRunPlate s={selected} working={…} />` when `isDeviceRun(selected?.origin)`.
    - `hud:open-session` closes Settings and calls `openSession(id); toChat()`, never `selectSession`.
  - **DeviceRunPlate:**
    - It reuses the composer's tab shell: `className="composer" data-pb="tabs"`, `.pb-tabs.pb-lead` with `useChatChrome().lead`, a right tab with `className="ctrl-ctx"` showing `plateStatus`, and `.cmdbox.pb-card`.
    - The read-only line is `Read only. <by>'s run on this device, as mysticalruns. It runs at low priority, keeps going through Mystical restarts and updates, and your sessions never wait for it.`. Once the run ends, it is the finished line from mockup 03.
    - The chips are the asker and `repo #pr sha7`.
    - `STOP RUN` shows while working. It confirms with `askConfirm("Stop <by>'s run on this device? <by> gets it back as failed.")`, then calls `api.stopDeviceRun`. A 404 (an older bridge) shows `Restart Mystical to stop runs from here.`.
  - **PromptBubble** gets `who?: string`. It is threaded Terminal → Transcript → TurnBlock for turn 0 of a device-run session only, and renders `who ?? "YOU"`.
  - **RunStream:** `case "divider"` renders a full-width row in the zone. It copies `BootRow`'s look: a refresh glyph, uppercase tracked text, the time in mono, and a dashed rule. `"divider"` is added to `PROSE`.
  - **DeviceRunsPanel:** next to `running now`, an `OPEN ›` text button calls `openSession(d.running_session)` when it is set.
- [ ] **Step 4: Verify.**
  - Run `npx tsc -b` and every `src/lib/*.check.ts` this task touched, then `npm run build`.
  - Screenshot the PLUGINS tab and a device-run session through `.mystical/probe-mac/device-run-view/probe.py`, extended with canned `/local/sessions`, `/local/running` and `/local/transcript/<sid>` for one running and one finished device run. Use `shot.mjs` or `cdp.mjs` in flint-violet, then compare against the three mockups.
  - Expected: the lane, the row, the plate and the divider match the mockups. No console errors.
- [ ] **Step 5: Commit** with `git commit -m "dashboard: teammates' device runs in PLUGINS ▸ DEVICE RUNS, opened read only with STOP RUN"`.

---

### Shipping (not a task: needs the user)

After the final whole-branch review:
1. Run the full suite and the build on the branch.
2. Ask the user whether to merge into master and restart the bridge now. A restart interrupts sessions that are working, and they resume on their own. Never restart while a device run is in flight unless the user says to: until this code runs, a restart ends it.
3. Once this is live, the owner presses SET UP once (one Mac password) to install the new helper.
4. Pushing needs the user's own words.
