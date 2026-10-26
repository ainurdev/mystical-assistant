# Design builds: the agent builds a design's page in its repository's checkout, the bridge sends it up

**Ask (26 Oct, in Rivendell):** a design's next version, built from its repository by the requester's own Mystical, instead of building by hand and uploading in the browser. Rivendell's half is `docs/superpowers/specs/2026-10-26-design-builds-design.md` in `ainurdev/rivendell`; this page is the bridge's.

## The contract

Rivendell's job kind is `design-build`, wired here like `conflict`. The bridge builds against exactly this:

- **Frame** (websocket): `{"type": "design-build-request", "requestId", "mode": "build" | "setup", "design": {"id", "title", "url"}, "repository": {"id", "fullName"}, "branch": "main" | null}`. It queues under `repository.fullName`.
- **Catch-up:** `GET /plugin/design-build-requests` lists rows `{id, mode, designId, designTitle, projectName, url, repositoryFullName, branch, createdAt}`. They are flat: the title is `designTitle`, the design's page `url`.
- **Claim:** `GET /plugin/design-build-requests/<id>/prompt` answers `{requestId, status, prompt, mode, repositoryFullName, branch, designTitle, url}`. The prompt is Rivendell's. Its first line is fixed (`You are building a design version for the team: the web prototype "<title>" of the project <project>.`), so a session can be told apart later.
- **The answer:** one JSON object, perhaps in a json code fence: `{"outcome": "built" | "unsuitable" | "no-preview", "commit", "changelog": [...], "summary", "suggestion", "branch", "pullRequestUrl"}`.
- **The page:** the agent leaves it at `<checkout>/.mystical/design-build/<requestId>.html`.
- **File:** `PUT /plugin/design-build-requests/<id>/file`, the page as the raw body, `Content-Type: text/html; charset=utf-8`, at most 25 MB. Answers 204.
- **Result:** `POST /plugin/design-build-requests/<id>/result` with `{status, result | error, model}`, as every kind (`_post_result`).

## Decisions

- **A run like a conflicts job.** The same queue, ack and refuse handshake, and accept gate (auto-accepted when idle, else held with the Approve/Dismiss ask, "Rivendell design build queued — owner/repo"). The same run: `_start_run` in the repository's checkout, tools on, an implementation's clock (`impl_timeout`, 3 h), tracked as `design-build`. `build` and `setup` mode differ only in Rivendell's prompt; the bridge runs both alike.
- **The bridge sends the page, not the agent.** The file route is the bridge's own (its token, as device runs hand back screenshots), and Rivendell makes the version from the result, which it refuses for `built` without a file. So after the run the bridge reads that one file, `PUT`s it with `_api_put_bytes`, and only then posts the result.
- **What each outcome does** (the answer is read by `_design_report`, as `_conflict_report` reads a conflict's):
  - `built`: the page goes up, then the answer is posted COMPLETED.
  - `unsuitable` (the repository has no web interface to show) and `no-preview` (a web app with no single-file preview build; the answer carries a suggestion): posted as they are, COMPLETED, no file. Rivendell shows the summary or the suggestion on the design.
  - Any other answer, or none: posted as it is. Rivendell judges it ("not a build report" is FAILED there); the bridge only carries the file.
  - A run that failed or timed out: its error, FAILED, no file. A page left by an earlier try is never read.
- **The page is read the way `device_side._upload` reads a screenshot** (`_built_file`): opened with `O_NOFOLLOW`, without waiting on a pipe, and judged on the open file (regular, at most 25 MB) before a byte is read. When it can't go up, the reason is the job's error.
- **The design is kept for the done ping.** `Worker._designs` holds each request's `{title, url}` from its frame (nested `design`) or its catch-up row (flat), in memory like `_conflicts`.
- **The done ping says what the build came to.** "Design built", "No preview build" or "Not suitable", with the design's title and a line of the report, over "Open design ↗", the design's page (`_design_message`). An answer with no report, and a run that failed, keep the generic done message.
- **The bell reads BUILT only for a design that was built.** For any other answer to a run that finished, the note carries no job kind, so it reads DONE; its body is the report's summary, not the JSON's first line. A run that failed keeps its kind and reads FAILED, its body what any failed job's is (its outcome's label, else the first line of what it said), even when that text happens to be a report.
- **The session's facts** (the design's title, its repository and its page) come from the frame, the catch-up row or the claim (`rivendell_jobs.facts`); an older session's are read back from the prompt's fixed lines (`classify`).
- **The session's title** is "<design> · design build" (`rivendell_jobs.title`); without the design's title it is left to the titler.

## What it refuses

- **No checkout of the repository:** not taken. It is refused `no-checkout` when queued (Rivendell then asks the requester whether another bridge may run it) and the bell says so ("Design build · owner/repo"). If the checkout is gone by the claim, the job is FAILED `no local checkout for 'owner/repo' under <BASE_PATH>`. It never runs in another folder: a run that installs and builds must not land in an unrelated directory.
- **No page where the prompt said to leave it,** or anything there but a regular file (a symlink, which could point anywhere on the machine; a folder; a pipe): FAILED `no built page at .mystical/design-build/<id>.html`.
- **A page over 25 MB:** FAILED `the built page is <n> MB, over 25 MB`. Nothing is sent; Rivendell would answer 400.
- **A page that does not upload** (network, a 400): FAILED `the built page did not upload: <error>`. The transcript stays in the dashboard.
- **A claim answered 409** (another bridge's): nothing runs and nothing is posted, as for every kind.

## Not built

- A retry of the upload. It is one `PUT`; a failed one fails the job and the owner presses Build version again.
- Removing the page from the checkout once it is up. It stays in the git-ignored `.mystical/design-build/`.
- Checking the page's contents (one HTML file, nothing linked beside it). The prompt tells the agent what the page must be, and Rivendell checks what it takes.
- The DESIGN word in the dashboard and Mini App. It comes with the rest of this branch; Rivendell's spec, section Mystical, has the wording.
