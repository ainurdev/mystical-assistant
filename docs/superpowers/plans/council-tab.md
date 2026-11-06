# COUNCIL tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a COUNCIL right-rail tab. RUN has Claude and Codex rate what a push would send (1–10) and list findings. While the score is under the bar, the session that wrote the code fixes them and the reviewers score it again, until it passes or stops.

**Architecture:**
- `bridge/council.py` (stdlib) owns everything: settings, the review material, the reviewer runs, merging, the round loop and the actions. State is one JSON column, `sessions.council`.
- The loop rides the session's own queue, the way `bridge/goals.py` does, and is chained first in `runner._continue_after_turn`.
- The dashboard gets 4 routes, a `CouncilPanel` in the right rail drawn as A · SCOREBOARD, a Council fold in Settings ▸ AI management, and a `[council` stamp in `PromptBubble`.

**Tech Stack:** Python 3 stdlib, SQLite (`bridge/store.py`), React + TypeScript (Vite), lucide-react (installed).

**Spec:** `docs/superpowers/specs/council-tab.md`. Mockups: `/Users/mhzrerfani/Projects/mystical-assistant/.mystical/design-drafts/council-tab/` (`shots/a-1-ready.png`, `a-2-running.png`, `a-3-passed.png`, `a-4-stopped.png`, `settings-council.png`; source in `src/a.html`, `src/council.css`, `src/data.js`).

## Global Constraints

**Work and tooling**
- Work only in `/Users/mhzrerfani/Projects/.worktrees/mystical-assistant/feat-council-tab` on branch `feat/council-tab`. Never push.
- Never restart the bridge, never run `mystical restart`, and never use `pkill -f`. This session runs inside the live bridge.
- Python is stdlib only. Add no dependency, in Python or in web.
- Tests run with `~/.cache/mystical-test-venv/bin/python -m pytest`. `tests/conftest.py` already pins a temp DB.
- Any manual script needs `BRIDGE_DB=/tmp/council-*.db` set in its environment.
- Type-check with `npx tsc --noEmit -p tsconfig.app.json`, run in `bridge/dashboard/web`. Plain `-p .` checks nothing.
- Run web checks with `node bridge/dashboard/web/src/lib/<x>.check.ts`.
- Commit messages are one short line, with no body and no co-author line.

**Code conventions**
- `bridge/council.py` opens with a module docstring that gives the why and what was not built (see the spec's "Not built").
- Nothing in the council may raise into a turn. `after_turn` and the notice calls swallow their own errors.

**Values**
- bar 9.0 (1–10, steps of 0.5); max_rounds 5 (1–10); stop_early true.
- `NEAR = 3` lines; `SEAT_TIMEOUT = 900` s; `DIFF_CAP = 150_000` chars.
- The panel polls every 3 s while a run is reviewing or fixing, and every 15 s otherwise. The hero is 230 px tall in every state.

**Copy, exactly as in the mockups**
- Labels: COUNCIL, NOT REVIEWED, ROUND n OF m, PASSED IN n ROUNDS, STOPPED · NEEDS YOU, BAR 9.0, IT WILL REVIEW, ROUND n FINDINGS, LEFT AS ADVICE, Fixed on the way, THEY DISAGREE · k ROUNDS, ROUND n · ALSO FOUND.
- Buttons: Run council, Open the chat, Stop, Push N commits, Again, 2 more rounds, Push anyway, Side with the session, Fix it anyway, Send.

## Review Focus

1. **A reviewer that never answers** (a hung `claude -p` or Codex) must not hold the round. That seat times out, and the round scores on the other seat. Tested in Tasks 2 and 3.
2. **A huge diff** (a generated file, a lockfile) goes in capped at `DIFF_CAP` with `truncated: True`, and the prompt names the files it left out. Tested in Task 2.
3. **The user prompts while the council's fix prompt is queued.** That turn's end must not start the next round. Only the turn that ran the council's own queue item does. Tested in Task 3.
4. **The bridge restarts mid-round.** A run that says `reviewing` from a dead process (`pid` differs) shows as stopped: "interrupted by a restart". So does a run that says `fixing` whose queue item is gone. Tested in Task 3.
5. **The work changes under the loop.** The branch is pushed elsewhere or everything is committed and pushed, so a later round finds nothing to review. The run then stops with "nothing left to review", not an error. Tested in Task 3.

---

### Task 1: Council core — settings, state column, parsing, merging, deciding

**Files:**
- Create: `bridge/council.py`
- Modify: `bridge/store.py`. Add the `council TEXT` column on `sessions` to `_SCHEMA`, add an idempotent `ALTER` in `init()` next to `goal` (~:177), and add `get_council` / `set_council` next to `get_goal` / `set_goal` (~:916).
- Test: `tests/test_council.py`

**Interfaces (produces):**
- `store.get_council(sid: str) -> dict | None` and `store.set_council(sid: str, c: dict | None) -> None` store the state as JSON; None clears it.
- `council.DEFAULTS = {"bar": 9.0, "max_rounds": 5, "stop_early": True, "claude": True, "codex": True, "codex_projects": []}`, `council.SEATS = ("claude", "codex")`, `council.NEAR = 3`.
- `council.settings() -> dict` returns DEFAULTS overlaid with `store.get_setting("council")` (JSON).
- `council.save_settings(patch: dict) -> dict` validates, clamps, saves, and returns `settings()`. `bar` is rounded to 0.5 and clamped to 1–10; `max_rounds` is an int clamped to 1–10; bools are coerced; `codex_projects` keeps strings only. Unknown keys are dropped.
- `council.parse_review(text: str) -> dict | None` reads the **last** JSON object in the text, fenced or bare. It returns `{"score": float, "summary": str, "findings": [{"sev", "file", "line", "title"}]}`.
  - `score` must be a number from 1 to 10, rounded to 0.1. Anything else returns None.
  - `sev` not in must/should/nit becomes `"should"`. `line` that isn't an int becomes None. A finding with no title is dropped.
- `council.same(a: dict, b: dict) -> bool` is true when the files match and the lines are within `NEAR`. If either line is None, it is true when the files match and the lowercased titles match.
- `council.merge(by_seat: dict[str, dict]) -> list[dict]` takes `{seat: parse_review result}` and returns findings `{"id": "<file>:<line or 0>", "sev", "file", "line", "title", "by": [seats], "state": "open", "answer": ""}`.
  - Equal findings, by `same`, become one, keeping the higher severity and the first title.
  - Sort by must, should, nit, then file, then line.
- `council.blocking(findings: list[dict], ran: list[str], dismissed: list[str]) -> list[dict]` returns the must findings whose `by` covers every seat in `ran`. A finding whose id matches a dismissed id through `same` (the id is parsed back to file and line) doesn't count.
- `council.decide(c: dict) -> str` returns `"passed" | "stopped:max_rounds" | "stopped:stalled" | "fixing"`, from `c["rounds"][-1]` (`score`, `blocking`), `c["bar"]`, `c["max_rounds"]`, `c["stop_early"]`, `c["round"]` and the previous round's score.
- `council.fix_prompt(c: dict) -> str`. The first line is exactly `[council {round}/{max_rounds}] {score:.1f} of {bar:.1f}`. Then this copy:
  > The council reviewed what a push would send, and it isn't ready yet. Fix each finding below. If one is wrong, answer it on its own line as "<number>. NO: <why>". Don't push; when you finish, the council reviews again.

  Then a blank line, then `{i}. {SEV} · {file}:{line} · {by joined with "+"} · {title}`, one per open finding of the last round, numbered from 1 in list order.
- `council.answers(text: str) -> dict[int, str]` takes lines matching `^\s*(\d+)[.)]\s*NO\b[:\s-]*(.+)$` and returns `{number: why}`.

- [ ] **Step 1: Write the failing tests** in `tests/test_council.py`:

```python
from bridge import council, store

def test_parse_review_reads_the_last_json_block():
    t = 'Looks fine.\n```json\n{"score": 3}\n```\nFinal:\n```json\n{"score": 7.46, "summary": "one race", "findings": [{"sev": "must", "file": "bridge/git.py", "line": 584, "title": "push() hides exit 1"}]}\n```'
    r = council.parse_review(t)
    assert r["score"] == 7.5 and r["summary"] == "one race"
    assert r["findings"] == [{"sev": "must", "file": "bridge/git.py", "line": 584, "title": "push() hides exit 1"}]

def test_parse_review_rejects_junk_and_bad_scores():
    assert council.parse_review("no json here") is None
    assert council.parse_review('{"score": 14}') is None
    r = council.parse_review('{"score": 8, "findings": [{"sev": "huge", "file": "a.py", "line": "x", "title": "t"}, {"sev": "nit", "file": "b.py"}]}')
    assert r["findings"] == [{"sev": "should", "file": "a.py", "line": None, "title": "t"}]

def test_merge_joins_near_lines_and_keeps_the_higher_severity():
    by = {"claude": {"score": 7, "findings": [{"sev": "must", "file": "git.py", "line": 584, "title": "A"}]},
          "codex": {"score": 8, "findings": [{"sev": "should", "file": "git.py", "line": 586, "title": "B"},
                                             {"sev": "nit", "file": "taskcheck.py", "line": 10, "title": "C"}]}}
    m = council.merge(by)
    assert [(f["sev"], f["file"], f["by"]) for f in m] == [("must", "git.py", ["claude", "codex"]), ("nit", "taskcheck.py", ["codex"])]
    assert m[0]["id"] == "git.py:584" and m[0]["title"] == "A"

def test_blocking_needs_every_seat_that_ran_and_skips_dismissed():
    both = {"id": "git.py:584", "sev": "must", "file": "git.py", "line": 584, "title": "A", "by": ["claude", "codex"]}
    one = {"id": "x.py:1", "sev": "must", "file": "x.py", "line": 1, "title": "B", "by": ["claude"]}
    assert council.blocking([both, one], ["claude", "codex"], []) == [both]
    assert council.blocking([both, one], ["claude"], []) == [both, one]
    assert council.blocking([both], ["claude", "codex"], ["git.py:586"]) == []

def test_decide_covers_pass_max_stall_and_fixing():
    base = {"bar": 9.0, "max_rounds": 3, "stop_early": True}
    r = lambda s, b=0: {"score": s, "blocking": b}
    assert council.decide({**base, "round": 1, "rounds": [r(9.2)]}) == "passed"
    assert council.decide({**base, "round": 1, "rounds": [r(9.5, 1)]}) == "fixing"
    assert council.decide({**base, "round": 2, "rounds": [r(7.0), r(6.9)]}) == "stopped:stalled"
    assert council.decide({**base, "stop_early": False, "round": 2, "rounds": [r(7.0), r(6.9)]}) == "fixing"
    assert council.decide({**base, "round": 3, "rounds": [r(6), r(7), r(8)]}) == "stopped:max_rounds"

def test_fix_prompt_and_answers():
    c = {"round": 2, "max_rounds": 5, "bar": 9.0, "rounds": [{"score": 8.1, "findings": [
        {"sev": "must", "file": "bridge/git.py", "line": 584, "title": "push() hides exit 1", "by": ["claude", "codex"], "state": "open"}]}]}
    p = council.fix_prompt(c)
    assert p.startswith("[council 2/5] 8.1 of 9.0\n")
    assert "1. MUST · bridge/git.py:584 · claude+codex · push() hides exit 1" in p
    assert council.answers("1. NO: not a bug, see runner.py:271\n2. fixed it\n3) NO - churn") == {1: "not a bug, see runner.py:271", 3: "churn"}

def test_settings_clamp_and_round_trip():
    s = council.save_settings({"bar": 12, "max_rounds": 0, "codex_projects": ["/a", 3], "junk": 1})
    assert s["bar"] == 10.0 and s["max_rounds"] == 1 and s["codex_projects"] == ["/a"] and "junk" not in s
    assert council.save_settings({"bar": 8.7, "max_rounds": 5})["bar"] == 8.5

def test_store_council_column_round_trip():
    sid = store.create_session(555, "/counciltest", origin="dashboard")
    store.set_council(sid, {"status": "passed"})
    assert store.get_council(sid) == {"status": "passed"}
    store.set_council(sid, None)
    assert store.get_council(sid) is None
```

- [ ] **Step 2: Run them and confirm they fail.** `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_council.py -q` should fail with `ModuleNotFoundError: bridge.council`.
- [ ] **Step 3: Implement** the interfaces above in `bridge/council.py` and `bridge/store.py`. Find the last JSON object by scanning from each `{` with `json.JSONDecoder().raw_decode` and keeping the last dict that has a `score`.
- [ ] **Step 4: Run them and confirm they pass.** The same command shows 8 passed.
- [ ] **Step 5: Commit.** `git add bridge/council.py bridge/store.py tests/test_council.py && git commit -m "council: settings, state column, parse, merge, decide"`

### Task 2: Seats — what a push would send, the prompt, the Claude and Codex runs

**Files:**
- Modify: `bridge/council.py`
- Test: `tests/test_council.py`

**Interfaces:**
- **Consumes:**
  - `bridge/git.py` `_run(cwd, *args, timeout=8)` and `default_branch(cwd)`.
  - `runner.run_blocking(...)` (`runner.py:738`).
  - `native.INTERNAL_ONESHOT_TAG`.
  - `acp.run_turn`, `acp.answer` and `acp.cancel`.
  - `acp_agents.preset("codex")`, `available()`, `options_for("codex", acct)`, `argv`, `env_for`, `login_hint` and `auth_method`, used the way `runner._consume_acp` (:2850) does.
  - `profiles.claude_slot(profiles.effective(session))`.
- **Produces:**
  - `council.SEAT_TIMEOUT = 900` and `council.DIFF_CAP = 150_000`.
  - `council.material(cwd: str) -> dict | None` returns `{"base": sha, "head": sha, "commits": [[short_sha, subject]], "files": int, "add": int, "del": int, "untracked": [paths], "diff": str, "truncated": bool, "left_out": [paths]}`, or None when there are no commits, no diff and no untracked files.
    - The base is the merge-base of HEAD with `@{upstream}`. With no upstream, it uses `origin/<default>`, then `<default>`.
    - The diff is `git diff <base>`, which includes uncommitted changes.
    - When the diff is over `DIFF_CAP`, whole-file sections stay in until the cap; the rest go to `left_out` and `truncated=True`.
  - `council.review_prompt(m: dict, settled: list[str], answered: list[str]) -> str` starts with `native.INTERNAL_ONESHOT_TAG`. It then gives:
    - the rubric: 10 = ship as is; 9 = nits only; 7–8 = should-fix issues; 5–6 = a must-fix; below 5 = several must-fix or broken;
    - the severity rules: must = a real bug, data loss, a security hole or broken behaviour you can point to at a line;
    - the JSON contract: `{"score": n, "summary": "<one line, your words>", "findings": [{"sev","file","line","title"}]}`;
    - "Settled by the user, do not raise:" followed by the settled lines;
    - "The author answered these last round; raise one again only if the answer is wrong:" followed by the answered lines;
    - the commits, the untracked files, the diff, and a line naming `left_out` when truncated.
  - `council.seat_claude(prompt: str, cwd: str, chat_id: int, slot) -> dict` calls `runner.run_blocking(chat_id, prompt, cwd=cwd, timeout=SEAT_TIMEOUT, skip_pack=True, permission_mode="plan", new_session=True, account_slot=slot)`. It returns `{"ok": True, **parse_review(text)}`, or `{"ok": False, "error": str}` when there is an error or no score.
  - `council.seat_codex(prompt: str, cwd: str, timeout: float = SEAT_TIMEOUT) -> dict` has the same return shape. It drives `acp.run_turn` on a job-shaped `SimpleNamespace` (see `tests/test_acp.py:17 FakeJob` for the fields).
    - Pass the preset's read-only mode id if the codex preset lists modes.
    - A watchdog thread denies every request in `job.awaiting` with `acp.answer(job, rid, False)`.
    - After `timeout` the watchdog calls `acp.cancel(job, 5)` and the seat returns `{"ok": False, "error": "timed out"}`.
  - `council.seats_for(session: dict, s: dict) -> dict` returns `{"claude": "on"|"off", "codex": "on"|"off"|"sign-in"|"not-allowed"}`.
    - `off` means the switch is off.
    - `not-allowed` means the session's `project` isn't in `s["codex_projects"]`.
    - `sign-in` means the preset isn't available or `options_for("codex", acct).get("signed_in")` is not True.

- [ ] **Step 1: Write the failing tests:**
  - `test_material_reads_commits_and_uncommitted_changes`. Build a bare remote plus a clone in `tmp_path` with `subprocess` git, push one commit, then add a commit and an uncommitted edit. Assert `len(m["commits"]) == 1`, `"uncommitted line" in m["diff"]` and `m["files"] >= 2`.
  - `test_material_is_none_when_nothing_to_review`. A clean clone in sync with its remote gives `material(clone) is None`.
  - `test_material_caps_a_huge_diff`. Add a 200 000-char file plus a small one. Assert `m["truncated"]`, `len(m["diff"]) <= council.DIFF_CAP` and that the big file is in `m["left_out"]`.
  - `test_review_prompt_carries_the_contract`. Assert it starts with `native.INTERNAL_ONESHOT_TAG` and that `'"score"'`, `"must ="`, a settled line and an answered line are all in it.
  - `test_seat_claude_parses_or_reports`. Monkeypatch `runner.run_blocking` to record its kwargs and return `('```json\n{"score": 8}\n```', "s", 0.0, False)`. Assert `ok` with score 8.0 and kwargs `skip_pack=True, permission_mode="plan", new_session=True, account_slot="slot2", timeout=900`. Returning `("boom", "s", 0, True)` gives `ok=False, error="boom"`; returning `("junk", "s", 0, False)` gives `ok=False` with "no score" in the error.
  - `test_seat_codex_times_out_and_denies_requests`. Monkeypatch `acp.run_turn` with a fake that puts `{"r1": {}}` in `job.awaiting` and then blocks on a `threading.Event` that the patched `acp.cancel` sets. Record `acp.answer` calls. Assert `seat_codex(p, cwd, timeout=0.3)` returns `{"ok": False, "error": "timed out"}` within 3 s and that `answer` was called with `rid == "r1", allow False`. A second fake that sets `job.result = '{"score": 9}'` and `job.status = "done"` gives `ok` with score 9.0.
  - `test_seats_for`. Monkeypatch `acp_agents.available`/`options_for` and cover the four codex states plus claude `off`.
- [ ] **Step 2: Run them and confirm they fail.** `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_council.py -q -k "material or prompt or seat"` should fail with AttributeError.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run all of `tests/test_council.py` and confirm it passes.**
- [ ] **Step 5: Commit.** `git commit -am "council: review material, prompt, claude and codex seats"`, after `git add` of new files if any.

### Task 3: The loop — start, rounds, the fix turn, actions, notices

**Files:**
- Modify: `bridge/council.py`
- Modify: `bridge/runner.py:804`. `_continue_after_turn` becomes `council.after_turn(job) or paths.continue_after_turn(job, effort) or goals.continue_after_turn(job, effort)`. Keep the `tickets.after_turn(job)` call first.
- Modify: `bridge/goals.py:45`. `_BRIDGE_PROMPTS` becomes `("[goal", "[council", "⧖", "⏮")`.
- Modify: `bridge/notices.py`. Add `CATALOG` entries `"council_passed": ("done", "news", "session")` and `"council_stopped": ("ask", "needs", "session")`, and matching `VERBS` entries in that dict's format.
- Test: `tests/test_council.py`

**Interfaces:**
- **Consumes:** Tasks 1 and 2; `queue_manager.enqueue`, `snapshot` and the queue's existing remove-item function (find it in `bridge/queue_manager.py`); `state.is_running(sid)`; `runner._notify(chat, text, None, kind=..., sid=..., body=..., meta=...)`.
- **Produces** (Task 4 relies on these):
  - `council._spawn(fn, *args)` starts a daemon thread. Tests replace it so rounds run inline.
  - `council.get(sid) -> dict | None` returns the stored state with the restart rules from Review Focus 4 applied and saved.
  - `council.start(session: dict, cwd: str) -> dict`:
    - It raises `ValueError("running")` if the session is running, `ValueError("busy")` if a run is reviewing or fixing, and `ValueError("nothing")` if `material(cwd)` is None.
    - Otherwise it saves `{"status": "reviewing", "round": 1, "rounds": [], "pid": os.getpid(), "cwd": cwd, "bar", "max_rounds", "stop_early" (copied from settings()), "dismissed": [], "item": None, "since", "at", "seats": {...}}`, calls `_spawn(_round, sid)` and returns `brief(sid)`.
  - `council._round(sid) -> None` runs one round:
    - It runs the `on` seats in parallel and joins each with `SEAT_TIMEOUT + 30`.
    - It records per-seat `{"state": "done"|"error", "score", "summary", "error"}`, merges the findings, marks dismissed ones, and computes `blocking` and the mean score of the seats that answered.
    - It appends `{"n", "score", "blocking": len(...), "seats", "findings", "at"}` and applies `decide`.
    - If the decision is `fixing`, it enqueues `fix_prompt` with `surface="council"` and stores the item id.
    - If it passed or stopped, it notifies.
    - No seat answering means stopped with reason `"no reviewer answered: <first error>"`. `material` None means stopped with reason `"nothing left to review"`.
  - `council.after_turn(job) -> bool`:
    - It returns False unless the session's run is `fixing` and the turn that ended ran the council's queue item. Compare `job.id` with the item's run-job field in `snapshot(sid)["items"]`; an item no longer listed counts as ran.
    - If `job.status != "done"` or the job was interrupted, the run stops with the reason "the fix turn stopped" and a notice.
    - Otherwise it applies `answers(job.result)` to the last round: answered ones get `state="answered"` and the `answer`, and the rest become `fixed`. It then sets `status="reviewing"`, `round += 1`, calls `_spawn(_round, sid)` and returns True.
    - It never raises; on an exception it returns False.
  - `council.act(session: dict, action: str, key: str = "") -> dict` returns `brief(sid)`. The actions are:
    - `stop`: removes a still-queued item; status stopped, reason "you stopped it".
    - `more`: only from stopped; `max_rounds += 2`, then `reviewing`, `round += 1`, `_spawn`.
    - `side`: adds `key` to `dismissed`, recomputes the last round's `blocking`, and passes (with a notice) if `score >= bar` and `blocking == 0`.
    - `fix`: enqueues `[council {round}/{max_rounds}] the user wants this fixed` followed by that finding's line; `max_rounds += 1`; `fixing`; stores the item id.
    - `advice`: enqueues `[council advice]` followed by the last round's non-blocking findings as numbered lines; sets `advice_sent=True` and changes no status.
    - Anything else raises `ValueError("action")`.
  - `council.brief(sid: str, cwd: str | None = None, full: bool = False) -> dict` returns:
    - `status` (`"idle"` when there is no state), `reason`, `round`, `max_rounds`, `bar`, `score` (the last round's, or None), and `rounds: [{"n", "score", "blocking"}]`;
    - `seats: {seat: {"state", "score", "summary", "error"}}`, where idle seats come from `seats_for` (`on`/`off`/`sign-in`/`not-allowed`);
    - `findings`: the last round's findings, each with `blocking: bool`;
    - `previous`: the round before last's findings;
    - `stuck: {"finding", "rounds", "answer"} | None`, the blocking finding with the longest run of matching findings in consecutive earlier rounds (2 or more);
    - `advice`: the last round's non-blocking findings;
    - `fixed_total`, `advice_sent` and `elapsed` (seconds since `since`);
    - with `full=True` and a `cwd`, also `material: {"commits", "files", "add", "del"}` without the diff, or None.

- [ ] **Step 1: Write the failing tests.** Use the autouse fixtures:
  - `council._spawn = lambda fn, *a: fn(*a)`.
  - Monkeypatch `queue_manager.enqueue` to append to a list and return `"item-1"`, and `snapshot` to return a test-controlled items list.
  - Fake `material`, `seat_claude`, `seat_codex` and `seats_for` (both `on`), and capture `runner._notify`.
  - The session comes from `store.create_session(555, "/counciltest", origin="dashboard")`.

  The tests:
  - `test_start_scores_a_round_and_queues_the_fix_prompt`. Claude 7.0 and Codex 8.0 both flag `git.py:584` as must, giving status `fixing`, score 7.5 and one enqueue with a prompt starting `"[council 1/5] 7.5 of 9.0"` and `surface="council"`.
  - `test_round_that_passes_notifies_once`. 9.4 and 9.2 with no musts give `passed`, and the notify kinds are `["council_passed"]`.
  - `test_a_round_without_gain_stops_and_notifies`. Round 1 scores 7.0, then `after_turn`, then round 2 scores 6.9: `stopped`, the reason contains "didn't raise", and the kinds end with `council_stopped`.
  - `test_after_turn_waits_for_the_council_turn`, for Review Focus 3. With the item listed as queued and a different `job.id`, `after_turn` returns False and the round stays 1. Once the item has gone from the snapshot, it returns True and the round becomes 2.
  - `test_after_turn_records_answers`. A `job.result` of `"1. NO: not a bug"` makes the last round's finding 1 `answered` with that text, and the others `fixed`.
  - `test_one_seat_failing_scores_on_the_other`, for Review Focus 1. Codex returns `{"ok": False, "error": "timed out"}`: the score is Claude's, `seats["codex"]["state"] == "error"`, and `blocking` counts Claude's musts.
  - `test_restart_marks_a_live_looking_run_stopped`, for Review Focus 4. Store `status="reviewing", pid=-1` and check `get(sid)["status"] == "stopped"` with "restart" in the reason. Store `status="fixing", item="gone"` with an empty snapshot and check it is stopped too.
  - `test_nothing_left_to_review_stops_quietly`, for Review Focus 5. `material` returns None on round 2: stopped with reason `"nothing left to review"`.
  - `test_start_refuses_when_running_busy_or_empty`. Cover the three `ValueError`s.
  - `test_actions`:
    - `stop` removes the queued item and stops;
    - `more` from stopped raises `max_rounds` by 2 and runs a round;
    - `side` on the only blocking finding with score ≥ bar passes;
    - `fix` enqueues a prompt containing "the user wants this fixed";
    - `advice` enqueues a prompt starting `"[council advice]"`;
    - `"nope"` raises `ValueError`.
  - `test_council_prompts_do_not_rearm_goals`. Check `"[council" in goals._BRIDGE_PROMPTS`.
  - `test_runner_asks_the_council_first`. Monkeypatch `council.after_turn` to return True and `goals.continue_after_turn` to fail if called; `runner._continue_after_turn(job)` returns True.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** One lock (`threading.Lock`) guards each read-modify-write of a session's state.
- [ ] **Step 4: Run `tests/test_council.py` together with `tests/test_goals.py`, `tests/test_notices.py` (if present) and `tests/test_queue_manager.py` (if present). All should pass.**
- [ ] **Step 5: Commit.** `git commit -am "council: rounds, the fix turn, actions and notices"`

### Task 4: Routes and the typed client

**Files:**
- Modify: `bridge/dashboard/server.py`, in the GET router (`_get_api`) and in `_post_api`. The specific paths go before the `startswith` one.
- Modify: `bridge/dashboard/web/src/api.ts`
- Test: `tests/test_council_endpoint.py`, built on the `_dash_handler()` pattern from `tests/test_goals.py:151`.

**Interfaces:**
- **Consumes:** `council.settings`, `save_settings`, `brief`, `start` and `act`; and `_worktree_cwd` (server.py ~:187), resolved the same way as the `/local/git/push` route (~:1702).
- **Produces:**
  - `GET /local/council/settings` returns `settings()`.
  - `POST /local/council/settings` takes a body patch and returns `save_settings(body)`.
  - `GET /local/council/<sid>?full=1` returns `brief(sid, cwd, full)`. It is 404 `{"error": "no such session"}` when the session is missing or belongs to another chat, as the goal route checks.
  - `POST /local/council/<sid>` takes `{"action": "run"|"stop"|"more"|"side"|"fix"|"advice", "key"?}`. `run` calls `start`; the rest call `act`. A `ValueError(code)` returns 409 `{"error": code}`.
  - In `api.ts`, export these interfaces matching `brief()` exactly: `CouncilFinding {id, sev: "must"|"should"|"nit", file, line: number|null, title, by: string[], state: "open"|"fixed"|"answered", answer: string, blocking?: boolean}`, `CouncilSeat {state, score: number|null, summary: string, error: string}`, `CouncilRound {n, score: number|null, blocking: number}`, `CouncilBrief`, and `CouncilSettings {bar, max_rounds, stop_early, claude, codex, codex_projects: string[]}`.
  - Also in `api.ts`, export the functions `council(sid: string, full = false): Promise<CouncilBrief>`, `councilAct(sid: string, action: string, key?: string): Promise<CouncilBrief>`, `councilSettings(): Promise<CouncilSettings>` and `saveCouncilSettings(patch: Partial<CouncilSettings>): Promise<CouncilSettings>`, all through `req<T>`.

- [ ] **Step 1: Write the failing tests:**
  - `test_settings_routes`: the GET returns the defaults, and a POST of `{"bar": 12}` returns `bar == 10.0`.
  - `test_brief_route_idle`: a GET for a fresh session gives `status == "idle"`.
  - `test_run_route_calls_start_and_maps_errors`: monkeypatch `council.start` to record its call and return `{"status": "reviewing"}`, which gives 200. Making it raise `ValueError("busy")` gives 409 `{"error": "busy"}`.
  - `test_unknown_session_is_404`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the routes and the client.**
- [ ] **Step 4: `pytest tests/test_council_endpoint.py tests/test_council.py -q` passes, and `npx tsc --noEmit -p tsconfig.app.json` is clean.**
- [ ] **Step 5: Commit.** `git commit -am "council: dashboard routes and api client"`, after adding the new test file.

### Task 5: The COUNCIL tab (A · SCOREBOARD)

**Files:**
- Create: `bridge/dashboard/web/src/lib/council.ts`, `bridge/dashboard/web/src/lib/council.check.ts` and `bridge/dashboard/web/src/components/hud/CouncilPanel.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx`. Add a `rightTabs` entry after GIT (~:2441) and a light `api.council(sid)` poll for the rail tile.
- Modify: `bridge/dashboard/web/src/components/hud/RightPanel.tsx`. Add an optional `tone?: "ok" | "ask" | "acc"` on `PanelTab` that wins over the derived tone at ~:277, plus its CSS.
- Modify: `bridge/dashboard/web/src/lib/theme.ts:343`. Add `"council"` to `RIGHT_TABS`.
- Modify: `bridge/dashboard/web/src/index.css`. Add `.cn-*` rules translated from the mockup's `src/council.css` (`.sb*`, `.chart`, `.rule`, `.seats`, `.fd`, `.sev`, `.by`, `.fst`, `.needs`, `.foot`) onto the app's tokens. Look at how neighbouring rail panels map colours (accent, ok, ask, err) and copy that. Hard-code no OSGILIATH hex values.

**Interfaces:**
- **Consumes:** the Task 4 client and types.
- **Produces:**
  - `railTile(c: CouncilBrief | null): { badge?: string; tone?: "ok" | "ask" | "acc"; busy: boolean }`:
    - reviewing or fixing gives `{badge: "R" + round, tone: "acc", busy: true}`;
    - passed gives `{badge: score.toFixed(1), tone: "ok", busy: false}`;
    - stopped gives `{badge: score?.toFixed(1) ?? "!", tone: "ask", busy: false}`;
    - otherwise `{busy: false}`.
  - `columns(c): { n: string; v: number | null; cls: "" | "now" | "pass" | "stall" | "left" }[]` returns one entry per `max_rounds`. The current round while reviewing is `now`; a passing last round is `pass`; the last round of a stopped run is `stall`; rounds not run yet are `left`.
  - `rules(c): { avg: boolean | null; shared: boolean | null }` gives null before any round.
  - `hero(c): { pill: string; tone: "dim" | "acc" | "ok" | "ask"; l1: string; l2: string }`. Its copy follows the mockups: NOT REVIEWED / Ready when you are / `bar {bar} · {max} rounds`; `ROUND n OF m` / Reviewing the fixes (or Fixing the findings while fixing) / `needs {bar} · {gap} to go`; `PASSED IN n ROUNDS` / Ready for origin / `6.4 → 8.1 → 9.3 · 18 min`; `STOPPED · NEEDS YOU` / the reason / `best {best} in round {k} · bar {bar}`.
  - `CouncilPanel({ sid, onPushed }: { sid: string; onPushed?: () => void })` draws the four states from the mockups.
    - **Hero:** 230 px tall, holding the score, the chart with the dashed bar line, and the rule chips.
    - **Seats:** each seat shows its spinner while reviewing; the Codex seat in `sign-in` reads "sign in ›", opening Settings ▸ AI management.
    - **Lists:** ROUND n FINDINGS (`previous`) while running; LEFT AS ADVICE (`advice`, each with Send, and a header Send all that calls `councilAct(sid, "advice")`) plus Fixed on the way `fixed_total` when passed; the THEY DISAGREE box from `stuck` plus ROUND n · ALSO FOUND when stopped; IT WILL REVIEW (`material.commits`) when idle.
    - **Pinned foot:**
      - idle: Run council, disabled with a hint while the session runs or when `material` is null;
      - running: Open the chat (scrolls the transcript to its latest turn through the mechanism TurnsPanel's latest button uses; leave the button out if there is none) and Stop;
      - passed: Push N commits, which calls the same push function GitPanel's `sync("push")` uses, then Again;
      - stopped: 2 more rounds, then Push anyway.
    - **Polling:** `api.council(sid, true)` every 3 s while reviewing or fixing and every 15 s otherwise.
    - **Older bridge:** an error containing "404" renders "Restart the bridge to use the council." instead.

- [ ] **Step 1: Write `lib/council.check.ts` first.** Assert `railTile` for all four states; that `columns` for `{status: "reviewing", round: 3, max_rounds: 5, rounds: [6.4, 8.1]}` gives classes `["", "", "now", "left", "left"]`; that `columns` for a stopped 5-round run ends with `stall`; that `rules` is `{avg: false, shared: false}` for score 8.1 with 1 blocking; and the four `hero` pills. Run `node bridge/dashboard/web/src/lib/council.check.ts` and confirm it fails because the module is missing.
- [ ] **Step 2: Implement `lib/council.ts`** and run the check until every line is `ok`.
- [ ] **Step 3: Build `CouncilPanel.tsx`, the CSS, and the App, RightPanel and theme wiring.**
- [ ] **Step 4: Run `npx tsc --noEmit -p tsconfig.app.json` (clean) and `npx vite build` (succeeds) in `bridge/dashboard/web`.**
- [ ] **Step 5: Commit.** `git add -A bridge/dashboard/web/src && git commit -m "dashboard: COUNCIL tab"`

### Task 6: The Council fold in Settings, and the chat stamp

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`. Add an `AimFold` with id `council`, titled Council, inside AI management. Place it after the Skills fold (~:3491). Its hint is "reviews a session's work before origin", and its right side reads `{bar} · {max} rounds · {seats}`.
- Modify: `bridge/dashboard/web/src/components/PromptBubble.tsx` (:17, :91)
- Modify: `bridge/dashboard/web/src/lib/council.ts`, plus its check

**Interfaces:**
- **Consumes:** `councilSettings` and `saveCouncilSettings`; the projects list the Projects fold already loads; `api.acpAgents` / the agents TEST flow for Codex's sign-in, found in the ACCOUNTS ▸ AGENTS code.
- **Produces:**
  - The fold's rows match `settings-council.png`:
    - Pass at, a − / value / + stepper in 0.5 steps over 1–10;
    - Rounds at most, the same in steps of 1 over 1–10;
    - Stop early, the house `Toggle`;
    - Reviewers: Claude with a `Toggle`; Codex with a `Toggle`, its state text (signed in / not signed in), and Sign in, which opens the existing agents place where codex is signed in (`openSettings` deep link);
    - Codex may review: one chip per project in `codex_projects` with ×, then a + Pick projects menu of the known projects, then the dim note "client code stays with Claude".
  - Every change saves at once through `saveCouncilSettings` and shows the returned (clamped) value.
  - `parseCouncilPrompt(text: string): { round: number; max: number; score: number; bar: number; body: string } | { advice: true; body: string } | null` in `lib/council.ts` reads `^\[council (\d+)\/(\d+)\] ([\d.]+) of ([\d.]+)\n` and `^\[council advice\]\n`.
  - PromptBubble draws a stamp in the goal stamp's style: `⚖ COUNCIL 2/5 · 8.1 of 9.0`, or `⚖ COUNCIL · ADVICE`, with the body folded and opening on click.

- [ ] **Step 1: Add `parseCouncilPrompt` cases to `council.check.ts`.** Cover the round form, the advice form, and a plain prompt giving null. Run it and confirm it fails.
- [ ] **Step 2: Implement the parser, the stamp and the fold.**
- [ ] **Step 3: Run the check, `npx tsc --noEmit -p tsconfig.app.json` and `npx vite build`. All should pass.**
- [ ] **Step 4: Commit.** `git commit -am "dashboard: Council settings fold and chat stamp"`

### Task 7: Verify end to end and capture

**Files:**
- Create: `/Users/mhzrerfani/Projects/mystical-assistant/.mystical/design-drafts/council-tab/impl/` (scratch, not in git)

- [ ] **Step 1: Run the full suite from the worktree in the background, with a 10-minute limit:** `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q`. The only reds allowed are the known Mac ones: `test_clip_panel::test_clip_marks_round_trip`, the 2 `test_startup` window tests, and the 2 `test_toolset_endpoints` tests that fail only from a worktree.
- [ ] **Step 2: Run every web check:** `for f in bridge/dashboard/web/src/lib/*.check.ts; do node "$f" >/dev/null || echo "FAIL $f"; done`. No FAIL lines.
- [ ] **Step 3: Start a scratch dashboard from the worktree.** Use `BRIDGE_DB=/tmp/council-e2e.db` on a spare `DASH_PORT` (8891), following the bridge-eyes skill and the "scratch dashboard server from a worktree" recipe.
  - Seed one session and four council states with `store.set_council`: idle, reviewing round 3, passed 9.3, and stopped 8.3 with a stuck finding.
  - Capture the COUNCIL tab in each state at 2x with `.mystical/probe-mac/shots.mjs` or the bridge-eyes CDP driver.
  - Compare the captures against `shots/a-*.png`.
- [ ] **Step 4: Fix whatever the captures show is off from the mockups.** Then commit: `git commit -am "council: match the mockups"`.
