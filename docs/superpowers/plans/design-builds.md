# Design builds: Mystical implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bridge runs Rivendell's new `design-build` job: in the local checkout of the design's repository, the agent builds the single-file prototype (or says why it can't), the bridge uploads the page and posts the answer, and tells the owner on Telegram.

**Architecture:** One more kind in `bridge/rivendell.py`, wired exactly like `conflict` (needs a checkout, runs with tools on an implementation's clock), plus one step the other kinds don't have: after the run, when the answer says `built`, the bridge reads `.mystical/design-build/<requestId>.html` from the checkout and `PUT`s it to Rivendell before posting the result. The dashboard and Mini App learn the kind's word.

**Tech Stack:** Python 3 stdlib (bridge), pytest, React + TypeScript (dashboard, Mini App).

**Spec:** `docs/superpowers/specs/design-builds.md` (written in Task 1 from the Rivendell spec `/Users/mhzrerfani/Projects/.worktrees/rivendell/feat-design-builds/docs/superpowers/specs/2026-10-26-design-builds-design.md`, whose Mystical section and the Rivendell plan's **contract** are what this builds against).

## Global Constraints

- Work in the worktree `/Users/mhzrerfani/Projects/.worktrees/mystical-assistant/feat-design-builds` (branch `feat/design-builds`), per the `bridge-worktree` skill: never `mystical restart`, never touch `~/.bridge_state/bridge.db`; tests pin `BRIDGE_DB` already.
- Stdlib only in the bridge. No new npm dependency.
- Commits: one short line (`area: sentence`), no body, no co-author line; `git -c user.email=mhzrerfani@gmail.com commit -m "…" -- <paths>`. Never push.
- Tests: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` (fully green on master `8bd75acf`; anything red is yours). One file: `… -m pytest tests/test_rivendell.py -q`.
- Type-check the web code without installing: `ln -s /Users/mhzrerfani/Projects/mystical-assistant/bridge/dashboard/web/node_modules bridge/dashboard/web/node_modules` and the same for `bridge/miniapp/web`, then `./node_modules/.bin/tsc -p tsconfig.app.json --noEmit` in each, and `node bridge/dashboard/web/src/lib/jobs.check.ts`. The `dist/` bundles are rebuilt at ship time (bridge-ship), not here.
- **The contract** (the Rivendell plan's Global Constraints are the source; copy here for the implementer):
  - Frame: `{"type": "design-build-request", "requestId", "mode": "build" | "setup", "design": {"id", "title", "url"}, "repository": {"id", "fullName"}, "branch": "main" | null}`. The queue slug is `repository.fullName`.
  - Catch-up `GET /plugin/design-build-requests` → rows `{ id, mode, designId, designTitle, projectName, url, repositoryFullName, branch, createdAt }` (flat: the design's title is `designTitle`, its page `url`).
  - Claim `GET /plugin/design-build-requests/<id>/prompt` → `{ requestId, status, prompt, mode, repositoryFullName, branch, designTitle, url }`.
  - File `PUT /plugin/design-build-requests/<id>/file`, the page as the raw body, `Content-Type: text/html; charset=utf-8`, at most 25 MB → 204.
  - Result `POST /plugin/design-build-requests/<id>/result` `{ status, result | error, model }` as every kind (`_post_result`).
  - The prompt's first line: `You are building a design version for the team: the web prototype "<title>" of the project <project>.`
  - The answer: one JSON object, maybe in a ```json fence, `{"outcome": "built" | "unsuitable" | "no-preview", "commit", "changelog": [...], "summary", "suggestion", "branch", "pullRequestUrl"}`.
  - The built page: `<checkout>/.mystical/design-build/<requestId>.html`.
- Naming in what the owner reads: "design build" (queue ask), "Design built" / "No preview build" / "Not suitable" (Telegram), DESIGN (the dashboard and Mini App tag).

## Review Focus

- The answer says `built` but the file is missing or is a symlink: the result is FAILED with a reason naming the path, nothing is uploaded (Task 1).
- The answer says `built` and the file is over 25 MB: FAILED with the size, nothing uploaded (Task 1).
- The upload fails (network, 400 from Rivendell): the result posted is FAILED saying the page did not upload; the transcript stays in the dashboard (Task 1).
- A catch-up row (flat) and an event (nested `design`) both give the Telegram message its title and link (Task 2).
- A `no-preview` answer: the Telegram line carries the suggestion's first line, and Open design opens the design's page (Task 2).

---

### Task 1: The kind in the bridge

**Files:**
- Create: `docs/superpowers/specs/design-builds.md` (one page: what the job is, the contract above, what this bridge does, what it refuses)
- Modify: `bridge/rivendell.py` (`_handle_message`, `_enqueue`, `_catch_up`, `_apply_policy`, `_KIND_PATH`, `_KIND_LABEL`, `_run_accepted`, new `_run_design_build`, module-level `_design_report`, `_built_file`)
- Modify: `tests/test_rivendell.py`

**Interfaces:**
- Produces: `Worker._run_design_build(self, request_id: str, slug: str | None) -> None`; `Worker._designs: dict` (request id → `{"title", "url"}`, filled by `_enqueue` from `src["design"]` or the flat `designTitle`/`url`, read by Task 2's ping); `_design_report(answer: str) -> dict | None` (the JSON object with `outcome` in `("built", "unsuitable", "no-preview")`, read like `_conflict_report`); `_built_file(workdir: str, request_id: str) -> tuple[bytes | None, str]` (the page's bytes, or None and why: `no built page at .mystical/design-build/<id>.html`, `the built page is <n> MB, over 25 MB`; a regular file only, opened with `O_NOFOLLOW` as `device_side._upload` does); `_DESIGN_FILE_MAX = 25 * 1024 * 1024`.
- Behaviour: `_handle_message` queues `design-build-request` as kind `"design-build"` under `repository.fullName` (printing `design build requested in <repo>: <title>`); `_catch_up` lists `/plugin/design-build-requests` the way it lists conflicts; `_apply_policy` refuses `design-build` with no checkout like `impl`/`conflict` (`what = "Design build"`); `_KIND_PATH["design-build"] = "design-build-requests"`, `_KIND_LABEL["design-build"] = "design build"`; `_run_accepted` dispatches it. `_run_design_build`: claim; `slug = resp.get("repositoryFullName") or slug`; no checkout → `_post_result(…, False, f"no local checkout for {slug!r} under {config.BASE_PATH}")`; `_start_run(prompt, workdir, hang_timeout=self.inst.get("impl_timeout", 10800))`; `_track(request_id, "design-build", slug, sid, label=None, link=None)`; `_wait_job` on the same clock; when `ok` and the report's outcome is `built`: `_built_file` → on None post FAILED with the reason; else `_api_put_bytes(f"/plugin/design-build-requests/{request_id}/file", data, "text/html; charset=utf-8")`, and an exception there posts FAILED `f"the built page did not upload: {e}"`; finally `_post_result("design-build-requests", request_id, ok, text)`.

- [ ] **Step 1: Write the failing tests** (beside the conflict tests, with `_worker()`, `_drain`, the `acks` fixture, `monkeypatch`):
  - `test_handle_message_design_build_requests`: the frame of the contract queues `("design-build", "b1", "ainurdev/nr-kantoor")` once, and `w._designs["b1"] == {"title": "Student card", "url": "https://riv.example/projects/p1/designs/d1"}`.
  - `test_catch_up_queues_design_build_requests`: a flat row `{"id": "b1", "mode": "build", "designTitle": "Student card", "url": "…", "repositoryFullName": "ainurdev/nr-kantoor", "branch": "main"}` queues `("design-build:b1", "ainurdev/nr-kantoor")` and fills `_designs["b1"]` the same.
  - `test_design_build_without_checkout_is_refused`: like `test_conflict_without_checkout_is_refused`, against `/plugin/design-build-requests/b1/refuse`.
  - `test_run_design_build_uploads_the_page_then_posts_the_answer`: `_fetch_prompt` → `{"prompt": "build it", "repositoryFullName": "ainurdev/nr-kantoor", "mode": "build"}`; `_find_checkout` → `tmp_path`; the file `tmp_path/.mystical/design-build/b1.html` holds `<!doctype html><html>…`; `_wait_job` → `(True, '{"outcome": "built", "commit": "abc1234", "changelog": ["x"], "summary": "Built."}')`; `_api_put_bytes` recorded; asserts `started == [("build it", str(tmp_path), 10800, {})]`, `tracked == [("b1", "design-build", "ainurdev/nr-kantoor", "s1")]`, the PUT `("/plugin/design-build-requests/b1/file", <the bytes>, "text/html; charset=utf-8")`, and `posted == [("design-build-requests", "b1", True, <the answer>)]`.
  - `test_run_design_build_fails_when_the_page_is_missing`: the same with no file → nothing PUT and `posted == [("design-build-requests", "b1", False, "no built page at .mystical/design-build/b1.html")]`.
  - `test_run_design_build_fails_when_the_page_is_too_big`: a 26 MB file → FAILED `the built page is 26 MB, over 25 MB`; a symlink in place of the file → FAILED as missing.
  - `test_run_design_build_posts_other_outcomes_as_they_are`: the answer `{"outcome": "no-preview", "summary": "…", "suggestion": "…"}` is posted with `ok` and nothing is PUT.
  - `test_run_design_build_fails_when_the_upload_fails`: `_api_put_bytes` raising `RuntimeError("boom")` → FAILED `the built page did not upload: boom`.
  - The `test_each_kind_is_routed_by_its_own_path_never_the_review_fallback` parametrize gains `("design-build", "design-build-requests", "_run_design_build")`.
  - `test_queued_message_names_a_design_build`: `"Rivendell design build queued — ainurdev/nr-kantoor"`.
- [ ] **Step 2: Run them, expect failures** — `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_rivendell.py -q -k design` → FAIL (no runner, no kind).
- [ ] **Step 3: Implement** as the Interfaces say. Write the spec page first (the contract, the three outcomes, what the bridge does, the refusals), in the repo's spec style (a title, "Decisions", "Not built").
- [ ] **Step 4: Run the tests, expect PASS** — `… -m pytest tests/test_rivendell.py -q`, then the whole suite `… -m pytest tests/ -q`.
- [ ] **Step 5: Commit** — `rivendell: run design builds in the repository's checkout`

### Task 2: What the owner reads: the Telegram ping, the session's facts, the bell

**Files:**
- Modify: `bridge/rivendell.py` (`_design_message`, `_ping_done`)
- Modify: `bridge/rivendell_jobs.py` (`KINDS`, `facts`, `title`, `_MARKS`, `_TITLE_MARKS`, `classify`)
- Modify: `bridge/notices.py` (`_RV_DONE`)
- Modify: `tests/test_rivendell.py`, `tests/test_rivendell_jobs.py`, `tests/test_notices.py`

**Interfaces:**
- Produces: `_design_message(meta: dict, answer: str) -> tuple | None` (pure; `meta` is `{"title", "url"}`): for `built` → lines `["◫ Design built: <title>", <summary[:200]>]`; `no-preview` → `["◫ No preview build: <title>", <first non-empty line of suggestion, else summary>[:300]]`; `unsuitable` → `["◫ Not suitable: <title>", <summary[:300]>]`; without a title the first line drops `: <title>`; the keyboard is `{"inline_keyboard": [[{"text": "Open design ↗", "url": url}]]}` when `url` is set, else None; None when the answer holds no report (the generic done message then).
- Behaviour: `_ping_done` pops `self._designs[request_id]` for `job_kind == "design-build"` and uses `_design_message(meta, text)` when `ok`, beside the conflict's.
- `rivendell_jobs.py`: `KINDS` gains `"design-build"`; `facts` names it by the design's title (`_pick(design.get("title"), s.get("designTitle"), c.get("designTitle"))` with `design = s.get("design") or {}`) and keeps `url` from `design.get("url")` too; `title()` gives `f"{name} · design build"`, None without a name; `_MARKS` gains `("design-build", "You are building a design version")` and `_TITLE_MARKS` `("design-build", "You are building a design version for the team")`; `classify` reads the title from `the web prototype "(.+?)" of the project` and `repo` from `^Repository: (\S+)`.
- `notices.py`: `_RV_DONE["design-build"] = "BUILT"`.

- [ ] **Step 1: Write the failing tests**
  - `test_rivendell.py`: `_design_message` for the three outcomes with and without a title and url, and None for prose; `_ping_done` for a `design-build` result delivers the design message (monkeypatch `_deliver_telegram`, `_note`, `notices.telegram_ok` → True, `store.sessions_for_refs` → a session) with `Open design ↗`.
  - `test_rivendell_jobs.py`: `facts("design-build", "b1", "t1", src=<the frame>)` has `title: "Student card"`, `repo: "ainurdev/nr-kantoor"`, `url`; the same from the flat catch-up row; `title({"kind": "design-build", "title": "Student card"}) == "Student card · design build"`; `classify("You are building a design version for the team: the web prototype \"Student card\" of the project NR Kantoor.\n\nDesign: Student card\nProject: NR Kantoor\nRepository: ainurdev/nr-kantoor (https://github.com/ainurdev/nr-kantoor)\n") == {"kind": "design-build", "title": "Student card", "repo": "ainurdev/nr-kantoor"}`.
  - `test_notices.py`: a `rv_done` with `job_kind: "design-build"` reads BUILT in the bell, beside the conflict's RESOLVED test.
- [ ] **Step 2: Run them, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `… -m pytest tests/ -q`, expect green.**
- [ ] **Step 5: Commit** — `rivendell: a design build tells its owner what it built`

### Task 3: The kind's word in the dashboard and the Mini App

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts` (both `kind` unions), `bridge/dashboard/web/src/lib/jobs.ts` (`JOB_LABEL`, `jobTarget`), `bridge/dashboard/web/src/lib/jobs.check.ts`, `bridge/dashboard/web/src/components/hud/JobTag.tsx` (`JOB_ICON`), `bridge/dashboard/web/src/components/hud/RivendellQueue.tsx` (`KIND_LABEL`)
- Modify: `bridge/miniapp/web/src/components/SurfaceBadge.tsx` (`JOB_WORD`)

**Interfaces:**
- Produces: `"design-build"` in both `api.ts` unions; `JOB_LABEL["design-build"] = "DESIGN"`, `KIND_LABEL["design-build"] = "DESIGN"`, `JOB_WORD["design-build"] = "DESIGN"`; `jobTarget` answers the repository's name for a design build (`case "design-build": return repoName(job.repo)`); `JOB_ICON["design-build"] = PenTool` (lucide, the icon Rivendell's Designs card uses); `oneShot` stays as it is (a build's answer is the point, so the job bar shows).

- [ ] **Step 1: Add the checks** to `jobs.check.ts`: `jobLabel({ kind: "design-build" }) === "DESIGN"`, `jobTarget({ kind: "design-build", repo: "ainurdev/nr-kantoor" }) === "nr-kantoor"`, `oneShot({ kind: "design-build" })`.
- [ ] **Step 2: Run `node bridge/dashboard/web/src/lib/jobs.check.ts`**, expect the new assertions to fail.
- [ ] **Step 3: Implement** the six edits.
- [ ] **Step 4: Verify** — the checks pass; `./node_modules/.bin/tsc -p tsconfig.app.json --noEmit` is clean in `bridge/dashboard/web` and `bridge/miniapp/web` (through the node_modules symlinks); `… -m pytest tests/ -q` still green.
- [ ] **Step 5: Commit** — `dashboard: a design build reads DESIGN`
